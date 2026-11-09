/**
 * Repair quarantined claims in place (Paul, 2026-11-08) instead of re-extracting the library.
 *
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --stats
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --dry-run --limit 20
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --apply
 *
 * Every claim with an open `extraction_fidelity` flag and status 'flagged' (lib/claimGate.ts) is
 * run through lib/claimRepair.ts, which must not lose information (Paul, 2026-11-08): the claim is
 * cut into separate facts (audited for coverage), each judged against the passages of ALL its member
 * insights; supported facts are kept, the facts are regrouped into one or several claims (a merged claim
 * with distinct facts is SPLIT; each member insight goes to the claim it fits best), and only a fact no
 * passage supports is edited by Opus 5.5
 * under lib/repairRules.ts (restore a hedge, attribute a guess, remove an unsupported fact, and
 * every removed fact is searched for in every passage first). The SAME judge
 * (lib/extractionFidelity.ts) re-reads each edit. A claim that passes goes back to active and its
 * flag resolves; one that cannot be repaired, needs the video, or has nothing supported stays
 * hidden with a note on its flag, for Paul at /admin/flags.
 *
 *   --stats        counts only (verdicts, stakes, member counts, what a re-run would skip). No model calls.
 *   --dry-run      the default. Reads the database, calls the models, prints before/after wording and
 *                  the judge's re-verdict, writes a report under scratchpad/runs/. WRITES NOTHING.
 *   --apply        writes: audit row in claim_repairs (migration 037), the claim's canonical_statement
 *                  and embedding, the flag, the claim's status. A claim that SPLITS into several is written by
 *                  lib/claimSplit.ts through the database function apply_claim_split (migration 041) in ONE
 *                  transaction; the run refuses to start until 041 is applied. Takes the exclusive writer lock.
 *                  Splits that fail to write are kept in scratchpad/runs/repair-pending-splits/ and retried first
 *                  on the next --apply run (no model work is repeated).
 *   --replay <file>  dry run only, NO model calls: take the saved results of an earlier dry run (its .jsonl
 *                  progress file) for the claims in it, check them against the database as it is now, and print
 *                  exactly what --apply would write for each split. Writes nothing.
 *   --limit N      stop after N claims. In a dry run the N are spread across verdict types and across
 *                  one-member / several-member claims, so a small sample shows every path.
 *   --claim <id,id>  only these claims (a prefix of 8+ characters is enough).
 *   --retry        also redo claims whose last result was failed / needs_video / cannot_repair / refused.
 *   --batch N      claims between usage-guard checks (default 5).
 *
 * Order: claims with numbers or doses first, then cause-and-effect language, then the rest.
 * One claim at a time. Resumable and idempotent: a finished claim is never picked again, and a
 * claim whose audit row was written but whose claim row was not is finished on the next run.
 * `raw_insights` are never touched. Before every batch it runs `sh ~/.claude/usage-guard/check.sh`
 * and stops when that exits 1. Exit codes: 0 finished, 2 stopped early (usage limit, halted CLI,
 * repeated judge errors), 3 usage guard said stop.
 *
 * The wording rules are in lib/repairRules.ts, deliberately apart from lib/extraction.ts.
 */

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from '../lib/llm'
import { judgeFidelity } from '../lib/extractionFidelity'
import { statusAfterResolution } from '../lib/claimGate'
import {
  UNIT_REPAIR_SYSTEM, buildUnitUser, parseUnitRewrite,
  DECOMPOSE_SYSTEM, buildDecomposeUser, parseDecompose, GROUP_SYSTEM, buildGroupUser, parseGroups,
} from '../lib/repairRules'
import {
  repairClaim, orderCandidates, stratifiedSample, stakesTier, sameText,
  type Candidate, type MemberPassage, type RepairResult, type RepairOutcome, type RepairDeps,
} from '../lib/claimRepair'
import { flagFacts, flagNote, resolutionFor, originalDetail } from '../lib/repairFlags'
import {
  buildSplitPlan, describeSplit, writeSplit, retryPendingSplits, splitWriterInstalled, loadPlans, SplitPlanError,
  type SplitDeps, type SplitOutcome,
} from '../lib/claimSplit'
import { startRunLog } from '../lib/runLog'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'

const ADMIN_FLAGS_URL = 'https://www.lifestyleacademy.health/admin/flags'
const MODEL = CLAUDE_JUDGMENT_MODEL
const TERMINAL_HIDDEN: RepairOutcome[] = ['failed', 'needs_video', 'cannot_repair', 'refused']
const MAX_CONSECUTIVE_ERRORS = 3
/** Splits whose write failed are kept here and retried first on the next --apply run. */
const PENDING_SPLITS_DIR = 'scratchpad/runs/repair-pending-splits'

type Db = Awaited<ReturnType<typeof loadDb>>
async function loadDb() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  return supabaseAdmin
}

// ── Arguments ───────────────────────────────────────────────────

type Args = { stats: boolean; apply: boolean; limit: number | undefined; claims: string[]; retry: boolean; batch: number; replay: string | undefined }

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f)
  const val = (f: string) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : undefined }
  if (has('--apply') && has('--dry-run')) throw new Error('--apply and --dry-run are opposites; pick one')
  if (has('--apply') && has('--replay')) throw new Error('--replay never writes (it re-prints a saved dry run); drop --apply, or run --apply on its own')
  if (has('--replay') && !val('--replay')) throw new Error('--replay needs the .jsonl file of an earlier dry run')
  const num = (f: string, d?: number) => {
    const v = val(f); if (v === undefined) return d
    const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${f} needs a whole number of 1 or more`)
    return n
  }
  return {
    stats: has('--stats'), apply: has('--apply'), limit: num('--limit'),
    claims: (val('--claim') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    retry: has('--retry'), batch: num('--batch', 5)!, replay: val('--replay'),
  }
}

// ── Loading ─────────────────────────────────────────────────────

type FlagRow = {
  id: string; claim_id: string; detail: string | null; evidence: Record<string, unknown> | null; created_at: string
  claims: { id: string; canonical_statement: string; context_note: string | null; status: string; member_count: number; created_at: string } | null
}
type RepairRow = { claim_id: string; outcome: RepairOutcome; new_statement: string | null; source: string | null; member_raw_insight_id: string | null }

type Work = Candidate & {
  flag: FlagRow
  contextNote: string | null
  /** An audit row already says repaired / canonical_ok but the flag is still open: finish applying it. */
  pending: RepairRow | null
}

async function loadRepairs(db: Db): Promise<{ rows: RepairRow[]; tableExists: boolean }> {
  const { selectAllPaged } = await import('../lib/pagination')
  try {
    const rows = await selectAllPaged<RepairRow & { created_at: string }>(
      (from, to) => db.from('claim_repairs')
        .select('claim_id, outcome, new_statement, source, member_raw_insight_id, created_at')
        .order('created_at', { ascending: true }).order('claim_id', { ascending: true }).range(from, to)
    )
    return { rows, tableExists: true }
  } catch (err) {
    if (/claim_repairs/.test(err instanceof Error ? err.message : '')) return { rows: [], tableExists: false }
    throw err
  }
}

async function loadWork(db: Db, args: Args): Promise<{ work: Work[]; totalOpen: number; notQuarantined: number; skipped: Record<string, number>; tableExists: boolean }> {
  const { selectAllPaged } = await import('../lib/pagination')
  const flags = await selectAllPaged<FlagRow>(
    (from, to) => db.from('claim_flags')
      .select('id, claim_id, detail, evidence, created_at, claims(id, canonical_statement, context_note, status, member_count, created_at)')
      .eq('rule', 'extraction_fidelity').is('resolved_at', null)
      .order('claim_id', { ascending: true }).range(from, to)
  )
  const { rows: repairs, tableExists } = await loadRepairs(db)
  const lastByClaim = new Map<string, RepairRow>()
  for (const r of repairs) lastByClaim.set(r.claim_id, r) // ascending: the last write wins

  const skipped: Record<string, number> = {}
  let notQuarantined = 0
  const work: Work[] = []
  for (const f of flags) {
    const c = f.claims
    if (!c) continue
    if (c.status !== 'flagged') { notQuarantined++; continue } // shadow-mode or already moved: not ours
    if (args.claims.length && !args.claims.some(p => c.id.startsWith(p))) continue
    const last = lastByClaim.get(c.id)
    const pending = last && (last.outcome === 'repaired' || last.outcome === 'canonical_ok') ? last : null
    if (!pending && last && TERMINAL_HIDDEN.includes(last.outcome) && !args.retry) {
      skipped[last.outcome] = (skipped[last.outcome] ?? 0) + 1
      continue
    }
    const facts = flagFacts(f)
    work.push({
      claimId: c.id, claim: c.canonical_statement, verdict: facts.verdict, offending: facts.offending,
      memberCount: c.member_count, createdAt: c.created_at, flag: f, contextNote: c.context_note, pending,
    })
  }
  return { work, totalOpen: flags.length, notQuarantined, skipped, tableExists }
}

type MemberRow = {
  raw_insight_id: string; matched_by: string
  raw_insights: { statement: string; context_note: string | null; direct_quote: string | null; chunks: { content: string } | null } | null
}

/** Same loading as runFidelity in scripts/flagClaims.ts (member, then its source chunk), for every member. */
async function loadMembers(db: Db, claimId: string): Promise<MemberPassage[]> {
  const { selectAllPaged } = await import('../lib/pagination')
  const rows = await selectAllPaged<MemberRow>(
    (from, to) => db.from('claim_members')
      .select('raw_insight_id, matched_by, raw_insights(statement, context_note, direct_quote, chunks(content))')
      .eq('claim_id', claimId).order('raw_insight_id', { ascending: true }).range(from, to)
  )
  return rows.filter(r => r.raw_insights).map(r => ({
    rawInsightId: r.raw_insight_id, matchedBy: r.matched_by, statement: r.raw_insights!.statement,
    contextNote: r.raw_insights!.context_note, directQuote: r.raw_insights!.direct_quote,
    chunk: r.raw_insights!.chunks?.content ?? '',
  }))
}

// ── Applying ────────────────────────────────────────────────────

async function insertAudit(db: Db, w: Work, r: RepairResult, runId: string): Promise<void> {
  const facts = flagFacts(w.flag)
  const { error } = await db.from('claim_repairs').insert({
    claim_id: w.claimId, flag_id: w.flag.id, run_id: runId, outcome: r.outcome, source: r.source,
    original_statement: w.claim, verdict_before: facts.verdict, offending_before: facts.offending, reasoning_before: facts.reasoning,
    new_statement: r.newStatement, member_raw_insight_id: r.memberRawInsightId,
    // The audit jsonb: every judged step, then the per-sentence ledger (kept / edited / removed, with reasons).
    attempts: [...r.attempts, { kind: 'ledger', passages: r.passageCount, units: r.ledger }], note: r.note, model: MODEL,
  })
  if (error) throw new Error(`audit row for ${w.claimId}: ${error.message}`)
}

/** Steps 2-4 of an applied repair; each is safe to repeat, so a crash anywhere resumes cleanly. */
async function applyRepaired(db: Db, w: Work, outcome: 'repaired' | 'canonical_ok', newStatement: string | null): Promise<void> {
  const claimId = w.claimId
  if (outcome === 'repaired') {
    if (!newStatement) throw new Error(`repaired claim ${claimId} has no new statement`)
    const { data: cur, error: cErr } = await db.from('claims').select('canonical_statement, context_note').eq('id', claimId).single()
    if (cErr || !cur) throw new Error(`reload ${claimId}: ${cErr?.message}`)
    const current = (cur as { canonical_statement: string }).canonical_statement
    if (!sameText(current, newStatement)) {
      // Only overwrite the wording we read and repaired; anything else was edited meanwhile.
      if (!sameText(current, w.claim)) throw new Error(`claim ${claimId} changed while it was being repaired; left as it is`)
      const { error } = await db.from('claims').update({ canonical_statement: newStatement }).eq('id', claimId).eq('canonical_statement', current)
      if (error) throw new Error(`update ${claimId}: ${error.message}`)
    }
    // The vector must follow the text it indexes (as enrichClaimCanonical does).
    const { generateEmbedding, insightEmbeddingText } = await import('../lib/embeddings')
    const vector = await generateEmbedding(insightEmbeddingText({ statement: newStatement, context_note: (cur as { context_note: string | null }).context_note }))
    const { error: eErr } = await db.from('claim_embeddings').upsert({ claim_id: claimId, embedding: vector, updated_at: new Date().toISOString() }, { onConflict: 'claim_id' })
    if (eErr) throw new Error(`embedding ${claimId}: ${eErr.message}`)
  }
  // The flag resolves, then the gate puts the claim back (lib/claimGate.ts decides the status).
  const resolution = resolutionFor(outcome)!
  const { error: fErr } = await db.from('claim_flags').update({ resolved_at: new Date().toISOString(), resolution }).eq('id', w.flag.id).is('resolved_at', null)
  if (fErr) throw new Error(`resolve flag ${w.flag.id}: ${fErr.message}`)
  const { data: row } = await db.from('claims').select('status').eq('id', claimId).maybeSingle()
  const next = row ? statusAfterResolution((row as { status: string }).status, 'extraction_fidelity', resolution) : null
  if (next) {
    const { error } = await db.from('claims').update({ status: next }).eq('id', claimId).eq('status', 'flagged')
    if (error) throw new Error(`restore ${claimId}: ${error.message}`)
  }
}

/** The claim stays hidden; its flag says why, in words Paul sees at /admin/flags. */
async function annotateFlag(db: Db, w: Work, r: RepairResult, runId: string): Promise<void> {
  const n = flagNote(r.outcome, r.note, w.flag)
  if (!n) return
  const evidence = { ...(w.flag.evidence ?? {}), repair: { outcome: r.outcome, note: r.note, run_id: runId, at: new Date().toISOString(), original_detail: originalDetail(w.flag) } }
  const { error } = await db.from('claim_flags').update({ detail: n.detail, evidence }).eq('id', w.flag.id).is('resolved_at', null)
  if (error) throw new Error(`annotate flag ${w.flag.id}: ${error.message}`)
  if (r.outcome === 'needs_video') {
    // Migration 036 (the review screen's "Needs Video Check" list). Absent until it is applied; not an error.
    const { error: vErr } = await db.from('claim_flags').update({ needs_video_check_at: new Date().toISOString() }).eq('id', w.flag.id).is('resolved_at', null)
    if (vErr && !/needs_video_check_at/.test(vErr.message)) throw new Error(`video note ${w.flag.id}: ${vErr.message}`)
  }
}

async function applyResult(db: Db, w: Work, r: RepairResult, runId: string): Promise<void> {
  await insertAudit(db, w, r, runId) // first: the old wording must be safe before it is overwritten
  if (r.outcome === 'repaired' || r.outcome === 'canonical_ok') {
    try {
      await applyRepaired(db, w, r.outcome, r.newStatement)
    } catch (err) {
      // A half-applied repair that cannot finish must not leave an audit row claiming it did.
      if (/changed while it was being repaired/.test(err instanceof Error ? err.message : '')) {
        await db.from('claim_repairs').delete().eq('claim_id', w.claimId).eq('run_id', runId).in('outcome', ['repaired', 'canonical_ok'])
      }
      throw err
    }
  } else {
    await annotateFlag(db, w, r, runId)
  }
}

// ── Guards, logging ─────────────────────────────────────────────

function usageGuardOk(): { ok: boolean; line: string } {
  const res = spawnSync('sh', [path.join(homedir(), '.claude/usage-guard/check.sh')], { encoding: 'utf8' })
  const line = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() || `exit ${res.status}`
  return { ok: res.status === 0, line }
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function block(i: number, total: number, w: Work, r: RepairResult, secs: number): string {
  const tier = ['numbers/doses', 'cause-and-effect', 'other'][stakesTier(w.claim, w.offending)]
  const before = w.claim.trim().length
  const lines = [
    `── [${i}/${total}] claim ${w.claimId}  ${w.verdict}  ${w.memberCount > 1 ? `${w.memberCount} insights` : '1 insight'}  ${r.passageCount} passages  stakes: ${tier}  ${secs.toFixed(0)}s`,
    `   flagged phrase: ${w.offending ? `"${clip(w.offending, 160)}"` : '(none given)'}`,
    `   BEFORE (${before} characters): ${clip(w.claim, 700)}`,
  ]
  const noun = r.cutAt === 'facts' ? 'facts' : 'sentences'
  if (r.ledger.length) lines.push(`   CUT INTO: ${r.ledger.length} ${noun}${r.cutAt === 'sentences' ? ' (fallback: the model split did not pass the coverage audit, or none was asked for)' : ''}`)
  if (r.claims.length) {
    const delta = r.charsAfter - r.charsBefore
    lines.push(`   RESULT: ${r.claims.length === 1 ? 'stays ONE claim' : `becomes ${r.claims.length} CLAIMS`}; characters ${r.charsBefore} → ${r.charsAfter} (${delta >= 0 ? '+' : ''}${delta}); unsupported content removed: ${r.charsRemoved} characters`)
    r.claims.forEach((c, ci) => {
      lines.push(`   CLAIM ${ci + 1} of ${r.claims.length} (${ci === 0 ? 'keeps the original id' : 'new'}; ${c.memberRawInsightIds.length} insight${c.memberRawInsightIds.length === 1 ? '' : 's'}; ${c.statement.length} characters): ${clip(c.statement, 900)}`)
    })
    if (r.alsoBacks.length) lines.push(`   ALSO FITS: ${r.alsoBacks.length} insight${r.alsoBacks.length === 1 ? '' : 's'} match more than one resulting claim (each is placed in its best one: an insight can belong to one claim only)`)
  } else if (r.outcome === 'canonical_ok') {
    lines.push(`   RESULT: unchanged, ONE claim (${r.charsBefore} characters; every ${noun.slice(0, -1)} is supported)`)
  }
  const kept = r.ledger.filter(l => l.status === 'kept').length
  if (r.ledger.length) lines.push(`   ${noun.toUpperCase()}: ${r.ledger.length} total, ${kept} kept as judged, ${r.ledger.filter(l => l.status === 'edited').length} edited, ${r.ledger.filter(l => l.status === 'removed').length} removed, ${r.ledger.filter(l => l.status === 'unresolved').length} unresolved`)
  if (r.claims.length > 1) {
    for (const l of r.ledger) {
      if (l.group === null) continue
      lines.push(`   → ${noun.slice(0, -1)} ${l.index + 1} → claim ${l.group + 1} [${l.status}]: ${clip(l.after, 160)}`)
    }
  }
  for (const l of r.ledger) {
    if (l.status === 'kept') continue
    lines.push(`   • ${noun.slice(0, -1)} ${l.index + 1} ${l.status.toUpperCase()} (${l.verdict}${l.offending ? `: "${clip(l.offending, 120)}"` : ''}; ${l.passagesSearched} passages searched)`)
    lines.push(`       was: ${clip(l.before, 400)}`)
    if (l.after && l.status === 'edited') lines.push(`       now: ${clip(l.after, 400)}`)
    if (l.changes) lines.push(`       change: ${clip(l.changes, 300)}`)
    for (const f of l.removed) lines.push(`       removed fact: ${clip(f.fact, 300)} — ${clip(f.reason, 200)} (no support in ${f.searchedPassages} passages)`)
  }
  if (r.droppedNumbers.length) lines.push(`   NOTE numbers the old wording and a passage both state that the new wording would lose: ${r.droppedNumbers.join(', ')}`)
  lines.push(`   OUTCOME: ${r.outcome}${r.note ? ` — ${clip(r.note, 400)}` : ''}`)
  return lines.join('\n')
}

// ── Stats ───────────────────────────────────────────────────────

async function stats(db: Db, args: Args): Promise<void> {
  const { work, totalOpen, notQuarantined, skipped, tableExists } = await loadWork(db, args)
  const count = <T,>(xs: T[], k: (x: T) => string) => { const m: Record<string, number> = {}; for (const x of xs) m[k(x)] = (m[k(x)] ?? 0) + 1; return m }
  const show = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const multi = work.filter(w => w.memberCount > 1)
  console.log(`open extraction_fidelity flags:        ${totalOpen}`)
  console.log(`  not quarantined (status not flagged): ${notQuarantined}  (left alone)`)
  console.log(`  already finished or waiting review:   ${show(skipped)}${tableExists ? '' : '  (claim_repairs table not found: migration 037 not applied)'}`)
  console.log(`  to repair now:                        ${work.length}`)
  console.log(`  by verdict:                           ${show(count(work, w => w.verdict))}`)
  console.log(`  by stakes:                            ${show(count(work, w => ['numbers/doses', 'cause-and-effect', 'other'][stakesTier(w.claim, w.offending)]))}`)
  console.log(`  one insight / several insights:       ${work.length - multi.length} / ${multi.length}`)
  console.log(`  insights per claim:                   ${show(count(work, w => (w.memberCount <= 1 ? '1' : w.memberCount === 2 ? '2' : w.memberCount <= 5 ? '3-5' : '6+')))}`)
  console.log(`  half-applied (audit row, flag open):  ${work.filter(w => w.pending).length}`)
  console.log(`  splits saved, waiting for a write retry: ${loadPlans(PENDING_SPLITS_DIR).plans.length}`)
  console.log(`Review screen: ${ADMIN_FLAGS_URL}`)
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = await loadDb()
  if (args.stats) { await stats(db, args); return }

  const runId = `repair-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}`
  startRunLog('repairFlaggedClaims')
  const outDir = 'scratchpad/runs'
  mkdirSync(outDir, { recursive: true })
  const progressFile = path.join(outDir, `${runId}${args.apply ? '' : '-dryrun'}.jsonl`)

  const mode = args.apply ? 'APPLY (writes the database)' : 'DRY RUN (writes nothing)'
  console.log(`repairFlaggedClaims ${mode}  run ${runId}  model ${MODEL}  backend ${process.env.LLM_BACKEND}`)

  const splitDeps: SplitDeps = {
    embedBatch: async texts => (await import('../lib/embeddings')).generateEmbeddingsBatch(texts),
    rpc: async (fn, rpcArgs) => {
      const { data, error } = await db.rpc(fn, rpcArgs)
      return { data, error: error ? { message: error.message, code: error.code } : null }
    },
  }
  // Claims whose split was planned and saved but whose write failed last time: never repaired a second time.
  const writeFailedBefore = new Set<string>()
  if (args.apply) {
    const { tableExists } = await loadRepairs(db)
    if (!tableExists) throw new Error('the claim_repairs table does not exist: apply supabase/migrations_v2/037_claim_repairs.sql in the Supabase SQL Editor first')
    if (!(await splitWriterInstalled(splitDeps.rpc))) {
      throw new Error('the database function apply_claim_split does not exist: apply supabase/migrations_v2/041_claim_split_repair.sql in the Supabase SQL Editor first (about a third of the claims split, and they cannot be written without it)')
    }
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('repairFlaggedClaims')
    const pendingReport = await retryPendingSplits(PENDING_SPLITS_DIR, splitDeps)
    const pendingTotal = pendingReport.applied.length + pendingReport.alreadyApplied.length + pendingReport.stale.length + pendingReport.failed.length
    if (pendingTotal || pendingReport.unreadable.length) {
      console.log(`saved splits from an earlier run: ${pendingReport.applied.length} written now, ${pendingReport.alreadyApplied.length} already written, ${pendingReport.stale.length} discarded because the claim changed (repaired again below), ${pendingReport.failed.length} still failing${pendingReport.unreadable.length ? `, ${pendingReport.unreadable.length} unreadable file(s) left in ${PENDING_SPLITS_DIR}` : ''}`)
      for (const f of pendingReport.failed) console.log(`   still failing ${f.claimId}: ${f.error}`)
    }
    for (const f of pendingReport.failed) writeFailedBefore.add(f.claimId)
  }

  // --replay: the saved results of an earlier dry run stand in for the model calls.
  const replay = new Map<string, { before: string; result: RepairResult }>()
  if (args.replay) {
    for (const line of readFileSync(args.replay, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { claimId: string; before: string } & RepairResult
      const { claimId, before, ...result } = row
      replay.set(claimId, { before, result: result as RepairResult })
    }
    args.claims = [...replay.keys()]
    console.log(`replaying ${replay.size} saved results from ${args.replay}; no model is called and nothing is written`)
  }

  const loaded = await loadWork(db, args)
  const ordered = orderCandidates(loaded.work.filter(w => !writeFailedBefore.has(w.claimId)))
  const pendingFirst = [...ordered.filter(w => w.pending), ...ordered.filter(w => !w.pending)]
  const todo = args.limit
    ? (args.apply ? pendingFirst.slice(0, args.limit) : stratifiedSample(ordered, args.limit))
    : pendingFirst
  console.log(`${loaded.totalOpen} open flags; ${loaded.work.length} to repair${args.limit ? `, doing ${todo.length}` : ''}; ${loaded.notQuarantined} not quarantined and skipped; skipped as already finished: ${JSON.stringify(loaded.skipped)}`)

  const deps: RepairDeps = {
    judge: (statement, chunk, opts) => judgeFidelity(statement, chunk, opts),
    rewrite: async req => parseUnitRewrite(await claudeJson(UNIT_REPAIR_SYSTEM, buildUnitUser(req), 3000, MODEL, 'high')),
    decompose: async (claim, contextNote, priorGap) => parseDecompose(await claudeJson(DECOMPOSE_SYSTEM, buildDecomposeUser(claim, contextNote, priorGap), 6000, MODEL, 'high')),
    group: async facts => parseGroups(await claudeJson(GROUP_SYSTEM, buildGroupUser(facts), 1500, MODEL, 'medium'), facts.length),
  }

  const tally: Record<string, number> = {}
  const report: string[] = []
  const started = Date.now()
  let consecutiveErrors = 0
  let exitCode = 0
  const splits = { written: 0, stale: 0, writeFailed: 0, unplannable: 0, wouldWrite: 0 }
  let consecutiveWriteErrors = 0

  for (let i = 0; i < todo.length; i++) {
    if (i % args.batch === 0) {
      const g = usageGuardOk()
      console.log(`[usage-guard] ${g.line}`)
      if (!g.ok) { console.log(`Stopping before claim ${i + 1}: the usage guard says stop. Re-run the same command later; finished claims are skipped.`); exitCode = 3; break }
    }
    const w = todo[i]
    const t0 = Date.now()
    try {
      let result: RepairResult
      let extra: string[] = []
      let written = args.apply // false when nothing reached the database for this claim
      if (w.pending) {
        // The audit row is already written; only the apply steps are outstanding.
        result = { outcome: w.pending.outcome, source: w.pending.source as RepairResult['source'], newStatement: w.pending.new_statement, memberRawInsightId: w.pending.member_raw_insight_id, droppedNumbers: [], note: 'finishing a repair that was already judged', attempts: [], ledger: [], passageCount: 0, claims: [], alsoBacks: [], cutAt: 'sentences', charsBefore: 0, charsAfter: 0, charsRemoved: 0 }
        if (args.apply) await applyRepaired(db, w, w.pending.outcome as 'repaired' | 'canonical_ok', w.pending.new_statement)
      } else {
        const members = await loadMembers(db, w.claimId)
        const saved = replay.get(w.claimId)
        if (saved && saved.before !== w.claim) {
          console.log(`── [${i + 1}/${todo.length}] claim ${w.claimId}: its wording in the database is not the one the saved dry run started from; --apply would call it stale and repair it again. Skipped in this replay.`)
          tally.replay_wording_changed = (tally.replay_wording_changed ?? 0) + 1
          continue
        }
        result = saved ? saved.result : await repairClaim({ claimId: w.claimId, claim: w.claim, claimContextNote: w.contextNote, flag: flagFacts(w.flag), members }, deps)
        if (result.outcome === 'repaired' && result.claims.length > 1) {
          // A split: one validated plan, written by apply_claim_split in a single transaction (lib/claimSplit.ts).
          written = false
          try {
            const plan = buildSplitPlan({
              runId, claimId: w.claimId, flagId: w.flag.id, originalStatement: w.claim, contextNote: w.contextNote,
              flag: flagFacts(w.flag), currentMemberIds: members.map(m => m.rawInsightId), result, model: MODEL,
            })
            if (!args.apply) {
              splits.wouldWrite++
              extra = describeSplit(plan)
            } else {
              let outcome: SplitOutcome | null
              try {
                outcome = await writeSplit(plan, splitDeps, PENDING_SPLITS_DIR)
                consecutiveWriteErrors = 0
              } catch (err) {
                if (err instanceof UsageLimitError || err instanceof PipelineHaltError) throw err
                splits.writeFailed++
                consecutiveWriteErrors++
                extra = [`   SPLIT NOT WRITTEN, nothing changed in the database: ${err instanceof Error ? err.message : err}`, `   The finished repair is saved in ${PENDING_SPLITS_DIR}/ and is retried first on the next --apply run.`]
                outcome = null // the write threw: nothing changed in the database
              }
              if (outcome?.status === 'applied') {
                splits.written++; written = true
                extra = [`   SPLIT WRITTEN in one transaction: ${outcome.claimIds.length} claims (${outcome.claimIds.map(id => id.slice(0, 8)).join(', ')}); the first keeps the original id`]
              } else if (outcome?.status === 'already_applied') {
                written = true
                extra = ['   SPLIT ALREADY WRITTEN earlier; nothing changed now']
              } else if (outcome?.status === 'stale') {
                splits.stale++
                extra = [`   SPLIT NOT WRITTEN: ${outcome.reason}. Nothing changed; the claim is repaired again on the next run.`]
              }
            }
          } catch (err) {
            if (!(err instanceof SplitPlanError)) throw err
            // The repair's own answer cannot be written safely (it would lose or double an insight): keep the claim hidden for Paul.
            splits.unplannable++
            result = { ...result, outcome: 'failed', claims: [], alsoBacks: [], newStatement: null, note: `the split could not be written safely: ${err.message}; left hidden for review` }
            extra = [`   SPLIT REFUSED: ${err.message}`]
            if (args.apply) await applyResult(db, w, result, runId)
          }
        } else if (result.outcome !== 'error' && args.apply) await applyResult(db, w, result, runId)
      }
      const secs = (Date.now() - t0) / 1000
      tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
      const text = [block(i + 1, todo.length, w, result, secs), ...extra].join('\n')
      console.log(text)
      report.push(text)
      appendFileSync(progressFile, `${JSON.stringify({ at: new Date().toISOString(), claimId: w.claimId, applied: written && result.outcome !== 'error', before: w.claim, ...result })}\n`)
      consecutiveErrors = result.outcome === 'error' ? consecutiveErrors + 1 : 0
      if (consecutiveWriteErrors >= MAX_CONSECUTIVE_ERRORS) { console.error(`Stopping: ${consecutiveWriteErrors} split writes failed in a row (the database or the embedding service is probably unwell). Nothing was half-written; the finished repairs are saved in ${PENDING_SPLITS_DIR}/ and retried first on the next --apply run.`); exitCode = 2; break }
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { console.error(`Stopping: ${consecutiveErrors} judge errors in a row (the CLI is probably unwell). Nothing was recorded for them; re-run to retry.`); exitCode = 2; break }
    } catch (err) {
      if (err instanceof UsageLimitError || err instanceof PipelineHaltError) {
        console.error(`Stopping at claim ${i + 1}/${todo.length}: ${err.message}. Re-run the same command; finished claims are skipped.`)
        exitCode = 2
        break
      }
      throw err
    }
    if ((i + 1) % args.batch === 0) console.log(`…${i + 1}/${todo.length} done, ${((Date.now() - started) / 60000).toFixed(1)} min, ${JSON.stringify(tally)}`)
  }

  const splitNote = args.apply
    ? ` (splits: ${splits.written} written, ${splits.stale} stale, ${splits.writeFailed} write failed and saved for retry, ${splits.unplannable} refused)`
    : splits.wouldWrite ? ` (${splits.wouldWrite} splits would be written by --apply; none were)` : ''
  const summary = `${mode}: ${JSON.stringify(tally)}${splitNote} in ${((Date.now() - started) / 60000).toFixed(1)} min. Progress: ${progressFile}`
  console.log(`\n${summary}`)
  if (!args.apply) {
    const md = path.join(outDir, `${runId}-dryrun.md`)
    writeFileSync(md, `# Repair dry run ${runId}\n\n${summary}\n\nReview screen: ${ADMIN_FLAGS_URL}\n\n\`\`\`\n${report.join('\n\n')}\n\`\`\`\n`)
    console.log(`Dry-run report: ${md}`)
  }
  process.exitCode = exitCode
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
