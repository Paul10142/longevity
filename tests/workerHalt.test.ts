/**
 * lib/worker.ts settleJobError for a PipelineHaltError, against a stubbed database: the job
 * goes straight back to the queue with its attempts unchanged (the claim is given back), and
 * the tick is told to stop. An ordinary error still spends an attempt.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Patch = { method: string; body: Record<string, unknown> }
const patches: Patch[] = []
const realFetch = globalThis.fetch

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://db.invalid'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    patches.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} })
    return new Response(null, { status: 204 })
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

const job = (attempts: number) =>
  ({ id: 'job-1', type: 'extract_source', status: 'running', attempts, max_attempts: 3, payload: {}, progress: {} }) as never

test('a halt requeues the job at once, gives the claim back, and leaves the checkpoint alone', async () => {
  patches.length = 0
  const { settleJobError } = await import('../lib/worker')
  const { PipelineHaltError } = await import('../lib/usageLimit')
  const halt = new PipelineHaltError(5, 'Not logged in')
  const out = await settleJobError(job(3), halt)
  assert.equal(out, halt)
  assert.equal(patches.length, 1)
  const b = patches[0].body
  assert.equal(b.status, 'queued')
  assert.equal(b.attempts, 2, 'the interrupted claim is given back')
  assert.equal(b.locked_at, null)
  assert.ok(Date.parse(String(b.run_after)) <= Date.now(), 'runnable immediately, no backoff')
  assert.match(String(b.error), /halted: 5 CLI calls failed in a row: Not logged in/)
  assert.ok(!('progress' in b))
})

test('an ordinary error still goes through the normal failure path (not a halt)', async () => {
  patches.length = 0
  const { settleJobError } = await import('../lib/worker')
  const out = await settleJobError(job(1), new Error('boom'))
  assert.equal(out, null)
  assert.notEqual(patches[0]?.body.status, undefined)
})
