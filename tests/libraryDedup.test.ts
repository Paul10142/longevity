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

test('both copies extracted: the copy with more facts is kept, the other is skipped and keeps its facts', () => {
  const numbered = row('#349 - AMA #71: Building strength, muscle and more', { processing_status: 'succeeded', facts: 169, created_at: '2026-01-01T00:00:00Z' })
  const rebroadcast = row('Building strength, muscle and more (AMA #71 rebroadcast)', { processing_status: 'succeeded', facts: 176, created_at: '2026-06-01T00:00:00Z' })
  const plan = planCleanup([numbered, rebroadcast])
  assert.equal(plan.groups[0].keeper.id, rebroadcast.id)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].id, numbered.id)
  assert.equal(plan.changes[0].facts, 169)
  assert.equal(plan.changes[0].duplicate_of, rebroadcast.id)
})

test('an extracted rebroadcast is kept over an unextracted original', () => {
  const original = row('#288 - Some topic | Guest')
  const rebroadcast = row('Some topic | Guest (#288 rebroadcast)', { processing_status: 'succeeded', facts: 66 })
  const plan = planCleanup([original, rebroadcast])
  assert.equal(plan.groups[0].keeper.id, rebroadcast.id)
  assert.deepEqual(plan.changes.map(c => c.id), [original.id])
})

test('Huberman AMA and live Q&A items are skipped on their own title and never grouped', () => {
  const a = row('AMA #3: Adaptogens, Fasting & Fertility', { series: HUBERMAN })
  const b = row('AMA #3: Adaptogens, Fasting & Fertility', { series: HUBERMAN }) // a repeat of the same title
  const live = row('LIVE EVENT Q&A: Dr. Andrew Huberman at the Chicago Theatre', { series: HUBERMAN })
  const full = row('How to Build Muscle | Dr. Someone', { series: HUBERMAN })
  const plan = planCleanup([a, b, live, full])
  assert.equal(plan.groups.length, 0)
  assert.deepEqual(new Set(plan.changes.map(c => c.id)), new Set([a.id, b.id, live.id]))
  for (const c of plan.changes) {
    assert.equal(c.duplicate_of, null)
    assert.equal(c.group, null)
    assert.match(c.skip_reason, /full episodes only/)
  }
})

test('a Huberman Q&A item that is already extracted is left alone; the Drive AMA is not Q&A', () => {
  const done = row('AMA #1: Something', { series: HUBERMAN, processing_status: 'succeeded', facts: 90 })
  const driveAma = row('#127 - AMA #3 with a guest: Fasting, gut health', { series: DRIVE })
  const plan = planCleanup([done, driveAma])
  assert.equal(plan.changes.length, 0)
})

// ── pasted text loses to audio (Paul, 2026-11-08) ─────────────────────────────

const text368 = (extra: Partial<CleanupRow> = {}) =>
  row('#368 The Protein Debata', { media_type: 'text', transcript_origin: 'manual', processing_status: 'succeeded', facts: 156, external_id: 'text-attia-0368', ...extra })
const audio368 = (extra: Partial<CleanupRow> = {}) =>
  row('#368 ‒ The protein debate: optimal intake | David Allison, Ph.D.', { media_type: 'audio', transcript_origin: 'deepgram', processing_status: 'pending', facts: 0, external_id: 'attia-0368', ...extra })

test('TRAP: a pending audio copy is kept and the succeeded text copy is NOT skipped; it is set aside as waiting', () => {
  const text = text368()
  const audio = audio368()
  const plan = planCleanup([text, audio])
  assert.equal(plan.groups[0].keeper.id, audio.id)
  assert.deepEqual(plan.changes, []) // the text copy is never skipped by the cleanup
  assert.equal(plan.pastedText.length, 1)
  assert.equal(plan.pastedText[0].id, text.id)
  assert.equal(plan.pastedText[0].audioId, audio.id)
  assert.equal(plan.pastedText[0].state, 'waiting')
  assert.match(plan.pastedText[0].why, /not yet succeeded/)
  assert.equal(plan.pastedText[0].facts, 156)
})

test('an audio copy that succeeded makes the text copy ready, still not a cleanup change', () => {
  const text = text368()
  const audio = audio368({ processing_status: 'succeeded', facts: 140 })
  const plan = planCleanup([text, audio])
  assert.equal(plan.groups[0].keeper.id, audio.id) // even with fewer facts than the text copy
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.pastedText[0].state, 'ready')
})

test('a text copy that already carries the replacement reads as applied', () => {
  const audio = audio368({ processing_status: 'succeeded', facts: 140 })
  const text = text368({ processing_status: 'skipped', duplicate_of: audio.id, skip_reason: 'pasted text replaced by Deepgram transcript (Paul, 2026-11-08)' })
  const plan = planCleanup([text, audio])
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.pastedText[0].state, 'applied')
})

test('a pasted-text row with no audio copy is untouched and not listed', () => {
  const plan = planCleanup([text368()])
  assert.deepEqual(plan.changes, [])
  assert.deepEqual(plan.pastedText, [])
  assert.equal(plan.groups.length, 0)
})

test('two pasted-text copies of one episode follow the usual rule: the extra copy is skipped, not set aside', () => {
  const big = text368({ facts: 156 })
  const small = text368({ facts: 20, external_id: null })
  const plan = planCleanup([small, big])
  assert.equal(plan.pastedText.length, 0)
  assert.deepEqual(plan.changes.map(c => c.id), [small.id])
  assert.equal(plan.changes[0].duplicate_of, big.id)
})

test('the full-episode text copy stays live next to an Essentials cut, which is the one skipped', () => {
  const text = row('The Protein Debate', { series: HUBERMAN, media_type: 'text', processing_status: 'succeeded', facts: 50 })
  const cut = row('Essentials: The Protein Debate', { series: HUBERMAN, media_type: 'audio', processing_status: 'pending' })
  const plan = planCleanup([text, cut])
  assert.deepEqual(plan.changes.map(c => c.id), [cut.id])
  assert.equal(plan.pastedText.length, 0)
})

test('a caption-import copy that is not Deepgram is reported as blocked, never skipped', () => {
  const text = text368()
  const captions = audio368({ transcript_origin: 'manual', processing_status: 'succeeded', facts: 90 })
  const plan = planCleanup([text, captions])
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.pastedText[0].state, 'blocked')
})
