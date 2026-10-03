import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingRechecks } from '../lib/fidelity'

const AT = '2026-08-15T02:36:59Z'
const judge = new Map([
  ['a', 'FAITHFUL'],
  ['b', 'ADDED_DETAIL'],
  ['c', 'FAITHFUL'],
])

test('a disagreement labelled before the comparison is pending', () => {
  const got = pendingRechecks([{ pair_id: 'b', label: 'FAITHFUL', updated_at: '2026-08-15T02:28:00Z' }], judge, AT)
  assert.deepEqual([...got], ['b'])
})

test('agreement is never pending', () => {
  const got = pendingRechecks([{ pair_id: 'a', label: 'FAITHFUL', updated_at: '2026-08-01T00:00:00Z' }], judge, AT)
  assert.equal(got.size, 0)
})

test('re-saving after the comparison clears it, whether or not the ruling changed', () => {
  const got = pendingRechecks(
    [
      { pair_id: 'b', label: 'FAITHFUL', updated_at: '2026-10-03T12:00:00Z' }, // kept
      { pair_id: 'c', label: 'ADDED_DETAIL', updated_at: '2026-10-03T12:00:00Z' }, // still disagrees, re-confirmed
    ],
    judge,
    AT
  )
  assert.equal(got.size, 0)
})

test('a missing timestamp or unknown pair is handled without inventing work', () => {
  const got = pendingRechecks(
    [
      { pair_id: 'b', label: 'FAITHFUL', updated_at: null },
      { pair_id: 'zz', label: 'FAITHFUL', updated_at: null },
    ],
    judge,
    AT
  )
  assert.deepEqual([...got], ['b'])
})
