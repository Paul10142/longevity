import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  InterruptedAttemptError, applyPlan, assertNoInterruptedAttempt, buildPlan, latestBackupFor, outstanding,
  progressPathFor, readBackup, readProgress, resumeCommand, writeBackup,
  type ClaimState, type InsightRow, type MemberRow, type RetireStore, type RowAction, type SourceState, type Src, type Survivor,
} from '../lib/retireSource'

// ---- an in-memory database with fault injection ----------------------------------
// Every write call is numbered; the fault cuts the connection before (the write never
// happened) or after (it happened, the client never heard back) write number `at`.

type Fault = { at: number; mode: 'before' | 'after' } | null
type Claim = { status: string; canonical: string; context_note: string | null; member_count: number; source_count: number; needs_tagging: boolean }
type Ins = InsightRow & { source_id: string }

class FakeDb {
  sources = new Map<string, { id: string; origin: string; status: string; transcript: string | null; error: string | null }>()
  insights: Ins[] = []
  chunks = new Map<string, number>()
  members: MemberRow[] = []
  claims = new Map<string, Claim>()
  vectors = new Map<string, string>()
  reviews = new Map<string, { claim_id: string; candidate_claim_id: string; status: string; decided_by: string | null }>()
  writes: string[] = [] // labels of every write attempted, in order
  fault: Fault = null

  snapshot() {
    return JSON.stringify({
      sources: [...this.sources.entries()].sort(),
      insights: this.insights.map(i => i.id).sort(),
      chunks: [...this.chunks.entries()].sort(),
      members: this.members.map(m => `${m.claim_id}|${m.raw_insight_id}`).sort(),
      claims: [...this.claims.entries()].sort(),
      vectors: [...this.vectors.entries()].sort(),
      reviews: [...this.reviews.entries()].sort(),
    })
  }
  memberRowsOf(claimId: string) { return this.members.filter(m => m.claim_id === claimId) }
}

/** Label -> procedure step, so tests can say "cut after step 3". */
const STEP_OF: Record<string, number> = {
  deleteMembersOf: 1, retireClaims: 2, 'rederive:reseed': 3, 'rederive:aggregates': 3, 'rederive:enrich': 3, 'rederive:vector': 3,
  closeReviews: 4, deleteInsightsOf: 5, deleteChunksOf: 5, deleteSourceRow: 5, clearSourceRow: 5,
}

function storeOf(db: FakeDb): RetireStore {
  const write = async (label: string, fn: () => void) => {
    db.writes.push(label)
    const n = db.writes.length
    if (db.fault?.at === n && db.fault.mode === 'before') throw new Error('connection lost')
    fn()
    if (db.fault?.at === n && db.fault.mode === 'after') throw new Error('connection lost')
  }
  const refresh = (claimId: string) => {
    const c = db.claims.get(claimId)!
    const rows = db.memberRowsOf(claimId)
    c.member_count = rows.length
    c.source_count = new Set(rows.map(r => db.insights.find(i => i.id === r.raw_insight_id)!.source_id)).size
  }
  const survivorsOf = (claimId: string, except: string): Survivor[] =>
    db.memberRowsOf(claimId)
      .map(m => db.insights.find(i => i.id === m.raw_insight_id))
      .filter((i): i is Ins => !!i && i.source_id !== except)
      .map(i => ({ raw_insight_id: i.id, source_id: i.source_id, statement: i.statement, context_note: i.context_note, created_at: i.created_at }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  return {
    async countMembersOf(ids) { return db.members.filter(m => ids.includes(m.raw_insight_id)).length },
    async claimStates(ids): Promise<ClaimState[]> {
      return ids.filter(id => db.claims.has(id)).map(id => {
        const c = db.claims.get(id)!
        return { id, status: c.status, member_count: c.member_count, source_count: c.source_count, hasVector: db.vectors.has(id), members: db.memberRowsOf(id).length }
      })
    },
    async survivors(claimId, except) { return survivorsOf(claimId, except) },
    async pendingReviewIds(ids) { return ids.filter(id => db.reviews.get(id)?.status === 'pending') },
    async pendingReviewsTouching(ids) {
      return [...db.reviews.entries()].filter(([, r]) => r.status === 'pending' && (ids.includes(r.claim_id) || ids.includes(r.candidate_claim_id))).map(([id]) => id)
    },
    async sourceState(id): Promise<SourceState> {
      const s = db.sources.get(id)
      const insights = db.insights.filter(i => i.source_id === id).length
      const chunks = db.chunks.get(id) ?? 0
      if (!s) return { exists: false, origin: null, insights, chunks, cleared: false }
      return { exists: true, origin: s.origin, insights, chunks, cleared: s.transcript === null && s.status === 'pending' && s.error === null }
    },
    async existingInsightIds(ids) { return db.insights.filter(i => ids.includes(i.id)).map(i => i.id) },
    async membersOf(ids) { return db.members.filter(m => ids.includes(m.raw_insight_id)).map(m => ({ claim_id: m.claim_id, raw_insight_id: m.raw_insight_id })) },
    async listInsights(sourceId) { return db.insights.filter(i => i.source_id === sourceId).sort((a, b) => a.id.localeCompare(b.id)).map(({ source_id: _s, ...i }) => i) },
    async membersFull(ids) { return db.members.filter(m => ids.includes(m.raw_insight_id)) },
    async claimsSnapshot(ids) { return ids.map(id => ({ id, ...db.claims.get(id) })) },

    async deleteMembersOf(ids) { await write('deleteMembersOf', () => { db.members = db.members.filter(m => !ids.includes(m.raw_insight_id)) }) },
    async retireClaims(ids) {
      await write('retireClaims', () => {
        for (const id of ids) {
          const c = db.claims.get(id)
          if (c) { c.status = 'retired'; c.member_count = 0; c.source_count = 0 }
          db.vectors.delete(id)
        }
      })
    },
    async rederiveClaim(claimId, seed) {
      await write('rederive:reseed', () => { const c = db.claims.get(claimId)!; c.canonical = seed.statement; c.context_note = seed.context_note; c.needs_tagging = true })
      await write('rederive:aggregates', () => refresh(claimId))
      const derived = () => {
        const rows = db.memberRowsOf(claimId).map(m => db.insights.find(i => i.id === m.raw_insight_id)!).sort((a, b) => a.created_at.localeCompare(b.created_at))
        return rows.map(r => r.statement).join(' + ')
      }
      await write('rederive:enrich', () => { db.claims.get(claimId)!.canonical = derived() })
      await write('rederive:vector', () => { db.vectors.set(claimId, `vec(${db.claims.get(claimId)!.canonical})`) })
    },
    async closeReviews(ids) {
      await write('closeReviews', () => {
        for (const id of ids) { const r = db.reviews.get(id); if (r && r.status === 'pending') { r.status = 'rejected'; r.decided_by = 'retired-source' } }
      })
    },
    async deleteInsightsOf(sourceId) {
      await write('deleteInsightsOf', () => {
        const gone = new Set(db.insights.filter(i => i.source_id === sourceId).map(i => i.id))
        db.insights = db.insights.filter(i => i.source_id !== sourceId)
        db.members = db.members.filter(m => !gone.has(m.raw_insight_id))
      })
    },
    async deleteChunksOf(sourceId) { await write('deleteChunksOf', () => { db.chunks.delete(sourceId) }) },
    async deleteSourceRow(sourceId) { await write('deleteSourceRow', () => { db.sources.delete(sourceId) }) },
    async clearSourceRow(sourceId) {
      await write('clearSourceRow', () => { const s = db.sources.get(sourceId)!; s.transcript = null; s.status = 'pending'; s.error = null })
    },
  }
}

// ---- the fixture -------------------------------------------------------------------
// Caption source S has six facts. c1, c2, c5 hold only S's facts (retire); c3 and c4 also
// hold Deepgram facts (re-derive); c6 is unrelated. r1/r3 touch retired claims, r2 does not.

const S: Src = { id: 'S', title: '12 - Caption episode', external_id: null, episode_number: 12, transcript_origin: 'other', processing_status: 'succeeded' }
const iso = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

function fixture(): FakeDb {
  const db = new FakeDb()
  db.sources.set('S', { id: 'S', origin: 'other', status: 'succeeded', transcript: 'caption text', error: null })
  db.sources.set('G', { id: 'G', origin: 'deepgram', status: 'succeeded', transcript: 'good text', error: null })
  const ins = (id: string, source_id: string, n: number): Ins => ({ id, source_id, statement: `fact ${id}`, context_note: null, direct_quote: null, chunk_id: null, created_at: iso(n) })
  db.insights = [ins('i1', 'S', 1), ins('i2', 'S', 2), ins('i3', 'S', 3), ins('i4', 'S', 4), ins('i5', 'S', 5), ins('i6', 'S', 6),
    ins('g1', 'G', 10), ins('g2', 'G', 11), ins('g3', 'G', 12), ins('g4', 'G', 13)]
  const link = (claim_id: string, raw_insight_id: string): MemberRow => ({ claim_id, raw_insight_id, matched_by: 'auto', match_confidence: 0.9 })
  db.members = [link('c1', 'i1'), link('c2', 'i2'), link('c2', 'i3'), link('c3', 'i4'), link('c3', 'g1'),
    link('c4', 'i5'), link('c4', 'g2'), link('c4', 'g3'), link('c5', 'i6'), link('c6', 'g4')]
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
    db.claims.set(id, { status: 'active', canonical: `old text of ${id} (caption-tainted)`, context_note: null, member_count: 0, source_count: 0, needs_tagging: false })
    db.vectors.set(id, `old vector of ${id}`)
  }
  for (const id of db.claims.keys()) {
    const rows = db.memberRowsOf(id)
    const c = db.claims.get(id)!
    c.member_count = rows.length
    c.source_count = new Set(rows.map(r => db.insights.find(i => i.id === r.raw_insight_id)!.source_id)).size
  }
  db.chunks.set('S', 3)
  db.reviews.set('r1', { claim_id: 'c1', candidate_claim_id: 'c6', status: 'pending', decided_by: null })
  db.reviews.set('r2', { claim_id: 'c3', candidate_claim_id: 'c6', status: 'pending', decided_by: null })
  db.reviews.set('r3', { claim_id: 'c2', candidate_claim_id: 'c5', status: 'pending', decided_by: null })
  return db
}

const dirs: string[] = []
function tmp() { const d = mkdtempSync(path.join(tmpdir(), 'retire-test-')); dirs.push(d); return d }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const OPTS = { chunkSize: 2 } // three unhook writes, so a cut can land mid-unhook

async function plannedBackup(db: FakeDb, rowAction: RowAction, dir: string) {
  const plan = await buildPlan(storeOf(db), S, null, rowAction)
  const backupPath = writeBackup(dir, plan)
  return { plan, backupPath }
}

/** The end state of an uninterrupted run, and how many write calls it takes. */
async function reference(rowAction: RowAction) {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, rowAction, tmp())
  await applyPlan(storeOf(db), plan, { ...OPTS, backupPath })
  return { snapshot: db.snapshot(), writes: db.writes.length, labels: [...db.writes] }
}

// ---- the plan itself ---------------------------------------------------------------

test('the plan separates emptied claims, mixed claims and reviews', async () => {
  const plan = await buildPlan(storeOf(fixture()), S, null, 'delete')
  assert.deepEqual([...plan.retireIds].sort(), ['c1', 'c2', 'c5'])
  assert.deepEqual(plan.rederive.map(r => r.claimId).sort(), ['c3', 'c4'])
  assert.equal(plan.rederive.find(r => r.claimId === 'c4')!.seed.raw_insight_id, 'g2') // oldest survivor
  assert.deepEqual([...plan.reviewIds].sort(), ['r1', 'r3'])
})

test('an uninterrupted run reaches the expected end state', async () => {
  for (const rowAction of ['delete', 'clear'] as RowAction[]) {
    const db = fixture()
    const { plan, backupPath } = await plannedBackup(db, rowAction, tmp())
    const counts = await applyPlan(storeOf(db), plan, { ...OPTS, backupPath })
    assert.equal(counts.retired, 3)
    assert.equal(counts.rederived, 2)
    assert.equal(counts.reviewsClosed, 2)
    for (const id of ['c1', 'c2', 'c5']) {
      assert.equal(db.claims.get(id)!.status, 'retired')
      assert.equal(db.vectors.has(id), false)
    }
    assert.equal(db.claims.get('c3')!.canonical, 'fact g1')
    assert.equal(db.claims.get('c4')!.canonical, 'fact g2 + fact g3')
    assert.equal(db.vectors.get('c4'), 'vec(fact g2 + fact g3)')
    assert.equal(db.reviews.get('r1')!.status, 'rejected')
    assert.equal(db.reviews.get('r2')!.status, 'pending') // not on a retired claim
    assert.equal(db.insights.filter(i => i.source_id === 'S').length, 0)
    assert.equal(db.chunks.has('S'), false)
    if (rowAction === 'delete') assert.equal(db.sources.has('S'), false)
    else assert.equal(db.sources.get('S')!.status, 'pending')
    assert.equal(readProgress(backupPath)!.complete, true)
  }
})

// ---- the failure this work exists for ------------------------------------------------

test('the old behaviour: re-planning after step 1 plans nothing (why a plain re-run must refuse)', async () => {
  const db = fixture()
  const { plan } = await plannedBackup(db, 'delete', tmp())
  await storeOf(db).deleteMembersOf(plan.insights.map(i => i.id)) // step 1, then the connection drops
  const replan = await buildPlan(storeOf(db), S, null, 'delete')
  assert.equal(replan.retireIds.length, 0)
  assert.equal(replan.rederive.length, 0)
})

// ---- cut at every write, resume, compare -----------------------------------------------

for (const rowAction of ['delete', 'clear'] as RowAction[]) {
  for (const mode of ['before', 'after'] as const) {
    test(`cut at EVERY write (${mode} it lands, row ${rowAction}): --resume reaches the uninterrupted end state`, async () => {
      const ref = await reference(rowAction)
      assert.ok(ref.writes > 10)
      for (let at = 1; at <= ref.writes; at++) {
        const db = fixture()
        const dir = tmp()
        const { plan, backupPath } = await plannedBackup(db, rowAction, dir)
        db.fault = { at, mode }
        await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }), /connection lost/, `cut #${at}`)
        db.fault = null

        // a plain re-run is refused while the source row is still there
        const sourceStillThere = db.sources.has('S')
        if (sourceStillThere) {
          await assert.rejects(assertNoInterruptedAttempt(storeOf(db), dir, 'S'), (e: unknown) => {
            assert.ok(e instanceof InterruptedAttemptError)
            assert.ok(e.message.includes(backupPath), 'names the backup')
            assert.ok(e.message.includes(resumeCommand(backupPath)), 'names the exact resume command')
            return true
          }, `cut #${at}`)
        }

        // resume from the file on disk, as a fresh process would
        await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
        assert.equal(db.snapshot(), ref.snapshot, `cut #${at} (${mode}) differs from the uninterrupted run`)
        assert.equal(readProgress(backupPath)!.complete, true)

        // a second resume is a no-op: zero write calls, same state
        const before = db.writes.length
        await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
        assert.equal(db.writes.length, before, `cut #${at}: double resume wrote ${db.writes.slice(before).join(',')}`)
        assert.equal(db.snapshot(), ref.snapshot)

        // and once finished, planning afresh is no longer refused
        await assertNoInterruptedAttempt(storeOf(db), dir, 'S')
      }
    })
  }
}

test('cut after each of steps 1–5, then --resume (named cases)', async () => {
  const ref = await reference('delete')
  const lastOfStep = (k: number) => ref.labels.reduce((acc, l, i) => (STEP_OF[l] === k ? i + 1 : acc), 0)
  for (let step = 1; step <= 5; step++) {
    const db = fixture()
    const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
    db.fault = { at: lastOfStep(step), mode: 'after' }
    await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }), /connection lost/)
    db.fault = null
    const doneLabels = db.writes.map(l => STEP_OF[l])
    assert.equal(Math.max(...doneLabels), step, `cut landed after step ${step}`)
    await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
    assert.equal(db.snapshot(), ref.snapshot, `after step ${step}`)
    const n = db.writes.length
    await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
    assert.equal(db.writes.length, n, `double resume after step ${step}`)
  }
})

test('the resume itself can be cut and resumed again', async () => {
  const ref = await reference('delete')
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  db.fault = { at: 3, mode: 'after' } // mid-unhook
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  for (let extra = 2; extra <= 40; extra += 3) {
    db.fault = { at: db.writes.length + extra, mode: extra % 2 ? 'before' : 'after' }
    try { await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath }); break } catch { /* cut again */ }
  }
  db.fault = null
  await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.equal(db.snapshot(), ref.snapshot)
})

test('a resume does not repeat re-derives that already finished (the slow, model-call step)', async () => {
  const probe = fixture()
  const { plan: p2, backupPath: b2 } = await plannedBackup(probe, 'delete', tmp())
  await applyPlan(storeOf(probe), p2, { ...OPTS, backupPath: b2 })
  const secondReseed = probe.writes.indexOf('rederive:reseed', probe.writes.indexOf('rederive:reseed') + 1) + 1

  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  db.fault = { at: secondReseed, mode: 'before' } // the first claim is fully re-derived, the second not started
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  assert.equal(readProgress(backupPath)!.rederived.length, 1)
  const mark = db.writes.length
  await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.equal(db.writes.slice(mark).filter(l => l === 'rederive:reseed').length, 1, 'only the second claim is re-derived on resume')
})

// ---- the refusal on a plain re-run -----------------------------------------------------

test('refuses a plain re-run after a cut in the middle of the unhook, even with no progress file', async () => {
  const db = fixture()
  const dir = tmp()
  const { plan, backupPath } = await plannedBackup(db, 'delete', dir)
  unlinkSync(progressPathFor(backupPath)) // a backup written by the previous version of the script
  db.fault = { at: 1, mode: 'after' } // first of three unhook chunks done, then the connection drops
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  await assert.rejects(assertNoInterruptedAttempt(storeOf(db), dir, 'S'), /--resume [\s\S]*retire-S-[\s\S]*\.json --apply/)
})

test('does not refuse when nothing was ever started, or for a different source', async () => {
  const db = fixture()
  const dir = tmp()
  await assertNoInterruptedAttempt(storeOf(db), dir, 'S') // no backup at all
  const { backupPath } = await plannedBackup(db, 'delete', dir)
  unlinkSync(progressPathFor(backupPath))
  await assertNoInterruptedAttempt(storeOf(db), dir, 'S') // backup exists, every link still in place
  await assertNoInterruptedAttempt(storeOf(db), dir, 'OTHER')
})

test('latestBackupFor ignores progress files and picks the newest backup', async () => {
  const db = fixture()
  const dir = tmp()
  const plan = await buildPlan(storeOf(db), S, null, 'delete')
  writeBackup(dir, plan, '2026-10-16T01-00-00-000Z')
  const newest = writeBackup(dir, plan, '2026-10-16T02-00-00-000Z')
  assert.equal(latestBackupFor(dir, 'S'), newest)
})

// ---- safety rails ------------------------------------------------------------------------

test('a resume never wipes a row that was replaced by its Deepgram transcript in the meantime', async () => {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'clear', tmp())
  db.fault = { at: 5, mode: 'after' } // somewhere before step 5
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  // meanwhile the row got its Deepgram transcript and new facts
  const s = db.sources.get('S')!
  s.origin = 'deepgram'; s.transcript = 'deepgram text'; s.status = 'succeeded'
  db.insights.push({ id: 'new1', source_id: 'S', statement: 'deepgram fact', context_note: null, direct_quote: null, chunk_id: null, created_at: iso(99) })
  db.chunks.set('S', 7)
  const counts = await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.equal(counts.rowAction, 'skipped-replaced')
  assert.equal(db.sources.get('S')!.transcript, 'deepgram text')
  assert.equal(db.insights.some(i => i.id === 'new1'), true)
  assert.equal(db.chunks.get('S'), 7)
  for (const id of ['c1', 'c2', 'c5']) assert.equal(db.claims.get(id)!.status, 'retired') // steps 2–4 still finished
})

test('a claim whose survivors have all gone since the plan is retired, not re-seeded', async () => {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  db.fault = { at: 4, mode: 'after' } // after step 1
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  // c3's only good fact g1 disappears (e.g. its source was retired)
  db.insights = db.insights.filter(i => i.id !== 'g1')
  db.members = db.members.filter(m => m.raw_insight_id !== 'g1')
  db.reviews.set('r4', { claim_id: 'c3', candidate_claim_id: 'c6', status: 'pending', decided_by: null })
  const counts = await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.equal(counts.rederiveRetired, 1)
  assert.equal(db.claims.get('c3')!.status, 'retired')
  assert.equal(db.vectors.has('c3'), false)
  assert.equal(db.reviews.get('r2')!.status, 'rejected') // pending reviews on the late-retired claim are closed too
  assert.equal(db.reviews.get('r4')!.status, 'rejected')
})

test('a review decided by a human in the meantime is not overwritten', async () => {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  db.fault = { at: 4, mode: 'after' }
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  db.reviews.get('r1')!.status = 'accepted'; db.reviews.get('r1')!.decided_by = 'paul'
  await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.deepEqual(db.reviews.get('r1'), { claim_id: 'c1', candidate_claim_id: 'c6', status: 'accepted', decided_by: 'paul' })
})

test('a claim planned for retirement that has gained members is left alone and reported', async () => {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  db.fault = { at: 3, mode: 'after' } // after the last unhook chunk, before retire
  await assert.rejects(applyPlan(storeOf(db), plan, { ...OPTS, backupPath }))
  db.fault = null
  db.members.push({ claim_id: 'c1', raw_insight_id: 'g4x', matched_by: 'auto', match_confidence: 1 })
  db.insights.push({ id: 'g4x', source_id: 'G', statement: 'late fact', context_note: null, direct_quote: null, chunk_id: null, created_at: iso(50) })
  const counts = await applyPlan(storeOf(db), readBackup(backupPath), { ...OPTS, backupPath })
  assert.equal(counts.retireBlocked, 1)
  assert.equal(db.claims.get('c1')!.status, 'active')
})

test('the dry-run view (outstanding) reports exactly what is left, and nothing after completion', async () => {
  const db = fixture()
  const { plan, backupPath } = await plannedBackup(db, 'delete', tmp())
  const full = await outstanding(storeOf(db), plan, readProgress(backupPath))
  assert.equal(full.members, 6)
  assert.equal(full.retireTodo.length, 3)
  assert.equal(full.rederiveTodo.length, 2)
  assert.equal(full.reviewsTodo.length, 2)
  const writesBefore = db.writes.length
  await applyPlan(storeOf(db), plan, { ...OPTS, backupPath })
  const empty = await outstanding(storeOf(db), plan, readProgress(backupPath))
  assert.equal(empty.members, 0)
  assert.equal(empty.retireTodo.length, 0)
  assert.equal(empty.rederiveTodo.length, 0)
  assert.equal(empty.reviewsTodo.length, 0)
  assert.equal(empty.source.exists, false)
  assert.ok(db.writes.length > writesBefore)
})
