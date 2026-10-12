/**
 * The merge rule both consolidation paths share (lib/consolidation.ts,
 * pairAction / verdictNote). Paul, 2026-10-12: a pair merges only on a SAME at
 * or above AUTO_MERGE_CONFIDENCE; every other verdict keeps the two claims apart
 * and records the verdict on their link. There is no "send to review" outcome
 * any more — these tests fail if one comes back.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairAction, verdictNote, AUTO_MERGE_CONFIDENCE } from '../lib/consolidation'

test('the auto-merge bar is still 0.80', () => {
  assert.equal(AUTO_MERGE_CONFIDENCE, 0.8)
})

test('SAME at or above the bar merges', () => {
  assert.equal(pairAction({ verdict: 'SAME', confidence: 0.8 }), 'merge')
  assert.equal(pairAction({ verdict: 'SAME', confidence: 0.95 }), 'merge')
})

test('SAME below the bar keeps the pair separate — no review', () => {
  for (const confidence of [0, 0.55, 0.7, 0.72, 0.78, 0.799]) {
    assert.equal(pairAction({ verdict: 'SAME', confidence }), 'keep_separate', `SAME ${confidence}`)
  }
})

test('UNSURE is treated like a low-confidence SAME, whatever its confidence', () => {
  for (const confidence of [0, 0.5, 0.8, 0.99]) {
    assert.equal(pairAction({ verdict: 'UNSURE', confidence }), 'keep_separate', `UNSURE ${confidence}`)
  }
})

test('DIFFERENT and a safety-filter refusal keep the pair separate', () => {
  assert.equal(pairAction({ verdict: 'DIFFERENT', confidence: 0.95 }), 'keep_separate')
  assert.equal(pairAction({ verdict: 'REFUSED', confidence: 0 }), 'keep_separate')
})

test('only two outcomes exist: merge or keep_separate', () => {
  const verdicts = ['SAME', 'DIFFERENT', 'UNSURE', 'REFUSED'] as const
  for (const verdict of verdicts) {
    for (const confidence of [0, 0.5, 0.79, 0.8, 1]) {
      assert.ok(['merge', 'keep_separate'].includes(pairAction({ verdict, confidence })))
    }
  }
})

test('the link note records verdict and confidence for a second-opinion pass', () => {
  assert.equal(verdictNote({ verdict: 'SAME', confidence: 0.72 }), 'judge:SAME@0.72')
  assert.equal(verdictNote({ verdict: 'UNSURE', confidence: 0.4 }), 'judge:UNSURE@0.40')
  assert.equal(verdictNote({ verdict: 'DIFFERENT', confidence: 0.9 }), 'judge:DIFFERENT@0.90')
  assert.equal(verdictNote({ verdict: 'REFUSED', confidence: 0 }), 'judge:REFUSED')
})
