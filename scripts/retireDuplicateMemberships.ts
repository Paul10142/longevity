/**
 * Option (c) for an episode that is in the library twice with facts from BOTH copies:
 * remove the skipped copy's DUPLICATE citations and keep its solo facts.
 *
 *   npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --plan plan.json     # dry run (default): read-only
 *   npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --skipped <id> --kept <id>
 *   npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --plan plan.json --json out.json   # also write the claim-by-claim plan
 *   npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --plan plan.json --apply          # write (needs the writer free)
 *   npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --undo <backup.json> [--apply]    # put the citations back
 *
 * `plan.json` is the file `scripts/dedupLibrary.ts --json` writes: every change that
 * already has facts and points at the copy kept becomes one pair. Or name one pair with
 * `--skipped` / `--kept` (whole ids).
 *
 * WHAT THIS DOES (rules in lib/duplicateMemberships.ts). Per pair, every claim the skipped
 * copy feeds is one of:
 *   SHARED  the kept copy feeds it too: the same fact cited twice. The skipped copy's
 *           citations (claim_members rows) are deleted, the claim's counts are recomputed
 *           (lib/consolidation.ts recomputeAggregates), its wording is not touched.
 *   SOLO    only the skipped copy (or another episode) feeds it: left alone.
 * Never deleted: a claim, a raw insight, a source row. A claim is never left with no
 * member: each shared claim is re-read just before its delete, and skipped if it would end
 * up empty. Claims that are not active/approved are never changed.
 *
 * --apply refuses unless: the skipped row is `skipped` and its `duplicate_of` is the kept
 * copy (dedupLibrary.ts --apply has run), no pipeline job is running, no supervisor is
 * alive, and the writer lock is free (the same guard as dedupLibrary.ts). It writes a JSON
 * backup of every deleted row first; --undo re-inserts them (a row whose insight has been
 * attached to some other claim since is left alone). Idempotent: a second run finds no
 * shared claims left.
 *
 * Why the wording is not re-derived: both copies are the same recording, so the skipped
 * copy's facts are repeats, not corrections. (retireSourceClaims.ts re-derives because it
 * retires facts that may be WRONG.) Claims whose first-wording insight came from the
 * skipped copy are counted in the dry run so that can be reviewed.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planDuplicateMemberships, type MemberEdge, type MembershipPlan } from '../lib/duplicateMemberships'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const argAfter = (flag: string) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null }
const PLAN_FILE = argAfter('--plan')
const SKIPPED = argAfter('--skipped')
const KEPT = argAfter('--kept')
const JSON_OUT = argAfter('--json')
const UNDO = argAfter('--undo')
const BACKUP_DIR = process.env.DEDUP_BACKUP_DIR || 'scratchpad/backups'
const LIVE_STATUSES = ['active', 'approved']
const now = () => new Date().toISOString().slice(11, 19)
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const chunk = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

type Db = NonNullable<Awaited<typeof import('../lib/supabaseServer')>['supabaseAdmin']>
type Pair = { skippedId: string; keptId: string }
type SourceInfo = { id: string; title: string | null; processing_status: string | null; duplicate_of: string | null }
type MemberRow = { claim_id: string; raw_insight_id: string; match_confidence: number | null; matched_by: string | null; created_at: string }
type ClaimSnapshot = { id: string; status: string; member_count: number; source_count: number; max_importance: number | null; best_evidence_type: string | null }
type Loaded = { plan: MembershipPlan; statusOf: Map<string, string>; removedRows: MemberRow[]; before: ClaimSnapshot[]; skipped: SourceInfo | null; kept: SourceInfo | null }
type Backup = { made_at: string; pairs: { skippedId: string; keptId: string; rows: MemberRow[]; claims: ClaimSnapshot[] }[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  if (UNDO) return undo(db)

  const pairs = readPairs()
  if (pairs.length === 0) { console.log('No pairs: nothing to do.'); return }
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN (read-only)'} — ${pairs.length} pair(s)\n`)

  const loaded: Loaded[] = []
  for (const pair of pairs) {
    const l = await load(db, pair)
    loaded.push(l)
    report(l)
  }

  const t = {
    shared: loaded.reduce((n, l) => n + l.plan.shared.length, 0),
    remove: loaded.reduce((n, l) => n + l.plan.remove.length, 0),
    solo: loaded.reduce((n, l) => n + l.plan.solo.length, 0),
    drops: loaded.reduce((n, l) => n + l.plan.sourceCountDrops, 0),
    seeds: loaded.reduce((n, l) => n + l.plan.seedsRemoved, 0),
  }
  console.log(`TOTAL — ${t.remove} citations removed from ${t.shared} shared claims (${t.drops} of them drop from 2+ sources to fewer); ${t.solo} solo claims kept; ${t.seeds} shared claims lose their first-wording insight (wording stays).`)

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), pairs: loaded.map(l => l.plan) }, null, 2))
    console.log(`Full plan written to ${JSON_OUT}`)
  }

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply to write (needs the writer free and the skip marks applied).'); return }

  // ---- apply ------------------------------------------------------------------------------
  for (const l of loaded) {
    if (!l.skipped || l.skipped.processing_status !== 'skipped' || l.skipped.duplicate_of !== l.plan.keptId) {
      throw new Error(`refusing to apply: ${short(l.plan.skippedId)} is not marked skipped as a copy of ${short(l.plan.keptId)} (run dedupLibrary.ts --apply first)`)
    }
  }
  await assertWriterFree(db)
  const { recomputeAggregates } = await import('../lib/consolidation')

  mkdirSync(BACKUP_DIR, { recursive: true })
  const backupPath = join(BACKUP_DIR, `dup-members-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const backup: Backup = {
    made_at: new Date().toISOString(),
    pairs: loaded.map(l => ({ skippedId: l.plan.skippedId, keptId: l.plan.keptId, rows: l.removedRows, claims: l.before })),
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2))
  console.log(`\nBackup written: ${backupPath} (${backup.pairs.reduce((n, p) => n + p.rows.length, 0)} rows)`)

  let removed = 0
  let skippedClaims = 0
  for (const l of loaded) {
    for (const s of l.plan.shared) {
      // Re-read right before the delete: the claim must keep at least one member.
      const { data, error } = await db.from('claim_members').select('raw_insight_id').eq('claim_id', s.claim_id)
      if (error) throw new Error(`re-read ${s.claim_id} failed: ${error.message}`)
      const have = ((data ?? []) as { raw_insight_id: string }[]).map(r => r.raw_insight_id)
      const gone = new Set(s.remove)
      const toDelete = have.filter(id => gone.has(id))
      if (toDelete.length === 0) continue // already done
      if (have.length - toDelete.length < 1) { skippedClaims++; console.log(`  leave ${short(s.claim_id)} — it would be left with no member`); continue }
      const { error: delErr } = await db.from('claim_members').delete().eq('claim_id', s.claim_id).in('raw_insight_id', toDelete)
      if (delErr) throw new Error(`delete members of ${s.claim_id} failed: ${delErr.message}`)
      await recomputeAggregates(s.claim_id)
      removed += toDelete.length
    }
  }
  console.log(`\n[${now()}] DONE — ${removed} duplicate citations removed${skippedClaims ? `, ${skippedClaims} claims left alone` : ''}. No claim, fact or source row was deleted.`)
  console.log(`To reverse: npx tsx --env-file=.env.local scripts/retireDuplicateMemberships.ts --undo ${backupPath} --apply`)
}

function readPairs(): Pair[] {
  if (SKIPPED || KEPT) {
    if (!SKIPPED || !KEPT) throw new Error('--skipped and --kept go together')
    if (!UUID.test(SKIPPED) || !UUID.test(KEPT)) throw new Error('--skipped and --kept need whole ids (see dedupLibrary.ts --json)')
    return [{ skippedId: SKIPPED, keptId: KEPT }]
  }
  if (!PLAN_FILE || !existsSync(PLAN_FILE)) throw new Error('give --plan <dedupLibrary --json file> or --skipped <id> --kept <id>')
  const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as { changes?: { id: string; duplicate_of: string | null; facts?: number }[] }
  const seen = new Set<string>()
  const out: Pair[] = []
  for (const c of plan.changes ?? []) {
    if (!c.duplicate_of || !(c.facts && c.facts > 0) || seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ skippedId: c.id, keptId: c.duplicate_of })
  }
  return out
}

/** Everything the planner needs for one pair, read-only. */
async function load(db: Db, pair: Pair): Promise<Loaded> {
  const { selectAllPaged } = await import('../lib/pagination')
  const fail = (what: string, error: { message: string } | null) => { if (error) throw new Error(`${what} failed: ${error.message}`) }

  const sourceInfo = async (id: string): Promise<SourceInfo | null> => {
    let res = await db.from('sources').select('id, title, processing_status, duplicate_of').eq('id', id).maybeSingle()
    if (res.error && /duplicate_of|column/i.test(res.error.message)) res = await db.from('sources').select('id, title, processing_status').eq('id', id).maybeSingle() as typeof res
    fail(`source ${id}`, res.error)
    const row = res.data as Partial<SourceInfo> | null
    return row ? { id: row.id as string, title: row.title ?? null, processing_status: row.processing_status ?? null, duplicate_of: row.duplicate_of ?? null } : null
  }
  const skipped = await sourceInfo(pair.skippedId)
  const kept = await sourceInfo(pair.keptId)
  if (!skipped) throw new Error(`no source row ${pair.skippedId}`)
  if (!kept) throw new Error(`no source row ${pair.keptId}`)

  const insights = await selectAllPaged<{ id: string }>((from, to) =>
    db.from('raw_insights').select('id').eq('source_id', pair.skippedId).order('id').range(from, to)
  )
  const skippedInsightIds = insights.map(r => r.id)

  // The claim each skipped insight sits in (raw_insight_id is unique in claim_members).
  const claimIds = new Set<string>()
  for (const ids of chunk(skippedInsightIds, 200)) {
    const { data, error } = await db.from('claim_members').select('claim_id').in('raw_insight_id', ids)
    fail('claim_members of the skipped copy', error)
    for (const r of (data ?? []) as { claim_id: string }[]) claimIds.add(r.claim_id)
  }
  const claimList = [...claimIds].sort()

  // EVERY member of those claims, and the source each member's insight belongs to.
  const members: MemberRow[] = []
  for (const ids of chunk(claimList, 40)) {
    members.push(...await selectAllPaged<MemberRow>((from, to) =>
      db.from('claim_members').select('claim_id, raw_insight_id, match_confidence, matched_by, created_at').in('claim_id', ids).order('claim_id').order('raw_insight_id').range(from, to)
    ))
  }
  const sourceOfInsight = new Map<string, string>()
  const memberInsightIds = [...new Set(members.map(m => m.raw_insight_id))]
  for (const ids of chunk(memberInsightIds, 200)) {
    const { data, error } = await db.from('raw_insights').select('id, source_id').in('id', ids)
    fail('raw_insights of the members', error)
    for (const r of (data ?? []) as { id: string; source_id: string }[]) sourceOfInsight.set(r.id, r.source_id)
  }
  const edges: MemberEdge[] = members.map(m => ({
    claim_id: m.claim_id,
    raw_insight_id: m.raw_insight_id,
    source_id: sourceOfInsight.get(m.raw_insight_id) ?? 'unknown',
    matched_by: m.matched_by,
  }))

  const snapshots: ClaimSnapshot[] = []
  for (const ids of chunk(claimList, 100)) {
    const { data, error } = await db.from('claims').select('id, status, member_count, source_count, max_importance, best_evidence_type').in('id', ids)
    fail('claims', error)
    snapshots.push(...((data ?? []) as ClaimSnapshot[]))
  }
  const statusOf = new Map(snapshots.map(c => [c.id, c.status]))
  const active = new Set(snapshots.filter(c => LIVE_STATUSES.includes(c.status)).map(c => c.id))

  const plan = planDuplicateMemberships({ skippedId: pair.skippedId, keptId: pair.keptId, skippedInsightIds, edges, activeClaimIds: active })
  const remove = new Set(plan.remove.map(r => `${r.claim_id}|${r.raw_insight_id}`))
  const removedRows = members.filter(m => remove.has(`${m.claim_id}|${m.raw_insight_id}`))
  const touched = new Set(plan.shared.map(s => s.claim_id))
  return { plan, statusOf, removedRows, before: snapshots.filter(c => touched.has(c.id)), skipped, kept }
}

function report(l: Loaded) {
  const p = l.plan
  console.log(`PAIR  skipped ${short(p.skippedId)} "${clip(l.skipped?.title ?? '', 70)}" [${l.skipped?.processing_status}${l.skipped?.duplicate_of ? ` → ${short(l.skipped.duplicate_of)}` : ''}]`)
  console.log(`      kept    ${short(p.keptId)} "${clip(l.kept?.title ?? '', 70)}" [${l.kept?.processing_status}]`)
  console.log(`      the skipped copy has ${p.insights} facts; ${p.attached} sit in claims`)
  console.log(`      SHARED claims (kept copy also feeds them): ${p.shared.length} → ${p.remove.length} citations removed, ${p.sourceCountDrops} drop from 2+ sources to fewer, ${p.seedsRemoved} lose their first-wording insight`)
  console.log(`      SOLO claims (only the skipped copy or another episode): ${p.solo.length} → kept (${p.solo.filter(s => s.otherMembers > 0).length} are also cited by another episode)`)
  const byStatus = new Map<string, number>()
  for (const st of l.statusOf.values()) if (!LIVE_STATUSES.includes(st) && p.attached > 0) byStatus.set(st, (byStatus.get(st) ?? 0) + 1)
  if (p.inactiveClaims > 0) console.log(`      claims left alone because they are not active/approved: ${p.inactiveClaims} (${[...byStatus].map(([s, n]) => `${n} ${s}`).join(', ') || 'unknown'})`)
  console.log(`      after: ${p.attached - p.remove.length} of the skipped copy's facts are still cited by a claim; ${p.remove.length} duplicate citations are gone`)
  console.log('')
}

async function assertWriterFree(db: Db) {
  const { data: running } = await db
    .from('jobs')
    .select('id, type')
    .eq('status', 'running')
    .gt('locked_at', new Date(Date.now() - 10 * 60_000).toISOString())
  const runningJobs = (running ?? []) as { id: string; type: string }[]
  if (runningJobs.length > 0) {
    throw new Error(`refusing to apply: ${runningJobs.length} pipeline job(s) running (${runningJobs.map(r => r.type).join(', ')})`)
  }
  const procs = execSync('ps -eo command', { encoding: 'utf8' })
    .split('\n')
    .filter(l => /extractDeepgram|overnightExtract|scripts\/pipeline\.ts|sweepCorpus|extract_with_fidelity/.test(l) && !/grep/.test(l))
  if (procs.length > 0) throw new Error(`refusing to apply: a supervisor is running:\n${procs.join('\n')}`)
  const { acquireWriterLock } = await import('../lib/writerLock')
  acquireWriterLock('retireDuplicateMemberships')
}

/** Put deleted citations back, unless their insight has been attached to a claim since. */
async function undo(db: Db) {
  if (!UNDO || !existsSync(UNDO)) throw new Error(`--undo needs the path of a dup-members-*.json backup (got ${UNDO ?? 'nothing'})`)
  const backup = JSON.parse(readFileSync(UNDO, 'utf8')) as Backup
  const total = backup.pairs.reduce((n, p) => n + p.rows.length, 0)
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — undo ${UNDO}: ${total} citations (made ${backup.made_at})`)
  if (APPLY) await assertWriterFree(db)
  const { recomputeAggregates } = await import('../lib/consolidation')
  let restored = 0
  let left = 0
  const touched = new Set<string>()
  for (const p of backup.pairs) {
    for (const r of p.rows) {
      const { data } = await db.from('claim_members').select('claim_id').eq('raw_insight_id', r.raw_insight_id).maybeSingle()
      if (data) { left++; console.log(`  leave  ${short(r.raw_insight_id)} — it is cited by a claim again already`); continue }
      const { data: claim } = await db.from('claims').select('id').eq('id', r.claim_id).maybeSingle()
      if (!claim) { left++; console.log(`  leave  ${short(r.raw_insight_id)} — claim ${short(r.claim_id)} no longer exists`); continue }
      if (APPLY) {
        const { error } = await db.from('claim_members').insert({ claim_id: r.claim_id, raw_insight_id: r.raw_insight_id, match_confidence: r.match_confidence, matched_by: r.matched_by, created_at: r.created_at })
        if (error) throw new Error(`restore ${r.raw_insight_id} failed: ${error.message}`)
        touched.add(r.claim_id)
      }
      restored++
    }
  }
  if (APPLY) {
    for (const id of touched) await recomputeAggregates(id)
  }
  console.log(`\n[${now()}] ${APPLY ? 'DONE' : 'DRY RUN — nothing written'} — ${restored} citations ${APPLY ? 'restored' : 'would be restored'}, ${left} left alone`)
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
