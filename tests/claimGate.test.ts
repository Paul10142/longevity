import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quarantinesOnRaise, statusAfterResolution } from '../lib/claimGate'

test('an extraction_fidelity flag hides its claim by default', () => {
  assert.equal(quarantinesOnRaise('extraction_fidelity', {}), true)
})

test('FIDELITY_SHADOW_MODE=1 turns hiding back off', () => {
  assert.equal(quarantinesOnRaise('extraction_fidelity', { FIDELITY_SHADOW_MODE: '1' }), false)
})

test('the advisory rules never hide a claim', () => {
  for (const rule of ['merge_fidelity', 'orphan_topic', 'manual', 'standalone', 'contradiction']) {
    assert.equal(quarantinesOnRaise(rule, {}), false, rule)
  }
})

test('dismissing a fidelity flag as a false alarm restores the hidden claim', () => {
  assert.equal(statusAfterResolution('flagged', 'extraction_fidelity', 'false_positive'), 'active')
})

test('confirming the issue keeps the claim hidden', () => {
  assert.equal(statusAfterResolution('flagged', 'extraction_fidelity', 'approved'), null)
})

test('a claim the gate did not hide is never touched', () => {
  assert.equal(statusAfterResolution('active', 'extraction_fidelity', 'false_positive'), null)
  assert.equal(statusAfterResolution('merged_into', 'extraction_fidelity', 'false_positive'), null)
  assert.equal(statusAfterResolution('flagged', 'merge_fidelity', 'false_positive'), null)
})
