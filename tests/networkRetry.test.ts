import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTransientNetworkError, withNetworkRetry } from '../lib/networkRetry'

/** A fake clock: sleeping advances time, so the tests never wait. */
function fakeClock() {
  let t = 0
  const waits: number[] = []
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => { waits.push(ms); t += ms },
  }
}

test('recognises network drops and gateway errors, not real database errors', () => {
  for (const m of ['TypeError: fetch failed', 'read ECONNRESET', 'getaddrinfo ENOTFOUND x.supabase.co', 'The operation was aborted due to timeout', '502 Bad Gateway', 'Network request failed'])
    assert.equal(isTransientNetworkError(m), true, m)
  for (const m of ['duplicate key value violates unique constraint', 'permission denied for table jobs', 'column "x" does not exist', '', undefined, null])
    assert.equal(isTransientNetworkError(m as string), false, String(m))
})

test('returns at once on success and on a non-network error', async () => {
  const c = fakeClock()
  let calls = 0
  const ok = await withNetworkRetry('t', async () => { calls++; return { error: null } }, c)
  assert.equal(ok.error, null)
  const bad = await withNetworkRetry('t', async () => { calls++; return { error: { message: 'duplicate key value' } } }, c)
  assert.equal(bad.error?.message, 'duplicate key value')
  assert.equal(calls, 2)
  assert.deepEqual(c.waits, [])
})

test('rides out a drop: fails twice with fetch failed, then succeeds', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await withNetworkRetry('t', async () => {
    calls++
    return calls < 3 ? { error: { message: 'TypeError: fetch failed' } } : { error: null }
  }, { ...c, onRetry: () => {} })
  assert.equal(res.error, null)
  assert.equal(calls, 3)
  assert.deepEqual(c.waits, [2000, 4000])
})

test('a thrown network error is retried the same way', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await withNetworkRetry('t', async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return { error: null }
  }, { ...c, onRetry: () => {} })
  assert.equal(res.error, null)
  assert.equal(calls, 2)
})

test('a thrown non-network error is rethrown untouched', async () => {
  await assert.rejects(
    withNetworkRetry('t', async () => { throw new Error('boom') }, { ...fakeClock(), onRetry: () => {} }),
    /boom/
  )
})

test('gives up with the last error once the time budget is spent, backing off up to the cap', async () => {
  const c = fakeClock()
  let calls = 0
  const res = await withNetworkRetry('t', async () => { calls++; return { error: { message: 'fetch failed' } } },
    { ...c, maxWaitMs: 100_000, onRetry: () => {} })
  assert.equal(res.error?.message, 'fetch failed')
  assert.ok(calls > 3 && calls < 20, `calls ${calls}`)
  assert.equal(Math.max(...c.waits), 30_000)
  assert.ok(c.waits.reduce((a, b) => a + b, 0) <= 100_000)
})

test('a thrown network error that outlasts the budget is rethrown', async () => {
  await assert.rejects(
    withNetworkRetry('t', async () => { throw new TypeError('fetch failed') }, { ...fakeClock(), maxWaitMs: 10_000, onRetry: () => {} }),
    /fetch failed/
  )
})
