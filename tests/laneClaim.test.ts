/**
 * claimNextJob with and without a type filter (lib/jobs.ts), and the fresh-run
 * clean-up in lib/extraction.ts: against a stubbed database, no network.
 *
 *  - The plain call must stay the zero-argument RPC, so main works before
 *    migration 032 is applied.
 *  - A lane passes p_types, and a missing function names the migration.
 *  - A fresh extraction of a new source must NOT call the library-wide
 *    reconcile_claim_membership(): that is the one write that would let an
 *    extract-only run race a consolidate-only run.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Call = { url: string; method: string; body: unknown }
const calls: Call[] = []
let respond: (c: Call) => Response = () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://db.invalid'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    return respond(c)
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

const rpcCalls = () => calls.filter(c => c.url.includes('/rpc/'))

test('claimNextJob() with no types is the zero-argument RPC, as before', async () => {
  calls.length = 0
  respond = () => json([])
  const { claimNextJob } = await import('../lib/jobs')
  assert.equal(await claimNextJob(), null)
  assert.equal(rpcCalls().length, 1)
  assert.match(rpcCalls()[0].url, /\/rpc\/claim_next_job$/)
  assert.deepEqual(rpcCalls()[0].body ?? {}, {})
})

test('claimNextJob(types) passes p_types, and returns the claimed job', async () => {
  calls.length = 0
  respond = () => json([{ id: 'j1', type: 'extract_source' }])
  const { claimNextJob } = await import('../lib/jobs')
  const job = await claimNextJob(['extract_source'])
  assert.equal(job?.id, 'j1')
  assert.deepEqual(rpcCalls()[0].body, { p_types: ['extract_source'] })
})

test('claimNextJob(types) before migration 032 says to apply it', async () => {
  respond = () => json({ code: 'PGRST202', message: 'Could not find the function public.claim_next_job(p_types) in the schema cache' }, 404)
  const { claimNextJob } = await import('../lib/jobs')
  await assert.rejects(() => claimNextJob(['consolidate_source']), /migration 032/)
  // the plain call keeps the plain message
  respond = () => json({ message: 'boom' }, 500)
  await assert.rejects(() => claimNextJob(), (e: Error) => /Failed to claim job: boom/.test(e.message) && !/032/.test(e.message))
})

test('fresh extraction of a new source clears only its own rows and never runs the library-wide reconcile', async () => {
  calls.length = 0
  respond = c => {
    if (c.method === 'GET' && c.url.includes('/raw_insights')) return json([]) // no prior insights
    return json([])
  }
  const { clearForFreshRun } = await import('../lib/extraction')
  const r = await clearForFreshRun('11111111-1111-1111-1111-111111111111')
  assert.equal(r.hadMembers, false)
  assert.equal(rpcCalls().length, 0, 'no reconcile_claim_membership call')
  const writes = calls.filter(c => c.method !== 'GET' && c.method !== 'HEAD').map(c => `${c.method} ${new URL(c.url).pathname}`)
  assert.deepEqual(writes, ['DELETE /rest/v1/chunks', 'DELETE /rest/v1/raw_insights'])
})

test('a source whose insights still have claim members is refused; the override reconciles (a maintenance run)', async () => {
  const sid = '22222222-2222-2222-2222-222222222222'
  respond = c => {
    if (c.method === 'GET' && c.url.includes('/raw_insights')) return json([{ id: 'r1' }])
    if (c.url.includes('/claim_members')) return json([], 200, { 'content-range': '*/3' })
    return json([])
  }
  const { clearForFreshRun } = await import('../lib/extraction')
  delete process.env.ALLOW_MEMBERED_REEXTRACT
  calls.length = 0
  await assert.rejects(() => clearForFreshRun(sid), /still has claim members/)
  assert.equal(calls.filter(c => c.method !== 'GET' && c.method !== 'HEAD').length, 0, 'nothing deleted when refused')

  process.env.ALLOW_MEMBERED_REEXTRACT = '1'
  try {
    calls.length = 0
    const r = await clearForFreshRun(sid)
    assert.equal(r.hadMembers, true)
    assert.equal(rpcCalls().length, 1)
    assert.match(rpcCalls()[0].url, /reconcile_claim_membership/)
  } finally {
    delete process.env.ALLOW_MEMBERED_REEXTRACT
  }
})
