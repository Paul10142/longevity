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
 *   - JUDGMENT  (Opus 5.5)  — dedup adjudication, topic assignment, synthesis.
 *
 * Both backends request the exact model id below. The CLI used to get a short
 * alias (`opus`), which resolves to whatever the CLI currently treats as Opus —
 * the refusals in the 2026-10-12 overnight log name Opus 5, not the model this
 * file named. Paul pinned the judge to Opus 5.5 that day.
 *
 * Two backends, chosen with `LLM_BACKEND`:
 *   - `api`         (default) — ANTHROPIC_API_KEY, used by the deployed worker.
 *   - `claude-code`           — shells out to the local `claude` CLI, which
 *                               bills the developer's Claude subscription
 *                               rather than API credits. See `npm run pipeline`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'node:child_process'
import { createLimiter, envLimit } from './concurrency'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UsageLimitError,
  isMcpConfigError,
  PipelineHaltError,
  parseCliStream,
  parseUsageLimit,
  noteRateLimit,
  noteLimitReached,
  usageGate,
} from './usageLimit'

/**
 * Per-process CLI call statistics. The 2026-08-27/28 run crawled for 16 hours
 * and left no record of whether the CLI was failing, slow, or rate-limited —
 * the jobs table keeps only the last error. The supervisors print these every
 * round so the next stall is diagnosable from the log.
 */
export const cliStats = { calls: 0, failures: 0, wallMs: 0, lastError: '', lastErrorAt: '' }

/**
 * Process-wide ceiling on `claude -p` children alive at once (CLI_MAX_INFLIGHT, default 16 = the
 * old EXTRACT_CONCURRENCY of one job). Extraction fans one job out to 16 calls; with several
 * workers in one process (scripts/extractDeepgram.ts --workers N) this cap, not the job count, is
 * what bounds local CPU/RAM and the burst against the plan's rate limits. Calls beyond it wait for
 * a slot BEFORE the circuit-breaker and usage-gate checks run, so a call that waited does not
 * spawn into a window that closed while it queued.
 */
export const cliLimiter = createLimiter(envLimit('CLI_MAX_INFLIGHT', 16))

export function formatCliStats(): string {
  const { calls, failures, wallMs, lastError, lastErrorAt } = cliStats
  const mean = calls ? (wallMs / calls / 1000).toFixed(1) : '0.0'
  const tail = failures ? ` — last failure ${lastErrorAt}: ${lastError.slice(0, 120)}` : ''
  return `cli: ${calls} call(s), ${failures} failed, mean ${mean}s, peak ${cliLimiter.peak}/${cliLimiter.max} in flight${tail}`
}

/**
 * An MCP config that names no servers. Passed with --strict-mcp-config so the
 * spawned CLI connects to nothing, whatever the user's own ~/.claude.json lists.
 *
 * Re-checked on EVERY call, never cached. It used to be written once to tmpdir()
 * and the path remembered; at ~03:36 on 2026-10-19 macOS purged that file in the
 * middle of an overnight run and all 6,804 calls over the next 4 hours died with
 * "Invalid MCP configuration: MCP config file not found". A purge-proof home
 * (~/.cache) plus a cheap existsSync that rewrites the file when missing means
 * a deleted file costs nothing. The file NAME is unchanged: the usage guard
 * matches "lifestyle-academy-empty-mcp" on the command line (~/.claude/usage-guard).
 * `LA_EMPTY_MCP_DIR` overrides the folder (tests).
 */
export const EMPTY_MCP_FILE = 'lifestyle-academy-empty-mcp.json'
const EMPTY_MCP_BODY = '{"mcpServers":{}}'

export function emptyMcpConfig(): string {
  const dirs = [
    process.env.LA_EMPTY_MCP_DIR,
    join(homedir(), '.cache', 'lifestyle-academy'),
    tmpdir(),
  ].filter((d): d is string => !!d)
  let lastErr: unknown
  for (const dir of dirs) {
    const p = join(dir, EMPTY_MCP_FILE)
    try {
      if (existsSync(p)) return p
      mkdirSync(dir, { recursive: true })
      // Write then rename so a CLI starting at the same moment never reads half a file.
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, EMPTY_MCP_BODY)
      renameSync(tmp, p)
      return p
    } catch (e) {
      lastErr = e // unwritable folder: try the next one
    }
  }
  throw new Error(`cannot write the empty MCP config: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

/**
 * Call-level circuit breaker. A run used to learn that the CLI was broken only at the end
 * of a round (2026-10-19: 6,804 failed calls in 4 h). Now the Nth consecutive failed call,
 * counted in COMPLETION order across up to 16 concurrent calls, throws PipelineHaltError.
 * Success resets the count. Not counted: a usage/rate limit (the usage pause handles it)
 * and a safety-filter refusal (about one passage; quarantine handles it). Once tripped it
 * stays tripped for the life of the process: later calls fail at once with the same error.
 * Callbacks run one at a time on the event loop, so the counter needs no lock.
 */
export const CLI_FAILURES_TO_HALT = 5
export const cliCircuit: { consecutive: number; halted: PipelineHaltError | null } = { consecutive: 0, halted: null }

export function resetCliCircuit(): void {
  cliCircuit.consecutive = 0
  cliCircuit.halted = null
}

function noteCliSuccess(): void {
  if (!cliCircuit.halted) cliCircuit.consecutive = 0
}

/** Count a failed call; returns the halt error once the breaker is open (calls still in flight then fail with it too). */
function noteCliFailure(detail: string): PipelineHaltError | null {
  cliCircuit.consecutive++
  if (!cliCircuit.halted && cliCircuit.consecutive >= CLI_FAILURES_TO_HALT) {
    cliCircuit.halted = new PipelineHaltError(cliCircuit.consecutive, detail)
  }
  return cliCircuit.halted
}

// Judgment tier: dedup adjudication, topic assignment, article generation.
export const CLAUDE_JUDGMENT_MODEL = 'claude-opus-5-5'
// Bulk tier: per-chunk insight and reference extraction.
export const CLAUDE_BULK_MODEL = 'claude-haiku-4-5'
// Synthesis default (kept under the original name — long-form clinical writing).
export const CLAUDE_MODEL = CLAUDE_JUDGMENT_MODEL

/** Reasoning depth for adaptive thinking. Unset = the API default (`high` on
 *  most models; `medium` on Opus 5.5). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Adaptive thinking and `output_config.effort` exist on Opus 4.6+, Opus 5.x,
 *  Sonnet 5.x and Haiku 5.x; Haiku 4.5 rejects both. Gate them on the model —
 *  until 2026-10-12 this matched only `claude-opus-4-`, so moving the judge to
 *  Opus 5.5 would have silently dropped every caller's effort cap on the API path. */
function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus-(4-[6-9]|5)|sonnet-5|haiku-5|fable-)/.test(model)
}

/**
 * The model's safety filter declined the request. Not a transport failure:
 * asking again sends the same text to the same filter, so callers must not
 * retry it. The CLI reports it on stdout ("Opus 5's safeguards flagged this
 * message …", exit 1); the API returns HTTP 200 with `stop_reason: "refusal"`.
 * The filter is broad ("can sometimes flag legitimate biology tasks", in its
 * own words): one dedup pair failed consolidate job 652e4ec4 on every retry
 * through the night of 2026-10-12.
 */
export class ModelRefusalError extends Error {
  constructor(model: string, detail: string) {
    super(`${model} declined (safety filter): ${detail.slice(0, 200)}`)
    this.name = 'ModelRefusalError'
  }
}

const CLI_REFUSAL = /safeguards flagged this message|violates? our Usage Policy/i

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
async function claudeCodeText(
  system: string,
  user: string,
  model: string,
  effort?: Effort,
  noThinking = false
): Promise<string> {
  const release = await cliLimiter.acquire()
  try {
    return await spawnClaudeCli(system, user, model, effort, noThinking)
  } finally {
    release()
  }
}

function spawnClaudeCli(
  system: string,
  user: string,
  model: string,
  effort?: Effort,
  noThinking = false
): Promise<string> {
  // The CLI must bill the claude.ai login, never the API key. `.env.local`
  // carries ANTHROPIC_API_KEY for the `api` backend, and a spawned CLI that sees
  // it switches to API-key auth ("takes precedence over your claude.ai login").
  // Measured 2026-10-11: with the key in the child's env every call died with
  // "Credit balance is too low"; the identical call without it succeeded on the
  // subscription. The nested-session markers are dropped for the same reason a
  // pipeline launched from inside a Claude Code session must still spawn.
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  // The CLI lets Haiku 4.5 think before answering by default, which more than doubles a short
  // mechanical call (measured 2026-10-12: 6-7 s -> 3 s on an enrich-merge rewrite). A caller that
  // knows its task needs no reasoning opts out; the API backend never thinks on Haiku 4.5.
  if (noThinking) env.MAX_THINKING_TOKENS = '0'

  // The breaker is open: every call since it tripped would fail the same way.
  if (cliCircuit.halted) return Promise.reject(cliCircuit.halted)

  // Pause BEFORE the subscription window is full (or while it is known to be),
  // instead of spawning a call that will fail. Nothing is spawned or counted:
  // the worker defers the job without spending an attempt and the supervisor
  // sleeps until the window reopens (lib/usageLimit.ts).
  const gate = usageGate()
  if (gate) return Promise.reject(gate)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    cliStats.calls++
    const child = execFile(
      'claude',
      [
        '-p',
        // The exact id, never an alias: `opus` resolves to whatever the CLI calls
        // Opus today (see the header). Verified 2026-10-12 that the CLI accepts
        // `claude-opus-5-5` and `claude-haiku-4-5` and reports them back as such.
        '--model', model,
        ...(effort ? ['--effort', effort] : []),
        // A BARE session, on purpose. Without these four flags every call loads
        // the developer's whole Claude Code setup: every MCP server, every
        // session-start hook (which make network calls), every plugin, every
        // built-in tool definition, and the user-level instructions. Measured
        // 2026-10-11 on the production dedup prompt with five candidates:
        //
        //   default           52,000 context tokens   8.6 s wall / 5.3 s API
        //   no MCP/settings   17,000                  3.0 s / 2.1 s
        //   + no tools         4,000                  3.3 s / 2.2 s   (same verdict)
        //
        // The prompt itself is ~1,100 tokens. The overhead was charged against the
        // subscription's usage windows on all ~45,000 adjudications to date, which
        // is the real reason overnight runs kept stalling on usage limits.
        '--strict-mcp-config', '--mcp-config', emptyMcpConfig(),
        '--setting-sources', '',
        '--tools', '',
        // Print-mode calls were also persisting a session transcript each:
        // 17,725 files / 1.6 GB under ~/.claude/projects for the tmpdir cwd.
        '--no-session-persistence',
        // stream-json (with --verbose) is the only output format that carries the
        // `rate_limit_event` — the five-hour window's utilization and reset time —
        // which is what lets the supervisor pause before the limit rather than
        // after it. The reply text is the final `result` event.
        '--output-format', 'stream-json', '--verbose',
        '--append-system-prompt', system,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600_000, cwd: tmpdir(), env },
      (err, rawStdout, stderr) => {
        cliStats.wallMs += Date.now() - startedAt
        const stream = parseCliStream(rawStdout ?? '')
        noteRateLimit(stream.rateLimit)
        // On a failed call the readable reason is the `result` event's text (the
        // raw stdout is now a wall of JSON lines).
        // Not stream-json at all (an old CLI, a test double): the raw output IS the reply.
        const legacy = stream.events === 0
        const stdout = legacy ? rawStdout : (stream.text ?? '')
        if (err || stream.isError) {
          cliStats.failures++
          cliStats.lastErrorAt = new Date().toISOString()
          // NEVER surface err.message: execFile sets it to
          //   `Command failed: claude -p --model opus --append-system-prompt <ENTIRE SYSTEM PROMPT>`
          // — the full argv, i.e. our whole system prompt. That leaked into
          // merge_reviews.model_reasoning as a wall of text on every failed merge
          // card (2026-07-25). Build a short, argv-free reason from the fields
          // that actually describe the failure (stderr / timeout / signal / code).
          const e = (err ?? {}) as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          // The CLI prints advisory lines on stderr that are not the failure
          // (e.g. the "claude.ai connectors are disabled because ANTHROPIC_API_KEY
          // …" notice). Keep only stderr lines that are not such notices, so the
          // reason that actually ended the call — usually on stdout — survives.
          const stderrSignal = (stderr ?? '')
            .split('\n')
            .filter(l => l.trim() && !/^⚠/.test(l.trim()))
            .join(' ')
            .trim()
          const detail =
            (stderrSignal && stderrSignal.slice(0, 300)) ||
            // An expired login prints its reason to STDOUT and exits 1, so
            // without this every failure read as a bare "exit 1" (2026-10-03).
            (stdout && stdout.trim().slice(0, 300)) ||
            (e.killed ? 'timed out' : '') ||
            (e.signal ? `signal ${e.signal}` : '') ||
            (e.code != null ? `exit ${e.code}` : '') ||
            'unknown error'
          cliStats.lastError = detail
          // The CLI could not find the empty MCP config (macOS purge, a cleanup job):
          // rewrite it now so the next call works. It still counts toward the circuit
          // breaker below, which stops the run if it keeps happening.
          if (isMcpConfigError(`${detail}\n${stdout ?? ''}`)) {
            try { emptyMcpConfig() } catch { /* reported by the next call */ }
          }
          if (CLI_REFUSAL.test(`${stdout ?? ''}\n${stderr ?? ''}`)) {
            reject(new ModelRefusalError(model, detail))
            return
          }
          // "You've hit your session limit · resets 12:40am (America/Detroit)" is
          // not a failed call to retry: tell the caller to stop until it resets.
          const limit = parseUsageLimit(`${detail}\n${stdout ?? ''}\n${stderrSignal}`)
          if (limit) {
            const limitErr = new UsageLimitError('reached', limit.resetAt, null, detail.slice(0, 120))
            noteLimitReached(limitErr)
            reject(limitErr)
            return
          }
          // Anything else is a call that failed for a reason that is not about the
          // passage or the plan: count it toward the circuit breaker.
          reject(noteCliFailure(detail) ?? new Error(`claude CLI failed (${model}): ${detail}`))
          return
        }
        if (legacy) {
          noteCliSuccess()
          resolve(rawStdout)
          return
        }
        if (stream.text === null) {
          cliStats.failures++
          cliStats.lastErrorAt = new Date().toISOString()
          cliStats.lastError = 'no result event in CLI output'
          reject(noteCliFailure('no result event in CLI output') ?? new Error(`claude CLI failed (${model}): no result event in CLI output`))
          return
        }
        noteCliSuccess()
        resolve(stream.text)
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
      reject(new Error(`claude CLI stdin failed (${model}): ${err.code ?? err.message}`))
    })
    // Likewise a spawn failure (binary missing, fork limit) arrives as an event.
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(`claude CLI could not run (${model}): ${err.code ?? err.message}`))
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

  const msg = (await getAnthropic().messages.create(params as never)) as Anthropic.Message
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details
    throw new ModelRefusalError(model, [d?.category, d?.explanation].filter(Boolean).join(': ') || 'refusal')
  }
  return msg.content
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
  effort?: Effort,
  opts: { noThinking?: boolean } = {}
): Promise<T> {
  const text = await claudeText(system, user, maxTokens, model, effort, opts.noThinking)
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
  effort?: Effort,
  noThinking = false
): Promise<string> {
  if (backend() !== 'claude-code') {
    return apiText(system, user, maxTokens, model, effort)
  }
  try {
    return await claudeCodeText(system, user, model, effort, noThinking)
  } catch (cliErr) {
    // The API runs the same model behind the same filter, so a refusal would
    // only be refused again, on credit.
    if (cliErr instanceof ModelRefusalError) throw cliErr
    // A full (or nearly full) subscription window is a reason to WAIT, not to
    // spend API credit: never fall back for it.
    if (cliErr instanceof UsageLimitError) throw cliErr
    // The breaker tripped: the CLI is broken for good, so stop rather than paper over it with API spend.
    if (cliErr instanceof PipelineHaltError) throw cliErr
    const fallbackEnabled = process.env.LLM_FALLBACK_TO_API === '1' && !!process.env.ANTHROPIC_API_KEY
    if (!fallbackEnabled) throw cliErr
    console.warn(
      `[llm] claude-code CLI failed (${model}); falling back to api backend: ` +
        `${cliErr instanceof Error ? cliErr.message : String(cliErr)}`
    )
    return apiText(system, user, maxTokens, model, effort)
  }
}
