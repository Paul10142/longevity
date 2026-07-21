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

// Judgment tier: dedup adjudication, topic assignment, article generation.
export const CLAUDE_JUDGMENT_MODEL = 'claude-opus-4-8'
// Bulk tier: per-chunk insight and reference extraction.
export const CLAUDE_BULK_MODEL = 'claude-haiku-4-5'
// Synthesis default (kept under the original name — long-form clinical writing).
export const CLAUDE_MODEL = CLAUDE_JUDGMENT_MODEL

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

/** Run a prompt through the local `claude` CLI on the developer's subscription. */
function claudeCodeText(system: string, user: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--model', cliAlias(model), '--append-system-prompt', system],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude CLI failed (${model}): ${stderr || err.message}`))
          return
        }
        resolve(stdout)
      }
    )
    child.stdin?.end(user)
  })
}

/** Call the Anthropic API and return the concatenated text blocks. */
async function apiText(
  system: string,
  user: string,
  maxTokens: number,
  model: string
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
  model: string = CLAUDE_MODEL
): Promise<T> {
  const text =
    backend() === 'claude-code'
      ? await claudeCodeText(system, user, model)
      : await apiText(system, user, maxTokens, model)

  if (!text.trim()) throw new Error(`Empty Claude response (${model})`)
  return JSON.parse(extractJson(text)) as T
}
