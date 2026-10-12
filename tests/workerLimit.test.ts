/**
 * lib/worker.ts settleJobError against a stubbed database: a usage-limit pause
 * must park the job WITHOUT spending an attempt (so a long pause can never push
 * jobs to permanently `failed`), while an ordinary error still counts.
 *
 * `claim_next_job()` increments `attempts` when it claims a row, so the Job the
 * worker holds already carries the claim: a job claimed for the 3rd time has
 * attempts = 3, and deferring must write 2.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Patch = { url: string; method: string; body: Record<string, unknown> }
const patches: Patch[] = []
const realFetch = globalThis.fetch

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://db.invalid'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    patches.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} })
    return new Response(null, { status: 204 })
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

const job = (attempts: number) =>
  ({ id: 'job-1', type: 'consolidate_source', status: 'running', attempts, max_attempts: 3, payload: {}, progress: {} }) as never

test('usage limit: job goes back to queued, attempt not spent, resumes after the reset + margin', async () => {
  patches.length = 0
  const { settleJobError } = await import('../lib/worker')
  const { UsageLimitError, RESET_MARGIN_MS } = await import('../lib/usageLimit')
  const resetAt = Date.now() + 3_600_000
  const limit = await settleJobError(job(3), new UsageLimitError('reached', resetAt))
  assert.ok(limit)
  assert.equal(patches.length, 1)
  const b = patches[0].body
  assert.equal(patches[0].method, 'PATCH')
  assert.equal(b.status, 'queued')
  assert.equal(b.attempts, 2, 'the claim that was interrupted is given back')
  assert.equal(b.locked_at, null)
  assert.equal(b.run_after, new Date(resetAt + RESET_MARGIN_MS).toISOString())
  assert.match(String(b.error), /paused/)
  assert.ok(!('progress' in b), 'the checkpoint is left untouched')
})

test('usage limit that arrives wrapped in another error is still a pause', async () => {
  patches.length = 0
  const { settleJobError } = await import('../lib/worker')
  const wrapped = new Error(
    "[extract 17/34] extraction failed after retries: claude CLI failed (haiku): You've hit your session limit · resets 12:40am (America/Detroit)"
  )
  assert.ok(await settleJobError(job(1), wrapped))
  assert.equal(patches[0].body.attempts, 0, 'attempts never goes negative')
  assert.equal(patches[0].body.status, 'queued')
})

test('ordinary error: counted — queued with backoff while attempts remain, failed at the limit', async () => {
  patches.length = 0
  const { settleJobError } = await import('../lib/worker')
  assert.equal(await settleJobError(job(1), new Error('TypeError: fetch failed')), null)
  assert.equal(patches[0].body.status, 'queued')
  assert.ok(!('attempts' in patches[0].body), 'failJob leaves the count alone: claim already added one')
  patches.length = 0
  assert.equal(await settleJobError(job(3), new Error('boom')), null)
  assert.equal(patches[0].body.status, 'failed')
})
