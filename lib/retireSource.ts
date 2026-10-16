/**
 * Replace-a-caption-source logic (docs/caption-retirement-plan.md §3), split out
 * of scripts/retireSourceClaims.ts so it can be tested against a stub database
 * and resumed after an interruption.
 *
 * Why this exists (Paul, 2026-10-16): the laptop will lose its connection
 * mid-run. The original script planned steps 2–4 from the CURRENT claim_members,
 * so a re-run after step 1 (unhook) found no members, planned nothing, and left
 * the emptied claims active and the mixed claims un-rebuilt. Now:
 *
 *  - the plan (retireIds / rederive / reviewIds) is fixed once, in the JSON
 *    backup, and `applyPlan` re-applies steps 1–6 from that plan;
 *  - every step first reads what is still outstanding and writes only that, so
 *    a repeat is a no-op (a second resume makes zero write calls);
 *  - re-derive progress is checkpointed claim by claim in a sidecar file, so a
 *    resume does not repeat the slow (model-call) rebuilds that already finished;
 *  - a plain re-run on a source with an interrupted attempt is refused, naming
 *    the backup and the exact --resume command.
 *
 * All database access goes through `RetireStore` (lib/retireSourceStore.ts is
 * the Supabase implementation). This module imports neither supabase nor a model.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export type Src = {
  id: string
  title: string
  external_id: string | null
  episode_number: number | null
  transcript_origin: string
  processing_status: string
}
export type RowAction = 'delete' | 'clear'
export type InsightRow = { id: string; statement: string; context_note: string | null; direct_quote: string | null; chunk_id: string | null; created_at: string }
export type MemberRow = { claim_id: string; raw_insight_id: string; matched_by: string; match_confidence: number | null }
export type Survivor = { raw_insight_id: string; source_id: string; statement: string; context_note: string | null; created_at: string }
export type RederiveItem = { claimId: string; seed: Survivor; survivors: number }

/** The fixed plan for one source. This is exactly what the JSON backup holds. */
export type Plan = {
  source: Src
  twinId: string | null
  rowAction: RowAction
  insights: InsightRow[]
  members: MemberRow[]
  claimsBefore: unknown[]
  retireIds: string[]
  rederive: RederiveItem[]
  reviewIds: string[]
}

export type ClaimState = {
  id: string
  status: string
  member_count: number
  source_count: number
  hasVector: boolean
  /** Actual claim_members rows (not the cached column). */
  members: number
}
export type SourceState = {
  exists: boolean
  origin: string | null
  insights: number
  chunks: number
  /** transcript/timed_transcript null, pending, no error — only meaningful when `exists`. */
  cleared: boolean
}

/** Everything the procedure needs from the database. Writes must be idempotent. */
export interface RetireStore {
  // ---- reads ----
  /** Count claim_members rows attached to these raw_insights. */
  countMembersOf(insightIds: string[]): Promise<number>
  claimStates(claimIds: string[]): Promise<ClaimState[]>
  /** Members of a claim, minus those from `exceptSourceId`, oldest first. */
  survivors(claimId: string, exceptSourceId: string): Promise<Survivor[]>
  /** Ids (among `reviewIds`) still pending. */
  pendingReviewIds(reviewIds: string[]): Promise<string[]>
  /** Pending reviews touching any of these claims (either side). */
  pendingReviewsTouching(claimIds: string[]): Promise<string[]>
  sourceState(sourceId: string): Promise<SourceState>
  /** Of these raw_insight ids, which still exist? */
  existingInsightIds(insightIds: string[]): Promise<string[]>
  /** claim_members pairs present for these raw_insight ids (used by the interrupted-attempt check). */
  membersOf(insightIds: string[]): Promise<{ claim_id: string; raw_insight_id: string }[]>
  // ---- planning reads ----
  listInsights(sourceId: string): Promise<InsightRow[]>
  membersFull(insightIds: string[]): Promise<MemberRow[]>
  claimsSnapshot(claimIds: string[]): Promise<unknown[]>
  // ---- writes (idempotent) ----
  deleteMembersOf(insightIds: string[]): Promise<void>
  retireClaims(claimIds: string[]): Promise<void> // status retired, counts 0, vector deleted
  /** Reset canonical to the seed, recompute aggregates, enrich under the fidelity guard, refresh the vector. */
  rederiveClaim(claimId: string, seed: Survivor): Promise<void>
  closeReviews(reviewIds: string[]): Promise<void> // pending → rejected, decided_by 'retired-source'
  deleteInsightsOf(sourceId: string): Promise<void>
  deleteChunksOf(sourceId: string): Promise<void>
  deleteSourceRow(sourceId: string): Promise<void>
  clearSourceRow(sourceId: string): Promise<void>
}

// ---- backup + progress files ----------------------------------------------------

export type Progress = { startedAt: string; rederived: string[]; complete: boolean }

export function progressPathFor(backupPath: string): string {
  return backupPath.replace(/\.json$/, '.progress.json')
}

export function writeBackup(backupDir: string, plan: Plan, stamp = new Date().toISOString().replace(/[:.]/g, '-')): string {
  mkdirSync(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `retire-${plan.source.id}-${stamp}.json`)
  writeFileSync(backupPath, JSON.stringify(plan, null, 1))
  writeProgress(backupPath, { startedAt: new Date().toISOString(), rederived: [], complete: false })
  return backupPath
}

export function readBackup(backupPath: string): Plan {
  const plan = JSON.parse(readFileSync(backupPath, 'utf8')) as Plan
  for (const k of ['source', 'insights', 'members', 'retireIds', 'rederive', 'reviewIds'] as const) {
    if (plan[k] == null) throw new Error(`${backupPath} is not a retire backup (missing "${k}")`)
  }
  return plan
}

export function readProgress(backupPath: string): Progress | null {
  const p = progressPathFor(backupPath)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as Progress } catch { return null }
}

export function writeProgress(backupPath: string, progress: Progress): void {
  writeFileSync(progressPathFor(backupPath), JSON.stringify(progress))
}

/** Newest backup for a source, or null. Progress sidecars are not backups. */
export function latestBackupFor(backupDir: string, sourceId: string): string | null {
  if (!existsSync(backupDir)) return null
  const names = readdirSync(backupDir)
    .filter(n => n.startsWith(`retire-${sourceId}-`) && n.endsWith('.json') && !n.endsWith('.progress.json'))
    .sort()
  return names.length ? path.join(backupDir, names[names.length - 1]) : null
}

export function resumeCommand(backupPath: string): string {
  return `npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --resume ${backupPath} --apply`
}

export const INTERRUPTED_EXIT_CODE = 2

export class InterruptedAttemptError extends Error {
  constructor(public backupPath: string, public reason: string) {
    super(
      `an earlier --apply for this source was interrupted (${reason}).\n` +
        `  A plain re-run would plan nothing and leave claims half-retired. Backup: ${backupPath}\n` +
        `  Finish it with:\n    ${resumeCommand(backupPath)}`
    )
  }
}

/**
 * Refuse to plan afresh when an earlier attempt for this source was cut short.
 * Signals: the newest backup's progress file says it never completed; or (for
 * backups with no sidecar) some of the backup's claim_members rows are gone
 * while their facts still exist.
 */
export async function assertNoInterruptedAttempt(store: RetireStore, backupDir: string, sourceId: string): Promise<void> {
  const backupPath = latestBackupFor(backupDir, sourceId)
  if (!backupPath) return
  const state = await store.sourceState(sourceId)
  if (!state.exists) return // finished: the row was deleted
  const progress = readProgress(backupPath)
  if (progress && !progress.complete) throw new InterruptedAttemptError(backupPath, 'its progress file says it never finished')

  const plan = readBackup(backupPath)
  const stillThere = await store.existingInsightIds(plan.insights.map(i => i.id))
  if (stillThere.length === 0) return
  const live = new Set(stillThere)
  const expected = plan.members.filter(m => live.has(m.raw_insight_id))
  if (expected.length === 0) return
  const have = await store.membersOf(stillThere)
  const haveKeys = new Set(have.map(m => `${m.claim_id}|${m.raw_insight_id}`))
  const missing = expected.filter(m => !haveKeys.has(`${m.claim_id}|${m.raw_insight_id}`)).length
  if (missing > 0) {
    throw new InterruptedAttemptError(backupPath, `${missing} of its ${expected.length} fact→claim links are gone while the facts still exist`)
  }
}

/** Read the database and fix the plan for one source (steps 2–4 are computed here, once). */
export async function buildPlan(store: RetireStore, src: Src, twinId: string | null, rowAction: RowAction): Promise<Plan> {
  const insights = await store.listInsights(src.id)
  const members = await store.membersFull(insights.map(i => i.id))
  const affected = [...new Set(members.map(m => m.claim_id))]
  const retireIds: string[] = []
  const rederive: RederiveItem[] = []
  for (const claimId of affected) {
    const survivors = await store.survivors(claimId, src.id)
    if (survivors.length === 0) retireIds.push(claimId)
    else rederive.push({ claimId, seed: survivors[0], survivors: survivors.length })
  }
  const claimsBefore = await store.claimsSnapshot(affected)
  const reviewIds = [...new Set(await store.pendingReviewsTouching(retireIds))]
  return { source: src, twinId, rowAction, insights, members, claimsBefore, retireIds, rederive, reviewIds }
}

// ---- the procedure ---------------------------------------------------------------

export type StepCounts = {
  unhooked: boolean
  retired: number
  retireBlocked: number
  rederived: number
  rederiveSkipped: number
  rederiveRetired: number
  reviewsClosed: number
  insightsDeleted: boolean
  chunksDeleted: boolean
  rowAction: 'deleted' | 'cleared' | 'already-done' | 'skipped-replaced'
}

export type ApplyOptions = {
  /** Where the sidecar progress file lives; omit to skip checkpointing. */
  backupPath?: string
  log?: (line: string) => void
  chunkSize?: number
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Step 5 only starts after step 3 has finished, so a source whose row is gone, or
 * whose facts are gone while it is still a caption row, proves the re-derives are
 * done — even when there is no progress file (backups from the earlier script).
 */
export function reachedDeleteStep(plan: Plan, src: SourceState): boolean {
  return !src.exists || (src.origin === 'other' && src.insights === 0 && plan.insights.length > 0)
}

/**
 * What is still outstanding for this plan? Read-only. Used for the --resume
 * dry run and by `applyPlan` itself (it only writes what this says is left).
 */
export async function outstanding(store: RetireStore, plan: Plan, progress: Progress | null) {
  const insightIds = plan.insights.map(i => i.id)
  const members = await store.countMembersOf(insightIds)
  const retireStates = await store.claimStates(plan.retireIds)
  // Before the unhook has run, the emptied claims still show their (about to be removed) members.
  const unhookPending = members > 0
  const needsRetire = (c: ClaimState) => c.status !== 'retired' || c.member_count !== 0 || c.source_count !== 0 || c.hasVector
  const retireTodo = retireStates.filter(c => needsRetire(c) && (c.members === 0 || unhookPending)).map(c => c.id)
  const retireBlocked = unhookPending ? [] : retireStates.filter(c => c.members > 0).map(c => c.id)
  const source = await store.sourceState(plan.source.id)
  const done = new Set(progress?.rederived ?? [])
  const rederiveTodo = reachedDeleteStep(plan, source) ? [] : plan.rederive.filter(r => !done.has(r.claimId))
  const reviewsTodo = await store.pendingReviewIds(plan.reviewIds)
  return { members, retireTodo, retireBlocked, rederiveTodo, reviewsTodo, source }
}

/**
 * Apply steps 1–6 of the plan, writing only what is outstanding. Safe to call
 * any number of times, after a cut at any point; with nothing left it makes no
 * write calls. A fresh run and a resume are the same call.
 */
export async function applyPlan(store: RetireStore, plan: Plan, opts: ApplyOptions = {}): Promise<StepCounts> {
  const log = opts.log ?? (() => {})
  const size = opts.chunkSize ?? 200
  const s = plan.source
  const insightIds = plan.insights.map(i => i.id)
  const progress: Progress = (opts.backupPath && readProgress(opts.backupPath)) || { startedAt: new Date().toISOString(), rederived: [], complete: false }
  const save = () => { if (opts.backupPath) writeProgress(opts.backupPath, progress) }
  const counts: StepCounts = {
    unhooked: false, retired: 0, retireBlocked: 0, rederived: 0, rederiveSkipped: 0, rederiveRetired: 0,
    reviewsClosed: 0, insightsDeleted: false, chunksDeleted: false, rowAction: 'already-done',
  }
  const late: string[] = [] // re-derive claims that turned out to have no survivors

  // 1. unhook
  if ((await store.countMembersOf(insightIds)) > 0) {
    for (const ids of chunk(insightIds, size)) await store.deleteMembersOf(ids)
    counts.unhooked = true
    log('  unhooked')
  }

  // 2. retire the emptied claims; drop their vectors. A claim that has gained members
  //    since the plan was made (another writer) is left alone and reported.
  const states = await store.claimStates(plan.retireIds)
  const toRetire = states.filter(c => c.members === 0 && (c.status !== 'retired' || c.member_count !== 0 || c.source_count !== 0 || c.hasVector)).map(c => c.id)
  counts.retireBlocked = states.filter(c => c.members > 0).length
  if (counts.retireBlocked) log(`  WARNING: ${counts.retireBlocked} claim(s) in the plan to retire now have members — left alone`)
  for (const ids of chunk(toRetire, 100)) await store.retireClaims(ids)
  counts.retired = toRetire.length

  // 3. re-derive the mixed claims from their survivors (checkpointed per claim)
  const done = new Set(progress.rederived)
  const finishedBefore = reachedDeleteStep(plan, await store.sourceState(s.id))
  for (const r of plan.rederive) {
    if (done.has(r.claimId) || finishedBefore) { counts.rederiveSkipped++; continue }
    const survivors = await store.survivors(r.claimId, s.id)
    if (survivors.length === 0) {
      // Every survivor has since gone (e.g. its own caption source was retired): it is an empty claim now.
      await store.retireClaims([r.claimId])
      late.push(r.claimId)
      counts.rederiveRetired++
    } else {
      await store.rederiveClaim(r.claimId, survivors[0])
      counts.rederived++
    }
    progress.rederived.push(r.claimId)
    done.add(r.claimId)
    save()
    if ((counts.rederived + counts.rederiveRetired) % 25 === 0) log(`  re-derived ${done.size}/${plan.rederive.length}`)
  }

  // 4. close the reviews on retired claims (only those still pending)
  const reviewIds = new Set(await store.pendingReviewIds(plan.reviewIds))
  if (late.length) for (const id of await store.pendingReviewsTouching(late)) reviewIds.add(id)
  const toClose = [...reviewIds]
  for (const ids of chunk(toClose, 100)) await store.closeReviews(ids)
  counts.reviewsClosed = toClose.length

  // 5. delete the caption version — but never a row that has already been replaced
  //    by its Deepgram transcript (a resume after the attach step must not wipe it).
  const src = await store.sourceState(s.id)
  if (!src.exists) {
    counts.rowAction = 'already-done'
  } else if (src.origin !== 'other') {
    counts.rowAction = 'skipped-replaced'
    log(`  source ${s.id} is now '${src.origin}', not a caption row — its rows are left alone`)
  } else {
    if (src.insights > 0) { await store.deleteInsightsOf(s.id); counts.insightsDeleted = true }
    if (src.chunks > 0) { await store.deleteChunksOf(s.id); counts.chunksDeleted = true }
    if (plan.rowAction === 'delete') {
      await store.deleteSourceRow(s.id)
      counts.rowAction = 'deleted'
    } else if (!src.cleared) {
      await store.clearSourceRow(s.id)
      counts.rowAction = 'cleared'
    }
  }

  // 6. verify
  await verifyPlan(store, plan, counts.rowAction === 'skipped-replaced')
  progress.complete = true
  save()
  return counts
}

export async function verifyPlan(store: RetireStore, plan: Plan, replaced: boolean): Promise<void> {
  const s = plan.source
  const problems: string[] = []
  const src = await store.sourceState(s.id)
  if (!replaced && src.exists && src.insights) problems.push(`${src.insights} insights remain`)
  const leftMembers = replaced ? 0 : await store.countMembersOf(plan.insights.map(i => i.id))
  if (leftMembers) problems.push(`${leftMembers} fact→claim links remain`)
  const notRetired = (await store.claimStates(plan.retireIds)).filter(c => c.members === 0 && c.status !== 'retired').length
  if (notRetired) problems.push(`${notRetired} claims not retired`)
  const rederived = (await store.claimStates(plan.rederive.map(r => r.claimId))).filter(c => c.status !== 'retired')
  const missingVectors = rederived.filter(c => !c.hasVector).length
  const empty = rederived.filter(c => c.members === 0 || c.member_count === 0).length
  if (missingVectors) problems.push(`${missingVectors} re-derived claims without a vector`)
  if (empty) problems.push(`${empty} re-derived claims with no members`)
  if (problems.length) throw new Error(`VERIFY FAILED for ${s.id}: ${problems.join('; ')}`)
}
