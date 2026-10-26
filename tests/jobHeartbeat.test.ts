/**
 * lib/jobs.ts startJobHeartbeat: while a handler runs, the job's lock time is refreshed, only for
 * a job still 'running', and never writes the checkpoint. Stubbed database.
 *
 *   npm test
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Call = { method: string; url: string; body: Record<string, unknown> }
const calls: Call[] = []
const realFetch = globalThis.fetch

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://db.invalid'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} })
    return new Response(null, { status: 204 })
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('refreshes only locked_at, only while status is running, until stopped', async () => {
  calls.length = 0
  const { startJobHeartbeat } = await import('../lib/jobs')
  const stop = startJobHeartbeat('job-9', 20, 10_000)
  await sleep(110)
  stop()
  const n = calls.length
  assert.ok(n >= 3, `expected several refreshes, got ${n}`)
  for (const c of calls) {
    assert.equal(c.method, 'PATCH')
    assert.match(c.url, /id=eq\.job-9/)
    assert.match(c.url, /status=eq\.running/)
    assert.deepEqual(Object.keys(c.body), ['locked_at'])
  }
  await sleep(80)
  assert.equal(calls.length, n, 'no refresh after stop')
})

test('stops refreshing after the cap so a hung handler becomes reclaimable', async () => {
  calls.length = 0
  const { startJobHeartbeat } = await import('../lib/jobs')
  const stop = startJobHeartbeat('job-10', 15, 50)
  await sleep(200)
  const n = calls.length
  await sleep(100)
  stop()
  assert.equal(calls.length, n)
  assert.ok(n >= 1 && n <= 4, `got ${n}`)
})

test('a failing refresh is skipped, not thrown', async () => {
  calls.length = 0
  const prev = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const { startJobHeartbeat } = await import('../lib/jobs')
  const warn = console.warn
  const warned: string[] = []
  console.warn = (m: string) => { warned.push(String(m)) }
  try {
    const stop = startJobHeartbeat('job-11', 15, 10_000)
    await sleep(80)
    stop()
  } finally {
    console.warn = warn
    globalThis.fetch = prev
  }
  assert.ok(warned.some(w => /heartbeat skipped for job-11/.test(w)))
})
