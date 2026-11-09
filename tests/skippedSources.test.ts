/**
 * Unit tests for lib/skippedSources.ts: the lookup the audio downloader and the
 * Deepgram transcriber use to leave skipped (re-post / copy) episodes out before
 * anything is billed. The database is a stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeSkipped, lookupSkippedKeys } from '../lib/skippedSources'

type Row = { external_id: string; skip_reason?: string | null }

/** A stand-in for the supabase-js builder: records each query and answers from `rows`. */
function stubDb(rows: Row[], opts: { noReasonColumn?: boolean; fail?: string } = {}) {
  const calls: { cols: string; keys: string[] }[] = []
  const db = {
    from: (_t: string) => ({
      select: (cols: string) => ({
        in: (_col: string, keys: string[]) => ({
          eq: async () => {
            calls.push({ cols, keys })
            if (opts.fail) return { data: null, error: { message: opts.fail } }
            if (opts.noReasonColumn && cols.includes('skip_reason')) {
              return { data: null, error: { message: 'column sources.skip_reason does not exist' } }
            }
            const data = rows.filter(r => keys.includes(r.external_id)).map(r => (cols.includes('skip_reason') ? r : { external_id: r.external_id }))
            return { data, error: null }
          },
        }),
      }),
    }),
  }
  return { db, calls }
}

test('returns only the skipped keys, with their reasons', async () => {
  const { db } = stubDb([{ external_id: 'attia-0183', skip_reason: 'rebroadcast of #183' }])
  const out = await lookupSkippedKeys(db, ['attia-0183', 'attia-0184'])
  assert.deepEqual([...out.keys()], ['attia-0183'])
  assert.equal(out.get('attia-0183')?.reason, 'rebroadcast of #183')
})

test('asks in chunks so the request stays short', async () => {
  const keys = Array.from({ length: 250 }, (_, i) => `attia-${String(i).padStart(4, '0')}`)
  const { db, calls } = stubDb([{ external_id: 'attia-0249', skip_reason: 'x' }])
  const out = await lookupSkippedKeys(db, keys)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(c => c.keys.length <= 100))
  assert.equal(out.size, 1)
})

test('duplicates in the input are asked once', async () => {
  const { db, calls } = stubDb([])
  await lookupSkippedKeys(db, ['a', 'a', 'a'])
  assert.deepEqual(calls[0].keys, ['a'])
})

test('before migration 038 (no skip_reason column) it falls back and finds nothing', async () => {
  const { db, calls } = stubDb([], { noReasonColumn: true })
  const out = await lookupSkippedKeys(db, ['attia-0001'])
  assert.equal(out.size, 0)
  assert.equal(calls.length, 2)
})

test('a database error is thrown, never read as "nothing is skipped"', async () => {
  const { db } = stubDb([], { fail: 'connection reset' })
  await assert.rejects(() => lookupSkippedKeys(db, ['attia-0001']), /skipped-source lookup failed: connection reset/)
})

test('describeSkipped lists the first few and counts the rest', () => {
  const m = new Map(Array.from({ length: 12 }, (_, i) => [`k${i}`, { key: `k${i}`, reason: i === 0 ? 'why' : null }] as const))
  const lines = describeSkipped(m, 8)
  assert.equal(lines.length, 9)
  assert.match(lines[0], /k0 — why/)
  assert.match(lines[8], /and 4 more/)
})
