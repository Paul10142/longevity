import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTransientRepairError, dbRetry, insertIdempotent, classifyClaimError, FailureStreak, repairRetryBudgetMs, REPAIR_DB_RETRY_MS,
} from '../lib/repairResilience'
import { noteMissing } from '../lib/repairFlags'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'

/** A fake clock: sleeping advances time, so the tests never wait. */
function fakeClock() {
  let t = 0
  const waits: number[] = []
  return { waits, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms }, onRetry: () => {} }
}
const TIMEOUT = 'TimeoutError: The operation was aborted due to timeout'

test('transient: timeouts, dropped connections and 5xx answers; not real database errors', () => {
  for (const m of [TIMEOUT, 'TypeError: fetch failed', 'read ECONNRESET', '502 Bad Gateway', '503 Service Unavailable', '504', '500 Internal Server Error', 'Error 521: web server is down', 'upstream connect error'])
    assert.equal(isTransientRepairError(m), true, m)
  for (const m of ['duplicate key value violates unique constraint "claim_repairs_one_repaired"', 'column "x" does not exist', 'permission denied for table claims', 'claim 5bf36dd1 changed while it was being repaired; left as it is', '', undefined, null])
    assert.equal(isTransientRepairError(m), false, String(m))
})

test('a timeout is retried with a growing wait and the call then succeeds (the 2026-11-16 failure)', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await dbRetry('annotate flag', async () => { calls++; return calls < 3 ? { error: { message: TIMEOUT } } : { error: null } }, c)
  assert.equal(res.error, null)
  assert.equal(calls, 3)
  assert.deepEqual(c.waits, [2000, 4000])
})

test('a 5xx answer is retried too', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await dbRetry('x', async () => { calls++; return calls === 1 ? { error: { message: '503 Service Unavailable' } } : { error: null } }, c)
  assert.equal(res.error, null)
  assert.equal(calls, 2)
})

test('a real database error is returned at once, never retried', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await dbRetry('x', async () => { calls++; return { error: { message: 'duplicate key value violates unique constraint' } } }, c)
  assert.equal(res.error?.message, 'duplicate key value violates unique constraint')
  assert.equal(calls, 1)
  assert.deepEqual(c.waits, [])
})

test('after the last try the error comes back (the caller then records the claim as not finished)', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await dbRetry('x', async () => { calls++; return { error: { message: TIMEOUT } } }, { ...c, maxWaitMs: 20_000 })
  assert.equal(res.error?.message, TIMEOUT)
  assert.ok(calls >= 3 && calls <= 6, `${calls} tries`)
  assert.ok(c.waits.reduce((a, b) => a + b, 0) <= 20_000)
})

test('a thrown timeout (not a returned error) is retried as well', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await dbRetry('x', async () => { calls++; if (calls === 1) throw new Error(TIMEOUT); return { error: null } }, c)
  assert.equal(res.error, null)
  assert.equal(calls, 2)
})

test('the budget defaults to two minutes and can be set from the environment', () => {
  const was = process.env.REPAIR_DB_RETRY_MS
  try {
    delete process.env.REPAIR_DB_RETRY_MS
    assert.equal(repairRetryBudgetMs(), REPAIR_DB_RETRY_MS)
    assert.equal(REPAIR_DB_RETRY_MS, 120_000)
    process.env.REPAIR_DB_RETRY_MS = '3000'
    assert.equal(repairRetryBudgetMs(), 3000)
    process.env.REPAIR_DB_RETRY_MS = 'soon'
    assert.equal(repairRetryBudgetMs(), REPAIR_DB_RETRY_MS)
  } finally {
    if (was === undefined) delete process.env.REPAIR_DB_RETRY_MS; else process.env.REPAIR_DB_RETRY_MS = was
  }
})

// ── insertIdempotent: the audit row must never be written twice ──────────────────

/** A table whose insert can land and still report a lost answer. */
function fakeTable(plan: Array<'ok' | 'lost-answer' | 'dropped' | 'conflict'>) {
  const rows: string[] = []
  const calls = { insert: 0, look: 0 }
  let lookFails = 0
  return {
    rows, calls,
    failNextLooks(n: number) { lookFails = n },
    insert: async () => {
      const what = plan[calls.insert++] ?? 'ok'
      if (what === 'dropped') return { error: { message: 'TypeError: fetch failed' } } // never reached the database
      if (what === 'conflict') return { error: { message: 'null value in column "outcome" violates not-null constraint' } }
      rows.push('row')
      return what === 'lost-answer' ? { error: { message: TIMEOUT } } : { error: null }
    },
    look: async () => {
      calls.look++
      if (lookFails > 0) { lookFails--; return { found: false, error: { message: TIMEOUT } } }
      return { found: rows.length > 0, error: null }
    },
  }
}

test('insert whose answer was lost: found by the check, written exactly once', async () => {
  const t = fakeTable(['lost-answer'])
  const res = await insertIdempotent('audit', t.insert, t.look, fakeClock())
  assert.equal(res.error, null)
  assert.equal(t.rows.length, 1)
  assert.equal(t.calls.insert, 1)
})

test('insert that never reached the database: repeated, written exactly once', async () => {
  const t = fakeTable(['dropped', 'dropped', 'ok'])
  const res = await insertIdempotent('audit', t.insert, t.look, fakeClock())
  assert.equal(res.error, null)
  assert.equal(t.rows.length, 1)
  assert.equal(t.calls.insert, 3)
})

test('a failed check is "unknown": nothing is inserted on that pass, so a landed row is never doubled', async () => {
  const t = fakeTable(['lost-answer', 'ok'])
  t.failNextLooks(2)
  const res = await insertIdempotent('audit', t.insert, t.look, fakeClock())
  assert.equal(res.error, null)
  assert.equal(t.rows.length, 1) // the first attempt landed; the later checks found it
  assert.equal(t.calls.insert, 1)
  assert.equal(t.calls.look, 3)
})

test('a real error from the insert is returned without a check or a repeat', async () => {
  const t = fakeTable(['conflict'])
  const res = await insertIdempotent('audit', t.insert, t.look, fakeClock())
  assert.match(res.error?.message ?? '', /not-null/)
  assert.equal(t.calls.insert, 1)
  assert.equal(t.calls.look, 0)
  assert.equal(t.rows.length, 0)
})

// ── skip and continue ────────────────────────────────────────────────────────────

test('only quota and a halted CLI stop the run at once; any other error belongs to the one claim', () => {
  assert.equal(classifyClaimError(new UsageLimitError('reached', null)), 'halt')
  assert.equal(classifyClaimError(new PipelineHaltError(3, 'cli down')), 'halt')
  assert.equal(classifyClaimError(new Error(`annotate flag a9befbe2: ${TIMEOUT}`)), 'skip')
  assert.equal(classifyClaimError('weird'), 'skip')
})

test('one failed claim is skipped and the run goes on; three in a row stop it', () => {
  const s = new FailureStreak()
  assert.equal(s.failure(), 'continue')
  s.success() // the next claim finished: the streak starts over
  assert.equal(s.failure(), 'continue')
  assert.equal(s.failure(), 'continue')
  s.success()
  assert.equal(s.failure(), 'continue')
  assert.equal(s.failure(), 'continue')
  assert.equal(s.failure(), 'stop')
  assert.equal(s.count, 3)
})

test('the claim loop: a blip on claim 2 is recorded and claims 3 and 4 still finish', async () => {
  // The same shape as the loop in scripts/repairFlaggedClaims.ts: halt breaks, other errors are logged and the loop goes on.
  const claims = ['c1', 'c2', 'c3', 'c4']
  const done: string[] = []
  const notFinished: string[] = []
  const streak = new FailureStreak()
  let stopped = false
  for (const c of claims) {
    try {
      const res = await dbRetry('annotate', async () => (c === 'c2' ? { error: { message: TIMEOUT } } : { error: null }), { ...fakeClock(), maxWaitMs: 5000 })
      if (res.error) throw new Error(`annotate flag ${c}: ${res.error.message}`)
      done.push(c)
      streak.success()
    } catch (err) {
      if (classifyClaimError(err) === 'halt') { stopped = true; break }
      notFinished.push(c)
      if (streak.failure() === 'stop') { stopped = true; break }
    }
  }
  assert.deepEqual(done, ['c1', 'c3', 'c4'])
  assert.deepEqual(notFinished, ['c2'])
  assert.equal(stopped, false)
})

test('the claim loop: three claims in a row that cannot be finished stop the run', async () => {
  const done: string[] = []
  const notFinished: string[] = []
  const streak = new FailureStreak()
  let stopped = false
  for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) {
    try {
      const res = await dbRetry('x', async () => (c === 'c1' ? { error: null } : { error: { message: 'TypeError: fetch failed' } }), { ...fakeClock(), maxWaitMs: 3000 })
      if (res.error) throw new Error(res.error.message)
      done.push(c); streak.success()
    } catch {
      notFinished.push(c)
      if (streak.failure() === 'stop') { stopped = true; break }
    }
  }
  assert.deepEqual(done, ['c1'])
  assert.deepEqual(notFinished, ['c2', 'c3', 'c4'])
  assert.equal(stopped, true)
})

// ── resume: a finished claim whose note never reached its flag ───────────────────

test('noteMissing: a hidden outcome whose flag lacks this run\'s note is re-annotated; everything else is left alone', () => {
  const withNote = { detail: 'REPAIR FAILED TWICE: x', evidence: { repair: { run_id: 'repair-2026-11-16-21-25', outcome: 'failed' } } }
  const withoutNote = { detail: 'ADDED_DETAIL: y', evidence: { verdict: 'ADDED_DETAIL' } }
  const olderRun = { detail: 'REPAIR FAILED TWICE: z', evidence: { repair: { run_id: 'repair-2026-11-09-08-00' } } }
  const noEvidence = { detail: 'ADDED_DETAIL: y', evidence: null }
  assert.equal(noteMissing({ outcome: 'failed', run_id: 'repair-2026-11-16-21-25' }, withNote), false) // landed (the a9befbe2 case)
  assert.equal(noteMissing({ outcome: 'failed', run_id: 'repair-2026-11-16-21-25' }, withoutNote), true) // lost with the answer
  assert.equal(noteMissing({ outcome: 'needs_video', run_id: 'repair-2026-11-16-21-25' }, noEvidence), true)
  assert.equal(noteMissing({ outcome: 'cannot_repair', run_id: 'repair-2026-11-16-21-25' }, olderRun), true) // note is from an older run
  assert.equal(noteMissing({ outcome: 'repaired', run_id: 'repair-2026-11-16-21-25' }, withoutNote), false) // resolved flags carry no note
  assert.equal(noteMissing({ outcome: 'canonical_ok', run_id: null }, withoutNote), false)
})
