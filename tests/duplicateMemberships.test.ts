import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDuplicateMemberships, type MemberEdge } from '../lib/duplicateMemberships'

const S = 'skipped'
const K = 'kept'
const O = 'other-episode'

const e = (claim_id: string, raw_insight_id: string, source_id: string, matched_by?: string): MemberEdge => ({ claim_id, raw_insight_id, source_id, matched_by })
const plan = (edges: MemberEdge[], active: string[], skippedInsightIds: string[] = edges.filter(x => x.source_id === S).map(x => x.raw_insight_id)) =>
  planDuplicateMemberships({ skippedId: S, keptId: K, skippedInsightIds, edges, activeClaimIds: new Set(active) })

test('a claim fed by both copies is shared: only the skipped copy citation is removed', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i2', K)], ['c1'])
  assert.deepEqual(p.remove, [{ claim_id: 'c1', raw_insight_id: 'i1' }])
  assert.equal(p.shared.length, 1)
  assert.equal(p.solo.length, 0)
  assert.equal(p.shared[0].keptMembers, 1)
  assert.equal(p.shared[0].sourceCountBefore, 2)
  assert.equal(p.shared[0].sourceCountAfter, 1)
  assert.equal(p.sourceCountDrops, 1)
})

test('a claim only the skipped copy feeds is solo and untouched', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i3', S)], ['c1'])
  assert.deepEqual(p.remove, [])
  assert.equal(p.shared.length, 0)
  assert.deepEqual(p.solo, [{ claim_id: 'c1', skippedMembers: 2, otherMembers: 0 }])
})

test('a claim fed by the skipped copy and another episode (not the kept copy) is solo', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i9', O)], ['c1'])
  assert.deepEqual(p.remove, [])
  assert.equal(p.solo[0].otherMembers, 1)
})

test('another episode that also feeds a shared claim keeps its corroboration', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i2', K), e('c1', 'i9', O)], ['c1'])
  assert.equal(p.shared[0].otherMembers, 1)
  assert.equal(p.shared[0].sourceCountBefore, 3)
  assert.equal(p.shared[0].sourceCountAfter, 2)
})

test('several skipped-copy members on one shared claim are all removed, kept ones never', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i4', S), e('c1', 'i2', K), e('c1', 'i5', K)], ['c1'])
  assert.deepEqual(p.remove.map(r => r.raw_insight_id), ['i1', 'i4'])
  assert.equal(p.shared[0].keptMembers, 2)
})

test('a claim is never left without a member: every planned removal sits on a claim the kept copy also feeds', () => {
  const edges = [e('c1', 'i1', S), e('c1', 'i2', K), e('c2', 'i3', S), e('c3', 'i4', S), e('c3', 'i5', K), e('c3', 'i6', O)]
  const p = plan(edges, ['c1', 'c2', 'c3'])
  const removed = new Set(p.remove.map(r => r.raw_insight_id))
  for (const claim of new Set(edges.map(x => x.claim_id))) {
    const left = edges.filter(x => x.claim_id === claim && !removed.has(x.raw_insight_id))
    if (edges.some(x => x.claim_id === claim && removed.has(x.raw_insight_id))) assert.ok(left.length > 0, `${claim} would be empty`)
  }
  assert.equal(p.remove.length, 2)
})

test('claims that are not active are left exactly as they are', () => {
  const p = plan([e('c1', 'i1', S), e('c1', 'i2', K), e('c2', 'i3', S)], [])
  assert.deepEqual(p.remove, [])
  assert.equal(p.inactiveClaims, 2)
  assert.equal(p.shared.length + p.solo.length, 0)
})

test('claims the skipped copy does not feed are ignored', () => {
  const p = plan([e('c1', 'i2', K), e('c1', 'i9', O)], ['c1'], ['i1'])
  assert.deepEqual(p.remove, [])
  assert.equal(p.attached, 0)
  assert.equal(p.insights, 1)
})

test('counts: insights, attached and the report-only seed flag', () => {
  const p = plan([e('c1', 'i1', S, 'seed'), e('c1', 'i2', K), e('c2', 'i3', S, 'auto'), e('c2', 'i4', K)], ['c1', 'c2'], ['i1', 'i3', 'i7'])
  assert.equal(p.insights, 3)
  assert.equal(p.attached, 2)
  assert.equal(p.seedsRemoved, 1)
  assert.equal(p.shared.find(s => s.claim_id === 'c1')?.seedRemoved, true)
  assert.equal(p.shared.find(s => s.claim_id === 'c2')?.seedRemoved, false)
})

test('the plan is deterministic whatever order the edges arrive in', () => {
  const edges = [e('c2', 'i3', S), e('c2', 'i4', K), e('c1', 'i1', S), e('c1', 'i2', K)]
  assert.deepEqual(plan(edges, ['c1', 'c2']), plan([...edges].reverse(), ['c1', 'c2']))
})

test('the same source cannot be both the skipped and the kept copy', () => {
  assert.throws(() => planDuplicateMemberships({ skippedId: 'a', keptId: 'a', skippedInsightIds: [], edges: [], activeClaimIds: new Set() }), /same source/)
})
