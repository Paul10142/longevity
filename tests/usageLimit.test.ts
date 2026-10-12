/**
 * Unit tests for lib/usageLimit.ts — the pause logic behind the extraction
 * supervisor. Pure functions: no CLI, no database, no clock (every function
 * takes `now`).
 *
 * The strings below are copied from the real 2026-10-12 run log and from a real
 * `claude -p --output-format stream-json --verbose` call, not paraphrased.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PAUSE_AT,
  MAX_PAUSE_MS,
  RESET_MARGIN_MS,
  UNKNOWN_RESET_PAUSE_MS,
  UsageLimitError,
  asUsageLimit,
  isRefusalError,
  MAX_HEALS_PER_JOB,
  quarantineReason,
  isUsageLimitMessage,
  noteLimitReached,
  noteRateLimit,
  parseCliStream,
  parseUsageLimit,
  planPause,
  rethrowIfUsageLimit,
  resetUsageState,
  usageGate,
} from '../lib/usageLimit'

const REAL = "You've hit your session limit · resets 12:40am (America/Detroit)"
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString())
const at = (s: string) => Date.parse(s)

beforeEach(() => resetUsageState())

// ── the message ────────────────────────────────────────────────────────────

test('real message: 12:40am Detroit (EDT, UTC-4) is 04:40 UTC — matches the 2026-10-12 log', () => {
  const r = parseUsageLimit(REAL, at('2026-10-12T03:34:11Z'))
  assert.equal(iso(r?.resetAt), '2026-10-12T04:40:00.000Z')
})

test('next-day rollover: the stated time already passed today, so it is tomorrow', () => {
  const r = parseUsageLimit(REAL, at('2026-10-12T05:00:00Z')) // 01:00 in Detroit
  assert.equal(iso(r?.resetAt), '2026-10-13T04:40:00.000Z')
})

test('a reset exactly now rolls to tomorrow (the window has not reopened yet)', () => {
  const r = parseUsageLimit(REAL, at('2026-10-12T04:40:00Z'))
  assert.equal(iso(r?.resetAt), '2026-10-13T04:40:00.000Z')
})

test('12-hour clock edges: 12am is midnight, 12pm is noon', () => {
  const noon = parseUsageLimit('You\'ve hit your session limit · resets 12pm (America/New_York)', at('2026-10-12T10:00:00Z'))
  assert.equal(iso(noon?.resetAt), '2026-10-12T16:00:00.000Z')
  const midnight = parseUsageLimit('You\'ve hit your session limit · resets 12am (America/New_York)', at('2026-10-12T10:00:00Z'))
  assert.equal(iso(midnight?.resetAt), '2026-10-13T04:00:00.000Z')
})

test('pm with minutes, in a zone other than the machine\'s', () => {
  // 00:00 UTC Oct 12 = 5pm Oct 11 in Los Angeles (PDT, UTC-7); 3:05pm already passed.
  const r = parseUsageLimit("You've hit your session limit · resets 3:05pm (America/Los_Angeles)", at('2026-10-12T00:00:00Z'))
  assert.equal(iso(r?.resetAt), '2026-10-12T22:05:00.000Z')
})

test('the offset is taken at the target instant, not at now (DST ends 2026-11-01)', () => {
  // 03:00 UTC Nov 1 is 11pm EDT on Oct 31; 9am the next morning is EST (UTC-5).
  const r = parseUsageLimit("You've hit your session limit · resets 9am (America/Detroit)", at('2026-11-01T03:00:00Z'))
  assert.equal(iso(r?.resetAt), '2026-11-01T14:00:00.000Z')
})

test('winter offset (EST, UTC-5)', () => {
  const r = parseUsageLimit(REAL, at('2026-12-01T00:00:00Z'))
  assert.equal(iso(r?.resetAt), '2026-12-01T05:40:00.000Z')
})

test('curly apostrophe and a dated weekly reset', () => {
  const r = parseUsageLimit('You’ve hit your weekly limit · resets Oct 15, 9am (America/Detroit)', at('2026-10-12T12:00:00Z'))
  assert.equal(iso(r?.resetAt), '2026-10-15T13:00:00.000Z')
})

test('limit message with no parseable time → resetAt null; unknown zone falls back, not throws', () => {
  assert.deepEqual(parseUsageLimit("You've hit your session limit", at('2026-10-12T00:00:00Z')), { resetAt: null })
  const r = parseUsageLimit("You've hit your session limit · resets 9am (Mars/Olympus)", at('2026-10-12T00:00:00Z'))
  assert.ok(r && typeof r.resetAt === 'number')
})

test('ordinary failures are not limit messages', () => {
  assert.equal(parseUsageLimit('claude CLI failed (haiku): exit 1', at('2026-10-12T00:00:00Z')), null)
  assert.equal(isUsageLimitMessage('Credit balance is too low'), false)
  assert.equal(isUsageLimitMessage(REAL), true)
})

test('asUsageLimit: finds the message inside a wrapped job error, passes UsageLimitError through', () => {
  const wrapped = new Error(`[extract 17/34] extraction failed after retries: claude CLI failed (haiku): ${REAL}`)
  const e = asUsageLimit(wrapped, at('2026-10-12T03:34:11Z'))
  assert.ok(e instanceof UsageLimitError)
  assert.equal(iso(e.resetAt), '2026-10-12T04:40:00.000Z')
  const direct = new UsageLimitError('reached', 123)
  assert.equal(asUsageLimit(direct), direct)
  assert.equal(asUsageLimit(new Error('TypeError: fetch failed')), null)
})

test('rethrowIfUsageLimit only throws for UsageLimitError', () => {
  assert.throws(() => rethrowIfUsageLimit(new UsageLimitError('approaching', 1, 0.95)), UsageLimitError)
  assert.doesNotThrow(() => rethrowIfUsageLimit(new Error('anything else')))
})

// ── the CLI stream ─────────────────────────────────────────────────────────

const RATE_EVENT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791826200,"rateLimitType":"five_hour",' +
  '"overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":' +
  '{"five_hour":{"utilization":0.18,"resetsAt":1791826200},"seven_day":{"utilization":0.1,"resetsAt":1792393200}}},"uuid":"x","session_id":"y"}'
const OK_STREAM = [
  '{"type":"system","subtype":"init","cwd":"/private/tmp"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  RATE_EVENT,
  '{"type":"result","subtype":"success","is_error":false,"result":"ok","stop_reason":"end_turn"}',
].join('\n')

test('stream: reply text and the real rate_limit_event', () => {
  const s = parseCliStream(OK_STREAM)
  assert.equal(s.text, 'ok')
  assert.equal(s.isError, false)
  assert.equal(s.rateLimit?.status, 'allowed')
  assert.equal(s.rateLimit?.fiveHour?.utilization, 0.18)
  assert.equal(s.rateLimit?.fiveHour?.resetsAt, 1791826200 * 1000)
  assert.equal(s.rateLimit?.sevenDay?.utilization, 0.1)
})

test('stream: an error result carries the readable reason; junk lines are skipped', () => {
  const s = parseCliStream(`not json\n${RATE_EVENT}\n{"type":"result","is_error":true,"result":"${REAL}"}\n{broken`)
  assert.equal(s.isError, true)
  assert.equal(s.text, REAL)
  assert.ok(s.rateLimit)
})

test('stream: no result event → text null (caller decides); empty input is safe', () => {
  assert.equal(parseCliStream('{"type":"system","subtype":"init"}').text, null)
  assert.deepEqual(parseCliStream(''), { text: null, isError: false, rateLimit: null, events: 0 })
})

test('stream: plain text (not stream-json) reports zero events so the caller can treat it as the reply', () => {
  assert.equal(parseCliStream('{"verdict":"SAME"}\n').events, 0)
  assert.equal(parseCliStream('API Error: Opus 5 flagged this').events, 0)
})

test('stream: a 0–100 percentage is read as a fraction', () => {
  const ev = RATE_EVENT.replace('"utilization":0.18', '"utilization":93')
  assert.equal(parseCliStream(ev).rateLimit?.fiveHour?.utilization, 0.93)
})

// ── the gate: pause BEFORE the limit ───────────────────────────────────────

const NOW = at('2026-10-12T03:00:00Z')
const snap = (util: number, resetsAtMs: number, status = 'allowed') =>
  parseCliStream(
    RATE_EVENT.replace('"status":"allowed"', `"status":"${status}"`)
      .replace('"utilization":0.18,"resetsAt":1791826200', `"utilization":${util},"resetsAt":${Math.floor(resetsAtMs / 1000)}`)
  ).rateLimit

test('gate: open when no call has reported yet, and below the threshold', () => {
  assert.equal(usageGate(NOW), null)
  noteRateLimit(snap(0.5, NOW + 3_600_000), NOW)
  assert.equal(usageGate(NOW), null)
  noteRateLimit(snap(0.91, NOW + 3_600_000), NOW)
  assert.equal(usageGate(NOW), null, `default threshold is ${DEFAULT_PAUSE_AT}`)
})

test('gate: closes slightly before the limit, until the window resets', () => {
  const resetsAt = NOW + 2 * 3_600_000
  noteRateLimit(snap(0.93, resetsAt), NOW)
  const g = usageGate(NOW)
  assert.ok(g instanceof UsageLimitError)
  assert.equal(g.kind, 'approaching')
  assert.equal(g.resetAt, Math.floor(resetsAt / 1000) * 1000)
  // After the reset the snapshot is stale and the gate reopens by itself.
  assert.equal(usageGate(resetsAt + 1000), null)
})

test('gate: honours a custom threshold', () => {
  noteRateLimit(snap(0.8, NOW + 3_600_000), NOW)
  assert.equal(usageGate(NOW, 0.9), null)
  assert.ok(usageGate(NOW, 0.75))
})

test('gate: a rejected status closes it regardless of utilization', () => {
  noteRateLimit(snap(0.1, NOW + 3_600_000, 'rejected'), NOW)
  assert.equal(usageGate(NOW)?.kind, 'reached')
})

test('gate: after the limit message is seen, later calls never spawn until the reset', () => {
  const err = usageLimitReached(at('2026-10-12T04:40:00Z'))
  noteLimitReached(err, NOW)
  assert.equal(usageGate(NOW)?.kind, 'reached')
  assert.equal(usageGate(at('2026-10-12T04:40:01Z')), null)
})

test('gate: a limit message with no time blocks for the default pause', () => {
  noteLimitReached(new UsageLimitError('reached', null), NOW)
  assert.ok(usageGate(NOW + UNKNOWN_RESET_PAUSE_MS - 1))
  assert.equal(usageGate(NOW + UNKNOWN_RESET_PAUSE_MS + 1), null)
})

function usageLimitReached(resetAt: number) {
  return new UsageLimitError('reached', resetAt)
}

// ── the supervisor's sleep ─────────────────────────────────────────────────

const DEADLINE = NOW + 9 * 3_600_000

test('plan: sleeps until just after the reset', () => {
  const reset = at('2026-10-12T04:40:00Z')
  const p = planPause(reset, NOW, DEADLINE)
  assert.equal(p.beyondDeadline, false)
  assert.equal(p.wakeAt, reset + RESET_MARGIN_MS)
  assert.equal(p.sleepMs, reset + RESET_MARGIN_MS - NOW)
})

test('plan: unknown reset → the default pause', () => {
  const p = planPause(null, NOW, DEADLINE)
  assert.equal(p.sleepMs, UNKNOWN_RESET_PAUSE_MS)
})

test('plan: a single sleep is capped (a window cannot need more than 6h)', () => {
  const p = planPause(NOW + 8 * 3_600_000, NOW, NOW + 20 * 3_600_000)
  assert.equal(p.sleepMs, MAX_PAUSE_MS)
  assert.equal(p.beyondDeadline, false)
})

test('plan: a reset after the deadline ends the run instead of idling', () => {
  const p = planPause(NOW + 24 * 3_600_000, NOW, DEADLINE)
  assert.equal(p.beyondDeadline, true)
  assert.equal(p.sleepMs, 0)
})

test('plan: a reset already in the past does not sleep negative', () => {
  assert.equal(planPause(NOW - 1000, NOW, DEADLINE).sleepMs, Math.max(0, RESET_MARGIN_MS - 1000))
})

// ── jobs that can never succeed ────────────────────────────────────────────

test("refusal: the real 'safeguards flagged' error is permanent; ordinary errors are not", () => {
  const real =
    "AdjudicationUnavailableError: Dedup adjudicator unavailable after retries: claude CLI failed (opus): API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
  assert.equal(isRefusalError(real), true)
  assert.equal(isRefusalError(REAL), false)
  assert.equal(isRefusalError('TypeError: fetch failed'), false)
  assert.equal(isRefusalError(null), false)
})

test('quarantine: a refusal is never healed; other failures get MAX_HEALS_PER_JOB retries, then stop', () => {
  const refusal = "claude CLI failed (opus): API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup)"
  assert.match(quarantineReason(refusal, 0) ?? '', /safety filter/)
  assert.equal(quarantineReason('TypeError: fetch failed', 0), null)
  assert.equal(quarantineReason('TypeError: fetch failed', MAX_HEALS_PER_JOB - 1), null)
  assert.match(quarantineReason('TypeError: fetch failed', MAX_HEALS_PER_JOB) ?? '', /still failing/)
  assert.equal(quarantineReason(null, 0), null)
})
