/** Hold-out sampling for the overnight fidelity judge (lib/judgeHoldout.ts). Pure: no database. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HOLDOUT, pickHoldout, holdoutPairId, isHoldoutPairId, holdoutSize, sourceIdsFromJobs,
} from '../lib/judgeHoldout'

const items = Array.from({ length: 40 }, (_, i) => `claim-${i}`)

test('pickHoldout: same seed = same sample, different seed = (almost surely) different', () => {
  assert.deepEqual(pickHoldout(items, 5, 42), pickHoldout(items, 5, 42))
  assert.notDeepEqual(pickHoldout(items, 5, 42), pickHoldout(items, 5, 43))
})

test('pickHoldout: n distinct members of the input, input untouched', () => {
  const copy = items.slice()
  const got = pickHoldout(items, 5, 7)
  assert.equal(got.length, 5)
  assert.equal(new Set(got).size, 5)
  for (const g of got) assert.ok(items.includes(g))
  assert.deepEqual(items, copy)
})

test('pickHoldout: asks for more than exist, zero, or negative', () => {
  assert.equal(pickHoldout(['a', 'b'], 5, 1).length, 2)
  assert.deepEqual(pickHoldout(items, 0, 1), [])
  assert.deepEqual(pickHoldout(items, -3, 1), [])
  assert.deepEqual(pickHoldout([], 5, 1), [])
})

test('pair ids are prefixed so they never collide with the 40 static pairs', () => {
  assert.equal(holdoutPairId('abc'), 'holdout:abc')
  assert.ok(isHoldoutPairId('holdout:abc'))
  assert.ok(!isHoldoutPairId('extract:abc'))
})

test('holdoutSize: default 5, whole numbers honoured, 0 = off, junk = default', () => {
  assert.equal(holdoutSize(undefined), DEFAULT_HOLDOUT)
  assert.equal(holdoutSize(''), DEFAULT_HOLDOUT)
  assert.equal(holdoutSize('8'), 8)
  assert.equal(holdoutSize('0'), 0)
  assert.equal(holdoutSize('-2'), DEFAULT_HOLDOUT)
  assert.equal(holdoutSize('2.5'), DEFAULT_HOLDOUT)
  assert.equal(holdoutSize('lots'), DEFAULT_HOLDOUT)
})

test('sourceIdsFromJobs: distinct source ids, ignores malformed payloads', () => {
  const rows = [{ payload: { source_id: 's1' } }, { payload: { source_id: 's2' } }, { payload: { source_id: 's1' } },
    { payload: {} }, { payload: null }, { payload: { source_id: 7 } }]
  assert.deepEqual(sourceIdsFromJobs(rows).sort(), ['s1', 's2'])
})
