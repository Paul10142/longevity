/**
 * LLM provider helpers.
 *
 * Every generative call in the pipeline goes through `claudeJson`. Embeddings
 * are the one exception and stay on OpenAI (`lib/embeddings.ts`) — Anthropic
 * ships no embeddings model, and `match_claims` / `match_topics` need vectors.
 *
 * Two model tiers:
 *   - BULK      (Haiku 4.5) — high-volume mechanical extraction, one call per
 *                             transcript chunk.
 *   - JUDGMENT  (Opus 4.8)  — dedup adjudication, topic assignment, synthesis.
 *
 * Two backends, chosen with `LLM_BACKEND`:
 *   - `api`         (default) — ANTHROPIC_API_KEY, used by the deployed worker.
 *   - `claude-code`           — shells out to the local `claude` CLI, which
 *                               bills the developer's Claude subscription
 *                               rather than API credits. See `npm run pipeline`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'

// Judgment tier: dedup adjudication, topic assignment, article generation.
export const CLAUDE_JUDGMENT_MODEL = 'claude-opus-4-8'
// Bulk tier: per-chunk insight and reference extraction.
export const CLAUDE_BULK_MODEL = 'claude-haiku-4-5'
// Synthesis default (kept under the original name — long-form clinical writing).
export const CLAUDE_MODEL = CLAUDE_JUDGMENT_MODEL

/** Reasoning depth for adaptive thinking. Unset = the API default (`high`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Adaptive thinking is an Opus-4.x feature; Haiku 4.5 rejects it, and it also
 *  rejects `output_config.effort`. Gate both on the model. */
function supportsAdaptiveThinking(model: string): boolean {
  return model.startsWith('claude-opus-4-') || model.startsWith('claude-sonnet-5')
}

/** CLI model aliases. The `claude` CLI takes short names, not full model ids. */
function cliAlias(model: string): string {
  if (model.startsWith('claude-haiku')) return 'haiku'
  if (model.startsWith('claude-sonnet')) return 'sonnet'
  return 'opus'
}

type Backend = 'api' | 'claude-code'
function backend(): Backend {
  return process.env.LLM_BACKEND === 'claude-code' ? 'claude-code' : 'api'
}

let client: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY')
    client = new Anthropic({ apiKey })
  }
  return client
}

/** Pull the first JSON object out of a model response (tolerates ``` fences
 * and stray prose around the JSON). */
function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

/** Run a prompt through the local `claude` CLI on the developer's subscription.
 *  The CLI takes `--effort`, so subscription runs cap reasoning the same way
 *  API runs do.
 *
 *  **Runs from a neutral directory on purpose.** The CLI discovers `CLAUDE.md`
 *  by walking up from its working directory, so invoking it inside this repo
 *  loaded THIS PROJECT'S agent instructions into every pipeline call. The model
 *  then answered as a project assistant instead of an extractor — a real 2026-07-24
 *  failure, where transcript chunks that open conversationally ("Hey everyone,
 *  welcome to the podcast…") came back as *"What would you like me to do with
 *  this podcast transcript? Given the project context (v4 phase 1 is
 *  re-extracting older sources)…"*. `claudeJson` then threw, `extractFromChunk`
 *  retried, gave up, and returned zero insights — 26 chunks of a source
 *  advanced their checkpoint having extracted nothing, silently. This is also
 *  the "CLI intermittently returns prose" that the retry comments blame; the
 *  retries were treating the symptom. `--append-system-prompt` appends, so it
 *  never outranked the project context — only cwd does.
 *
 *  Consequence to respect: the pipeline's prompts must be fully self-contained,
 *  because the CLI now gets no repo context at all. That is the correct posture
 *  for a bulk data-processing call.
 */
function claudeCodeText(
  system: string,
  user: string,
  model: string,
  effort?: Effort
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      [
        '-p',
        '--model', cliAlias(model),
        ...(effort ? ['--effort', effort] : []),
        '--append-system-prompt', system,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600_000, cwd: tmpdir() },
      (err, stdout, stderr) => {
        if (err) {
          // NEVER surface err.message: execFile sets it to
          //   `Command failed: claude -p --model opus --append-system-prompt <ENTIRE SYSTEM PROMPT>`
          // — the full argv, i.e. our whole system prompt. That leaked into
          // merge_reviews.model_reasoning as a wall of text on every failed merge
          // card (2026-07-25). Build a short, argv-free reason from the fields
          // that actually describe the failure (stderr / timeout / signal / code).
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          const detail =
            (stderr && stderr.trim().slice(0, 300)) ||
            (e.killed ? 'timed out' : '') ||
            (e.signal ? `signal ${e.signal}` : '') ||
            (e.code != null ? `exit ${e.code}` : '') ||
            'unknown error'
          reject(new Error(`claude CLI failed (${cliAlias(model)}): ${detail}`))
          return
        }
        resolve(stdout)
      }
    )
    // The prompt goes in on stdin, and the child can be GONE before that write
    // lands — a usage-limit exit, a crash, a kill. Writing to a dead child's
    // stdin emits an 'error' EVENT on the socket, not a thrown exception, so
    // nothing in the async chain can catch it and Node treats an unhandled
    // 'error' as fatal. That is how one dying CLI child took down a whole
    // unattended 9-hour extraction run with `write EPIPE` (2026-08-26).
    //
    // Handling it here turns a process-killing event into an ordinary rejection,
    // which the caller already knows how to retry. EPIPE specifically is not
    // worth reporting on its own: the execFile callback above will reject with
    // the child's real exit reason a moment later, and that is the useful
    // message. Any other stdin error is surfaced.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return
      reject(new Error(`claude CLI stdin failed (${cliAlias(model)}): ${err.code ?? err.message}`))
    })
    // Likewise a spawn failure (binary missing, fork limit) arrives as an event.
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(`claude CLI could not run (${cliAlias(model)}): ${err.code ?? err.message}`))
    })
    child.stdin?.end(user)
  })
}

/** Call the Anthropic API and return the concatenated text blocks. */
async function apiText(
  system: string,
  user: string,
  maxTokens: number,
  model: string,
  effort?: Effort
): Promise<string> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }
  // Let Claude decide when the judgment calls need reasoning; most dedup
  // verdicts are obvious and skip it, so this stays self-regulating.
  if (supportsAdaptiveThinking(model)) {
    params.thinking = { type: 'adaptive' }
    // Effort caps how deep that reasoning goes. It defaults to `high`, which is
    // the right call for adjudication but overkill for mechanical prose work —
    // thinking tokens bill as output ($25/M), so an uncapped synthesis run is
    // mostly paying for invisible reasoning. Callers cap per call site.
    if (effort) params.output_config = { effort }
  }

  const msg = await getAnthropic().messages.create(params as never)
  return (msg as Anthropic.Message).content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/**
 * Ask Claude for a strict-JSON response and parse it. The system prompt is
 * expected to specify the exact JSON shape (as our pipeline prompts do).
 */
export async function claudeJson<T>(
  system: string,
  user: string,
  maxTokens = 8000,
  model: string = CLAUDE_MODEL,
  effort?: Effort
): Promise<T> {
  const text = await claudeText(system, user, maxTokens, model, effort)
  if (!text.trim()) throw new Error(`Empty Claude response (${model})`)
  return JSON.parse(extractJson(text)) as T
}

/**
 * Backend-selecting text call with an optional API fallback.
 *
 * The `claude-code` backend bills a subscription instead of API credits, but the
 * local CLI intermittently exits non-zero mid-batch (subscription usage/rate
 * limits) — a crash that, in consolidation, turned an insight into a singleton +
 * a garbage merge_review instead of a real SAME/DIFFERENT verdict (2026-07-25).
 *
 * When `LLM_FALLBACK_TO_API=1` and an `ANTHROPIC_API_KEY` is set, a CLI failure
 * transparently retries once on the `api` backend so a subscription batch run
 * finishes instead of parking dozens of insights for manual review. It is OFF by
 * default so a plain `npm run pipeline` never spends API credit unexpectedly — the
 * whole point of the subscription backend — and it only ever engages on an actual
 * CLI failure (never for a merely slow call), so the credit spend is bounded by
 * how often the CLI is failing, which is exactly when the rescue is wanted.
 */
async function claudeText(
  system: string,
  user: string,
  maxTokens: number,
  model: string,
  effort?: Effort
): Promise<string> {
  if (backend() !== 'claude-code') {
    return apiText(system, user, maxTokens, model, effort)
  }
  try {
    return await claudeCodeText(system, user, model, effort)
  } catch (cliErr) {
    const fallbackEnabled = process.env.LLM_FALLBACK_TO_API === '1' && !!process.env.ANTHROPIC_API_KEY
    if (!fallbackEnabled) throw cliErr
    console.warn(
      `[llm] claude-code CLI failed (${cliAlias(model)}); falling back to api backend: ` +
        `${cliErr instanceof Error ? cliErr.message : String(cliErr)}`
    )
    return apiText(system, user, maxTokens, model, effort)
  }
}
