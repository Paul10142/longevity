/**
 * Unit tests for lib/libraryDedup.ts: the pure plan behind scripts/dedupLibrary.ts.
 * Rows in, groups and proposed "mark skipped" changes out. No database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groupDuplicates, planCleanup, type CleanupRow } from '../lib/libraryDedup'

const DRIVE = 'The Drive'
const HUBERMAN = 'Huberman Lab'

let n = 0
const row = (title: string, extra: Partial<CleanupRow> = {}): CleanupRow => ({
  id: `r${++n}`,
  title,
  series: DRIVE,
  processing_status: 'pending',
  facts: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...extra,
})

test('a group keeps the already-extracted copy and skips the rest', () => {
  const keep = row('Habits | James Clear (#183 rebroadcast)', { processing_status: 'succeeded', facts: 217, created_at: '2026-06-01T00:00:00Z' })
  const tidy = row('#183 - Habits | James Clear', { created_at: '2026-01-01T00:00:00Z' })
  const another = row('Habits | James Clear (#183 rebroadcast)', { created_at: '2026-08-24T00:00:00Z' })
  const plan = planCleanup([tidy, keep, another])
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].keeper.id, keep.id)
  assert.deepEqual(new Set(plan.changes.map(c => c.id)), new Set([tidy.id, another.id]))
  for (const c of plan.changes) assert.equal(c.duplicate_of, keep.id)
})

test('with nothing extracted, the numbered title is kept and the unnumbered copy is skipped', () => {
  const numbered = row('#311 - Longevity 101: a foundational guide to longevity')
  const plain = row('Longevity 101: a foundational guide to longevity')
  const plan = planCleanup([plain, numbered])
  assert.equal(plan.groups[0].keeper.id, numbered.id)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].id, plain.id)
  assert.match(plan.changes[0].skip_reason, /^same episode as /)
})

test('a skipped copy that already has facts is reported, never altered beyond the skip', () => {
  const keep = row('#183 - Habits | James Clear', { processing_status: 'succeeded', facts: 217, created_at: '2026-01-01T00:00:00Z' })
  const other = row('Habits | James Clear (#183 rebroadcast)', { processing_status: 'succeeded', facts: 217, created_at: '2026-02-01T00:00:00Z' })
  const plan = planCleanup([keep, other])
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].id, other.id)
  assert.equal(plan.changes[0].facts, 217)
  assert.equal(plan.changes[0].skip_reason, 'rebroadcast of #183')
})

test('different episode numbers never form a group', () => {
  const plan = planCleanup([row('#259 - Sleep | Matt Walker'), row('#260 - Sleep | Matt Walker')])
  assert.equal(plan.groups.length, 0)
  assert.equal(plan.changes.length, 0)
})

test('an Essentials cut with no full episode in the library is skipped on its own', () => {
  const cut = row('Essentials: How to Sleep Better', { series: HUBERMAN })
  const plan = planCleanup([cut])
  assert.equal(plan.groups.length, 0)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].duplicate_of, null)
  assert.match(plan.changes[0].skip_reason, /full episodes only/)
})

test('an Essentials cut next to its full episode points at the full episode, which stays live', () => {
  const full = row('How to Sleep Better', { series: HUBERMAN })
  const cut = row('Essentials: How to Sleep Better', { series: HUBERMAN })
  const plan = planCleanup([cut, full])
  assert.equal(plan.groups[0].keeper.id, full.id)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].id, cut.id)
  assert.equal(plan.changes[0].duplicate_of, full.id)
  assert.match(plan.changes[0].skip_reason, /^re-cut \(Essentials\) of /)
})

test('a rebroadcast that was already extracted and has no sibling is left alone', () => {
  const lone = row('Habits (#12 rebroadcast)', { processing_status: 'succeeded', facts: 171 })
  assert.equal(planCleanup([lone]).changes.length, 0)
})

test('a rebroadcast with nothing extracted and no sibling is skipped (full episodes only)', () => {
  const lone = row('Habits (rebroadcast)')
  const plan = planCleanup([lone])
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].duplicate_of, null)
})

test('a row that already carries the skip is marked as applied (a re-run changes nothing)', () => {
  const keep = row('#1 - Topic words here | Guest')
  const dup = row('Topic words here | Guest (#1 rebroadcast)')
  const first = planCleanup([keep, dup])
  assert.equal(first.changes[0].alreadyApplied, false)
  const second = planCleanup([keep, { ...dup, processing_status: 'skipped', duplicate_of: keep.id }])
  assert.equal(second.changes.length, 1)
  assert.equal(second.changes[0].alreadyApplied, true)
})

test('groups never mix shows', () => {
  const groups = groupDuplicates([
    row('#5 - Same title here', { series: DRIVE }),
    row('#5 - Same title here', { series: HUBERMAN }),
  ])
  assert.equal(groups.length, 0)
})

test('the plan is the same whatever order the rows arrive in', () => {
  const rows = [
    row('#183 - Habits | James Clear'),
    row('Habits | James Clear (#183 rebroadcast)'),
    row('Habits | James Clear (#183 rebroadcast)', { created_at: '2026-08-24T00:00:00Z' }),
  ]
  const a = planCleanup(rows).changes.map(c => `${c.id}>${c.duplicate_of}`).sort()
  const b = planCleanup([...rows].reverse()).changes.map(c => `${c.id}>${c.duplicate_of}`).sort()
  assert.deepEqual(a, b)
})
