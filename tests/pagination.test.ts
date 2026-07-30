import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectAllPaged } from '../lib/pagination'

// A fake PostgREST-style pager backed by an in-memory array. It enforces the
// real server behaviour that motivated selectAllPaged: a page never returns
// more than `cap` rows even when a wider range is requested (the silent
// 1000-row truncation), so the helper must walk pages to read everything.
function pagerOf(total: number, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ i }))
  const calls: [number, number][] = []
  const page = (from: number, to: number) => {
    calls.push([from, to])
    const width = to - from + 1
    const slice = rows.slice(from, from + Math.min(width, cap))
    return Promise.resolve({ data: slice, error: null })
  }
  return { page, calls }
}

test('reads every row across multiple full pages (past the 1000-row cap)', async () => {
  const { page } = pagerOf(2500)
  const out = await selectAllPaged<{ i: number }>(page)
  assert.equal(out.length, 2500)
  assert.equal(out[0].i, 0)
  assert.equal(out[2499].i, 2499)
})

test('requests stable, contiguous ranges of pageSize width', async () => {
  const { page, calls } = pagerOf(2500)
  await selectAllPaged<{ i: number }>(page)
  // 2500 rows / 1000 = pages [0,999],[1000,1999],[2000,2999] then a short page.
  assert.deepEqual(calls[0], [0, 999])
  assert.deepEqual(calls[1], [1000, 1999])
  assert.deepEqual(calls[2], [2000, 2999])
})

test('stops after a short (under-full) page', async () => {
  const { page, calls } = pagerOf(1500)
  const out = await selectAllPaged<{ i: number }>(page)
  assert.equal(out.length, 1500)
  // full page [0,999] (1000 rows) then [1000,1999] returns 500 (short) → stop.
  assert.equal(calls.length, 2)
})

test('an exactly-full total makes one extra request to confirm the end', async () => {
  const { page, calls } = pagerOf(2000)
  const out = await selectAllPaged<{ i: number }>(page)
  assert.equal(out.length, 2000)
  // [0,999]=1000, [1000,1999]=1000 (ambiguous full page), [2000,2999]=0 → stop.
  assert.equal(calls.length, 3)
})

test('empty result set returns [] after a single request', async () => {
  const { page, calls } = pagerOf(0)
  const out = await selectAllPaged<{ i: number }>(page)
  assert.deepEqual(out, [])
  assert.equal(calls.length, 1)
})

test('propagates a page error as a throw', async () => {
  const page = () => Promise.resolve({ data: null, error: { message: 'boom' } })
  await assert.rejects(() => selectAllPaged(page), /paged select failed at offset 0: boom/)
})

test('pageSize is clamped to the 1000 server cap (a larger value cannot loop forever)', async () => {
  // Server still caps each page at 1000. If selectAllPaged honoured a 5000
  // pageSize its short-page test would never fire; clamping keeps it correct.
  const { page, calls } = pagerOf(1500, 1000)
  const out = await selectAllPaged<{ i: number }>(page, 5000)
  assert.equal(out.length, 1500)
  assert.deepEqual(calls[0], [0, 999])
})

test('pageSize below 1 is clamped up to at least 1', async () => {
  const { page, calls } = pagerOf(2)
  const out = await selectAllPaged<{ i: number }>(page, 1)
  assert.equal(out.length, 2)
  // width 1 pages: [0,0]=1 (full), [1,1]=1 (full), [2,2]=0 (short) → stop.
  assert.deepEqual(calls[0], [0, 0])
  assert.deepEqual(calls[1], [1, 1])
})

test('treats null data as an empty page', async () => {
  const page = (from: number) =>
    Promise.resolve({ data: from === 0 ? null : [], error: null })
  const out = await selectAllPaged<{ i: number }>(page)
  assert.deepEqual(out, [])
})
