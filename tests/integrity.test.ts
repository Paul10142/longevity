import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIntegrity, integrityCounts } from '../lib/integrity'

const healthy = {
  activeClaimIds: ['a1', 'a2'],
  retiredClaimIds: ['r1'],
  members: [{ claim_id: 'a1', raw_insight_id: 'f1' }, { claim_id: 'a2', raw_insight_id: 'f2' }],
  insights: [{ id: 'f1', source_id: 's1' }, { id: 'f2', source_id: 's1' }],
  sourceIds: ['s1'],
  vectorClaimIds: ['a1', 'a2'],
}

test('a healthy corpus reports zero of every signature', () => {
  assert.deepEqual(Object.values(integrityCounts(checkIntegrity(healthy))), [0, 0, 0, 0, 0])
})

test('finds each failure signature of an interrupted replacement', () => {
  const r = checkIntegrity({
    activeClaimIds: ['a1', 'a2', 'a3'], // a3: emptied, never retired
    retiredClaimIds: ['r1', 'r2', 'r3'],
    members: [
      { claim_id: 'a1', raw_insight_id: 'f1' },
      { claim_id: 'a2', raw_insight_id: 'gone' }, // fact deleted
      { claim_id: 'r2', raw_insight_id: 'f2' }, // retired but still has a member
    ],
    insights: [{ id: 'f1', source_id: 's1' }, { id: 'f2', source_id: 'deleted-source' }],
    sourceIds: ['s1'],
    vectorClaimIds: ['a1', 'r3'], // r3 retired but still has a vector
  })
  assert.deepEqual(r.activeNoMembers, ['a3'])
  assert.deepEqual(r.membersMissingFact, [{ claim_id: 'a2', raw_insight_id: 'gone' }])
  assert.deepEqual(r.retiredWithVector, ['r3'])
  assert.deepEqual(r.retiredWithMembers, ['r2'])
  assert.deepEqual(r.factsMissingSource, ['f2'])
})
