/**
 * Unit tests for lib/skippedItems.ts (hiding skipped and non-full episodes on the
 * admin review screens) and lib/nonFullSkip.ts (the plan for marking the four
 * non-full Drive items). The database is a stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeSkippedSources,
  isSkippedOnly,
  isSkippedStatus,
  loadClaimSourceIds,
  loadSkippedSources,
  skipReasonText,
  skippedOnlyClaims,
  skippedSourcesOf,
  splitBySkipped,
  type SkippedSource,
} from '../lib/skippedItems'
import { NON_FULL_TARGETS, planNonFullSkips, refusalReasons, rowsToWrite, type SourceRowLite } from '../lib/nonFullSkip'

const skipped = new Map<string, SkippedSource>([
  ['s1', { id: 's1', title: 'Re-release', reason: 're-release: full episodes only' }],
  ['s2', { id: 's2', title: 'Special', reason: null }],
])

test('only processing_status skipped counts as skipped', () => {
  assert.equal(isSkippedStatus('skipped'), true)
  for (const s of ['pending', 'processing', 'succeeded', 'failed', null, undefined, '']) assert.equal(isSkippedStatus(s), false)
})

test('a missing reason reads as plain words', () => {
  assert.equal(skipReasonText(null), 'No reason written')
  assert.equal(skipReasonText('   '), 'No reason written')
  assert.equal(skipReasonText(' rebroadcast of #183 '), 'rebroadcast of #183')
})

test('splitBySkipped keeps order and puts skipped sources in hidden', () => {
  const items = [{ n: 1, src: 'a' }, { n: 2, src: 's1' }, { n: 3, src: 'b' }, { n: 4, src: 's2' }, { n: 5, src: null }]
  const { shown, hidden } = splitBySkipped(items, i => i.src, skipped)
  assert.deepEqual(shown.map(i => i.n), [1, 3, 5])
  assert.deepEqual(hidden.map(i => i.n), [2, 4])
})

test('nothing is hidden when nothing is skipped', () => {
  const { shown, hidden } = splitBySkipped([{ src: 's1' }], i => i.src, new Map())
  assert.equal(shown.length, 1)
  assert.equal(hidden.length, 0)
})

test('a claim is skipped-only only when every source is skipped', () => {
  assert.equal(isSkippedOnly(['s1', 's2'], skipped), true)
  assert.equal(isSkippedOnly(['s1', 'full'], skipped), false)
  assert.equal(isSkippedOnly([], skipped), false)
  assert.equal(isSkippedOnly(undefined, skipped), false)
})

test('skippedSourcesOf lists each skipped source once; describe names them', () => {
  const list = skippedSourcesOf(['s1', 's1', 'full', 's2'], skipped)
  assert.deepEqual(list.map(s => s.id), ['s1', 's2'])
  assert.deepEqual(describeSkippedSources(list), { title: 'Re-release (+1 more)', reason: 're-release: full episodes only' })
  assert.deepEqual(describeSkippedSources([list[1]]), { title: 'Special', reason: 'No reason written' })
})

/** A stand-in for supabase-js's chainable builder: answers from `rows`, honours range and an optional error. */
function builder(rows: unknown[], opts: { failFirstWith?: string } = {}) {
  let failed = false
  const calls: string[] = []
  const db = {
    from: (_t: string) => ({
      select: (cols: string) => {
        calls.push(cols)
        let lo = 0
        let hi = 999
        const q: any = {
          eq: () => q,
          in: () => q,
          order: () => q,
          range: (a: number, b: number) => {
            lo = a
            hi = b
            return q
          },
          then: (res: (v: unknown) => unknown) => {
            if (opts.failFirstWith && !failed && cols.includes('skip_reason')) {
              failed = true
              return Promise.resolve({ data: null, error: { message: opts.failFirstWith } }).then(res)
            }
            return Promise.resolve({ data: rows.slice(lo, hi + 1), error: null }).then(res)
          },
        }
        return q
      },
    }),
  }
  return { db, calls }
}

test('loadSkippedSources reads id, title and reason', async () => {
  const { db } = builder([{ id: 'a', title: 'T', skip_reason: 'why' }, { id: 'b', title: null, skip_reason: null }])
  const m = await loadSkippedSources(db)
  assert.equal(m.get('a')?.reason, 'why')
  assert.equal(m.get('b')?.title, 'Untitled')
})

test('before migration 038 (no skip_reason column) it falls back and still lists nothing wrongly', async () => {
  const { db, calls } = builder([{ id: 'a', title: 'T' }], { failFirstWith: 'column sources.skip_reason does not exist' })
  const m = await loadSkippedSources(db)
  assert.equal(calls.length, 2)
  assert.equal(m.get('a')?.reason, null)
})

test('a database error hides nothing (fails open)', async () => {
  const errDb = { from: () => ({ select: () => { const q: any = { eq: () => q, order: () => q, range: () => q, then: (r: any) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r) }; return q } }) }
  const orig = console.error
  console.error = () => {}
  try {
    assert.equal((await loadSkippedSources(errDb)).size, 0)
  } finally {
    console.error = orig
  }
})

test('loadClaimSourceIds maps claims to their distinct sources; skippedOnlyClaims hides only all-skipped claims', async () => {
  const members = [
    { claim_id: 'c1', raw_insight_id: 'i1', raw_insights: { source_id: 's1' } },
    { claim_id: 'c1', raw_insight_id: 'i2', raw_insights: { source_id: 's2' } },
    { claim_id: 'c2', raw_insight_id: 'i3', raw_insights: { source_id: 's1' } },
    { claim_id: 'c2', raw_insight_id: 'i4', raw_insights: { source_id: 'full' } },
    { claim_id: 'c3', raw_insight_id: 'i5', raw_insights: null },
  ]
  const { db } = builder(members)
  const map = await loadClaimSourceIds(db, ['c1', 'c2', 'c3'])
  assert.deepEqual(map.get('c1'), ['s1', 's2'])
  assert.equal(map.has('c3'), false)
  const { hidden } = await skippedOnlyClaims(builder(members).db, ['c1', 'c2', 'c3'], skipped)
  assert.deepEqual([...hidden], ['c1'])
})

test('skippedOnlyClaims does no lookup when nothing is skipped', async () => {
  const { db, calls } = builder([])
  const r = await skippedOnlyClaims(db, ['c1'], new Map())
  assert.equal(r.hidden.size, 0)
  assert.equal(calls.length, 0)
})

// ---- the plan for marking the four non-full Drive items -------------------------------------

const row = (id: string, title: string, status = 'pending'): SourceRowLite => ({ id, title, processing_status: status })
const library: SourceRowLite[] = [
  row('sen', 'The Ayrton Senna Episode (re-release): Celebrating the greatest driver', 'skipped'),
  row('f1', '#16 – Formula 1 (with Paul Conti): the best drivers, Ayrton Senna', 'succeeded'),
  row('oli', 'The one-year anniversary episode with Olivia Attia: Reflecting on the past year'),
  row('dax', 'Special episode with Dax Shepard: F1 and the 30th anniversary of Ayrton Senna’s death'),
  row('early', 'Introducing Early'),
]

test('the plan changes the pending rows and leaves the already-skipped one', () => {
  const plan = planNonFullSkips(NON_FULL_TARGETS, library)
  assert.deepEqual(plan.map(p => p.verdict), ['already-skipped', 'change', 'change', 'change'])
  assert.deepEqual(refusalReasons(plan), [])
  const writes = rowsToWrite(plan)
  assert.deepEqual(writes.map(w => w.id), ['oli', 'dax', 'early'])
  assert.ok(writes.every(w => w.skip_reason.startsWith('not a full episode')))
})

test('a title matching no row refuses the run', () => {
  const plan = planNonFullSkips(NON_FULL_TARGETS, library.filter(r => r.id !== 'dax'))
  assert.match(refusalReasons(plan)[0], /Special episode with Dax Shepard.*matched no row/)
})

test('a title matching two rows refuses the run', () => {
  const plan = planNonFullSkips(NON_FULL_TARGETS, [...library, row('early2', 'Introducing Early Birds')])
  assert.match(refusalReasons(plan)[0], /Introducing Early.*matched 2 rows/)
})

test('a row being processed is never written', () => {
  const plan = planNonFullSkips(NON_FULL_TARGETS, library.map(r => (r.id === 'early' ? { ...r, processing_status: 'processing' } : r)))
  assert.equal(plan[3].verdict, 'busy')
  assert.deepEqual(rowsToWrite(plan).map(w => w.id), ['oli', 'dax'])
})

test('matching is case-insensitive and by title start only', () => {
  const plan = planNonFullSkips([NON_FULL_TARGETS[3]], [row('x', 'introducing early'), row('y', 'Why Introducing Early matters')])
  assert.equal(plan[0].verdict, 'change')
  assert.equal(plan[0].matches[0].id, 'x')
})
