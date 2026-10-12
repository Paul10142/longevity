/**
 * Subscription usage-limit awareness for the `claude-code` backend.
 *
 * Why this exists. On 2026-10-12 the CLI began answering every call with
 * "You've hit your session limit · resets 12:40am (America/Detroit)". The
 * supervisor did not know what that meant: for the next ~66 minutes it kept
 * running a round every ~2.5 minutes, 10,744 failed CLI calls in all, and
 * 194 job failures (each one burning a retry attempt) before the window
 * reopened by itself. No data was damaged, but the calls were pure waste and
 * every one of them also counted against the same usage pool Paul's own
 * sessions draw on.
 *
 * Two defences, both here:
 *   1. REACTIVE — recognise the "hit your session limit … resets <time> (<tz>)"
 *      message, work out the reset instant, and stop calling until then.
 *   2. PROACTIVE — every CLI call in `--output-format stream-json` carries a
 *      `rate_limit_event` with the five-hour window's utilization (0–1) and its
 *      reset time. Pause slightly BEFORE the window is full (default 92%), so no
 *      call fails, no job is interrupted mid-way, and Paul keeps headroom.
 *
 * Everything below is pure (no I/O) apart from the module-level `usageState`,
 * so the parsing is unit-testable with the real message text.
 */

/** Pause when the five-hour window is at least this full. Env: USAGE_PAUSE_AT. */
export const DEFAULT_PAUSE_AT = 0.92
/** Wake this long AFTER the stated reset, so the first call lands inside the new window. */
export const RESET_MARGIN_MS = 90_000
/** One sleep never exceeds this; a 5-hour window cannot need more. */
export const MAX_PAUSE_MS = 6 * 3_600_000
/** Used when the limit message names no parseable reset time. */
export const UNKNOWN_RESET_PAUSE_MS = 30 * 60_000

export type UsageLimitKind = 'reached' | 'approaching'

/**
 * Thrown by the CLI wrapper instead of an ordinary failure when the
 * subscription window is full (or nearly). The worker defers the job without
 * spending an attempt; the supervisor sleeps until `resetAt`.
 */
export class UsageLimitError extends Error {
  readonly kind: UsageLimitKind
  /** Epoch ms at which the window reopens, or null when unknown. */
  readonly resetAt: number | null
  /** Five-hour utilization (0–1) when known. */
  readonly utilization: number | null

  constructor(kind: UsageLimitKind, resetAt: number | null, utilization: number | null = null, detail = '') {
    super(
      kind === 'reached'
        ? `usage limit reached${resetAt ? `, resets ${new Date(resetAt).toISOString()}` : ''}${detail ? ` — ${detail}` : ''}`
        : `usage window ${Math.round((utilization ?? 0) * 100)}% full, pausing before the limit` +
            `${resetAt ? ` until ${new Date(resetAt).toISOString()}` : ''}`
    )
    this.name = 'UsageLimitError'
    this.kind = kind
    this.resetAt = resetAt
    this.utilization = utilization
  }
}

/** Call from a `catch` that would otherwise swallow or retry an LLM failure. */
export function rethrowIfUsageLimit(err: unknown): void {
  if (err instanceof UsageLimitError) throw err
}

// ---------------------------------------------------------------------------
// Parsing the "hit your limit" message
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// "You've hit your session limit · resets 12:40am (America/Detroit)". The
// apostrophe may be straight or curly; weekly/Opus variants say "weekly limit"
// or "Opus limit" and may add a date ("resets Oct 15, 9am (…)").
const LIMIT_PHRASE = /hit your (?:[\w-]+ ){0,2}limit/i
const RESETS =
  /resets?\s+(?:(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?/i

/** True when `text` is the CLI's "you hit your limit" message. */
export function isUsageLimitMessage(text: string): boolean {
  return LIMIT_PHRASE.test(text)
}

/** Offset (ms) of `tz` from UTC at the instant `epochMs`: local wall time − UTC. */
function tzOffsetMs(epochMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  })
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** The epoch ms at which the wall clock in `tz` reads y-m-d h:mi (DST-safe). */
function zonedWallToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const t1 = guess - tzOffsetMs(guess, tz)
  return guess - tzOffsetMs(t1, tz)
}

function validTz(tz: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!tz) return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() })
    return tz.trim()
  } catch {
    return fallback
  }
}

/**
 * Parse "… resets 12:40am (America/Detroit)" into the next such instant after
 * `nowMs`. Handles 12-hour clocks (12am = midnight, 12pm = noon), the named
 * timezone, a following-day rollover when the stated time already passed today,
 * and an optional "Oct 15," date. Returns null when `text` is not a limit
 * message; `resetAt: null` when it is but names no time.
 */
export function parseUsageLimit(text: string, nowMs: number = Date.now()): { resetAt: number | null } | null {
  if (!isUsageLimitMessage(text)) return null
  const m = RESETS.exec(text)
  if (!m) return { resetAt: null }

  const [, monName, dayStr, hourStr, minStr, ampm, tzRaw] = m
  const tz = validTz(tzRaw)
  let hour = Number(hourStr) % 12
  if (ampm.toLowerCase() === 'p') hour += 12
  const minute = minStr ? Number(minStr) : 0
  if (Number(hourStr) < 1 || Number(hourStr) > 12 || minute > 59) return { resetAt: null }

  // "Today" in the target timezone.
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
  const today: Record<string, number> = {}
  for (const part of dayFmt.formatToParts(new Date(nowMs))) {
    if (part.type !== 'literal') today[part.type] = Number(part.value)
  }

  const mon = monName ? MONTHS.indexOf(monName.slice(0, 3).toLowerCase()) : -1
  if (monName && mon >= 0 && dayStr) {
    let candidate = zonedWallToEpoch(today.year, mon + 1, Number(dayStr), hour, minute, tz)
    // A dated reset that already passed more than a day ago belongs to next year.
    if (candidate < nowMs - 86_400_000) candidate = zonedWallToEpoch(today.year + 1, mon + 1, Number(dayStr), hour, minute, tz)
    return { resetAt: candidate }
  }

  let candidate = zonedWallToEpoch(today.year, today.month, today.day, hour, minute, tz)
  // Date.UTC rolls month/year over, so "tomorrow" is just day + 1.
  if (candidate <= nowMs) candidate = zonedWallToEpoch(today.year, today.month, today.day + 1, hour, minute, tz)
  return { resetAt: candidate }
}

/** Build the error for a message already known to be the limit message. */
export function usageLimitErrorFromMessage(text: string, nowMs: number = Date.now()): UsageLimitError | null {
  const parsed = parseUsageLimit(text, nowMs)
  if (!parsed) return null
  return new UsageLimitError('reached', parsed.resetAt, null, text.trim().slice(0, 120))
}

/** Map any thrown value to a UsageLimitError when it is (or wraps) the limit message. */
export function asUsageLimit(err: unknown, nowMs: number = Date.now()): UsageLimitError | null {
  if (err instanceof UsageLimitError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return usageLimitErrorFromMessage(msg, nowMs)
}

// ---------------------------------------------------------------------------
// Reading the CLI's stream-json output
// ---------------------------------------------------------------------------

export type RateLimitSnapshot = {
  status: string
  /** Five-hour window: utilization 0–1 and reset (epoch ms), when reported. */
  fiveHour: { utilization: number | null; resetsAt: number | null } | null
  sevenDay: { utilization: number | null; resetsAt: number | null } | null
  /** The event's own reset time for the limiting window (epoch ms). */
  resetsAt: number | null
}

export type CliStream = {
  /** The model's reply text (the `result` event), or null when there was none. */
  text: string | null
  isError: boolean
  rateLimit: RateLimitSnapshot | null
  /** How many JSON events were read. 0 means the output was not stream-json at all. */
  events: number
}

const asFraction = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v > 1 ? v / 100 : v // tolerate a 0–100 percentage
}
const asMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : null)

function windowOf(w: unknown): { utilization: number | null; resetsAt: number | null } | null {
  if (!w || typeof w !== 'object') return null
  const o = w as Record<string, unknown>
  return { utilization: asFraction(o.utilization), resetsAt: asMs(o.resetsAt) }
}

/**
 * Parse `claude -p --output-format stream-json --verbose` stdout (one JSON
 * object per line). Tolerant by design: unparseable lines are skipped, and a
 * stream with no `result` event yields `text: null` so the caller can decide.
 */
export function parseCliStream(stdout: string): CliStream {
  let text: string | null = null
  let isError = false
  let rateLimit: RateLimitSnapshot | null = null
  let events = 0
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(s)
    } catch {
      continue
    }
    if (typeof ev.type !== 'string') continue
    events++
    if (ev.type === 'result') {
      if (typeof ev.result === 'string') text = ev.result
      isError = ev.is_error === true
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && typeof ev.rate_limit_info === 'object') {
      const info = ev.rate_limit_info as Record<string, unknown>
      const uw = (info.unifiedWindows ?? {}) as Record<string, unknown>
      rateLimit = {
        status: typeof info.status === 'string' ? info.status : 'unknown',
        fiveHour: windowOf(uw.five_hour),
        sevenDay: windowOf(uw.seven_day),
        resetsAt: asMs(info.resetsAt),
      }
    }
  }
  return { text, isError, rateLimit, events }
}

// ---------------------------------------------------------------------------
// Process-wide state + the gate in front of every CLI call
// ---------------------------------------------------------------------------

export const usageState: {
  snapshot: RateLimitSnapshot | null
  snapshotAt: number
  /** Epoch ms until which the limit is known to be hit (reactive). 0 = not blocked. */
  blockedUntil: number
} = { snapshot: null, snapshotAt: 0, blockedUntil: 0 }

export function resetUsageState(): void {
  usageState.snapshot = null
  usageState.snapshotAt = 0
  usageState.blockedUntil = 0
}

/** Record what the latest CLI call reported. */
export function noteRateLimit(snap: RateLimitSnapshot | null, nowMs: number = Date.now()): void {
  if (!snap) return
  usageState.snapshot = snap
  usageState.snapshotAt = nowMs
}

/** Record that the limit message was just seen, so later calls do not even spawn. */
export function noteLimitReached(err: UsageLimitError, nowMs: number = Date.now()): void {
  const until = err.resetAt ?? nowMs + UNKNOWN_RESET_PAUSE_MS
  usageState.blockedUntil = Math.max(usageState.blockedUntil, until)
}

export function pauseThreshold(): number {
  const v = Number(process.env.USAGE_PAUSE_AT)
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_PAUSE_AT
}

/**
 * Should the next CLI call be refused? Returns the error to throw, or null.
 * Pure given `usageState`, `nowMs` and the threshold.
 */
export function usageGate(nowMs: number = Date.now(), threshold: number = pauseThreshold()): UsageLimitError | null {
  if (usageState.blockedUntil > nowMs) {
    return new UsageLimitError('reached', usageState.blockedUntil, null, 'still inside the limit window')
  }
  const snap = usageState.snapshot
  if (!snap) return null
  const w = snap.fiveHour
  const resetAt = w?.resetsAt ?? snap.resetsAt
  // A reset time in the past means the window has rolled over; the snapshot is stale.
  if (!resetAt || resetAt <= nowMs) return null
  if (snap.status === 'rejected') return new UsageLimitError('reached', resetAt, w?.utilization ?? 1)
  if (w?.utilization != null && w.utilization >= threshold) {
    return new UsageLimitError('approaching', resetAt, w.utilization)
  }
  return null
}

// ---------------------------------------------------------------------------
// The supervisor's decision: how long to sleep
// ---------------------------------------------------------------------------

export type PausePlan = {
  /** Milliseconds to sleep (0 when `beyondDeadline`). */
  sleepMs: number
  /** Epoch ms the sleep ends at. */
  wakeAt: number
  /** The window reopens after the run's deadline: stop instead of sleeping. */
  beyondDeadline: boolean
}

/**
 * Sleep until just after `resetAt` (+90 s), never more than 6 h, and never
 * past the run's `deadline`. A reset beyond the deadline (a weekly limit) ends
 * the run rather than idling to it.
 */
export function planPause(resetAt: number | null, nowMs: number, deadlineMs: number): PausePlan {
  const target = resetAt ? resetAt + RESET_MARGIN_MS : nowMs + UNKNOWN_RESET_PAUSE_MS
  if (target > deadlineMs) return { sleepMs: 0, wakeAt: deadlineMs, beyondDeadline: true }
  const wake = Math.min(target, nowMs + MAX_PAUSE_MS)
  return { sleepMs: Math.max(0, wake - nowMs), wakeAt: wake, beyondDeadline: false }
}

// ---------------------------------------------------------------------------
// Jobs that can never succeed
// ---------------------------------------------------------------------------

/**
 * The model's safety filter refusing a passage ("Opus 5's safeguards flagged
 * this message"). Deterministic for that input, so retrying cannot help.
 */
export function isRefusalError(message: string | null | undefined): boolean {
  return !!message && /safeguards flagged|flagged this message|declined \(safety filter\)|usage policy|legal\/aup/i.test(message)
}

/** A job healed this many times in one run and still failing is not a blip. */
export const MAX_HEALS_PER_JOB = 3

/**
 * Should the supervisor leave this `failed` job alone? Returns the reason, or
 * null to heal (re-queue) it. `healsSoFar` counts earlier heals of this job in
 * the current run.
 */
export function quarantineReason(error: string | null | undefined, healsSoFar: number): string | null {
  if (isRefusalError(error)) return "refused by the model's safety filter"
  if (healsSoFar >= MAX_HEALS_PER_JOB) return `still failing after ${MAX_HEALS_PER_JOB} retries`
  return null
}
