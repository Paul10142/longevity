/**
 * Repair quarantined claims in place (Paul, 2026-11-08) instead of re-extracting the library.
 *
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --stats
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --dry-run --limit 20
 *   npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --apply
 *
 * Every claim with an open `extraction_fidelity` flag and status 'flagged' (lib/claimGate.ts) is
 * run through lib/claimRepair.ts: keep the current wording if it already passes, else adopt a
 * faithful member insight's own wording, else have Opus 5.5 rewrite it under lib/repairRules.ts
 * and let the SAME judge (lib/extractionFidelity.ts) re-read the result. A claim that passes
 * goes back to active and its flag resolves; one that fails twice, needs the video, or has no
 * supportable version stays hidden with a note on its flag, for Paul at /admin/flags.
 *
 *   --stats        counts only (verdicts, stakes, member counts, what a re-run would skip). No model calls.
 *   --dry-run      the default. Reads the database, calls the models, prints before/after wording and
 *                  the judge's re-verdict, writes a report under scratchpad/runs/. WRITES NOTHING.
 *   --apply        writes: audit row in claim_repairs (migration 037), the claim's canonical_statement
 *                  and embedding, the flag, the claim's status. Takes the exclusive writer lock.
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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from '../lib/llm'
import { judgeFidelity } from '../lib/extractionFidelity'
import { statusAfterResolution } from '../lib/claimGate'
import { REPAIR_SYSTEM, buildRepairUser, parseRewrite } from '../lib/repairRules'
import {
  repairClaim, orderCandidates, stratifiedSample, stakesTier, sameText,
  type Candidate, type MemberPassage, type RepairResult, type RepairOutcome, type RepairDeps,
} from '../lib/claimRepair'
import { flagFacts, flagNote, resolutionFor, originalDetail } from '../lib/repairFlags'
import { startRunLog } from '../lib/runLog'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'

const ADMIN_FLAGS_URL = 'https://www.lifestyleacademy.health/admin/flags'
const MODEL = CLAUDE_JUDGMENT_MODEL
const TERMINAL_HIDDEN: RepairOutcome[] = ['failed', 'needs_video', 'cannot_repair', 'refused']
const MAX_CONSECUTIVE_ERRORS = 3

type Db = Awaited<ReturnType<typeof loadDb>>
async function loadDb() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  return supabaseAdmin
}

// ── Arguments ───────────────────────────────────────────────────

type Args = { stats: boolean; apply: boolean; limit: number | undefined; claims: string[]; retry: boolean; batch: number }

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f)
  const val = (f: string) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : undefined }
  if (has('--apply') && has('--dry-run')) throw new Error('--apply and --dry-run are opposites; pick one')
  const num = (f: string, d?: number) => {
    const v = val(f); if (v === undefined) return d
    const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${f} needs a whole number of 1 or more`)
    return n
  }
  return {
    stats: has('--stats'), apply: has('--apply'), limit: num('--limit'),
    claims: (val('--claim') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    retry: has('--retry'), batch: num('--batch', 5)!,
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
    attempts: r.attempts, note: r.note, model: MODEL,
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
  const lines = [
    `── [${i}/${total}] claim ${w.claimId}  ${w.verdict}  ${w.memberCount > 1 ? `${w.memberCount} insights` : '1 insight'}  stakes: ${tier}  ${secs.toFixed(0)}s`,
    `   flagged phrase: ${w.offending ? `"${clip(w.offending, 160)}"` : '(none given)'}`,
    `   BEFORE: ${clip(w.claim)}`,
  ]
  if (r.newStatement && r.source !== 'unchanged') lines.push(`   AFTER (${r.source === 'member' ? "another insight's own wording" : 'rewritten by Opus 5.5'}): ${clip(r.newStatement)}`)
  const judged = [...r.attempts].reverse().find(a => a.judge)
  if (judged?.judge) lines.push(`   RE-VERDICT: ${judged.judge.verdict}${judged.judge.reasoning ? ` — ${clip(judged.judge.reasoning, 200)}` : ''}`)
  const guards = r.attempts.filter(a => a.guard)
  for (const g of guards) lines.push(`   guard rejected a rewrite: ${g.guard}`)
  if (r.droppedNumbers.length) lines.push(`   NOTE numbers in the old wording and the passage that the new wording leaves out: ${r.droppedNumbers.join(', ')}`)
  lines.push(`   OUTCOME: ${r.outcome}${r.note ? ` — ${clip(r.note, 220)}` : ''}`)
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

  const loaded = await loadWork(db, args)
  if (args.apply && !loaded.tableExists) {
    throw new Error('the claim_repairs table does not exist: apply supabase/migrations_v2/037_claim_repairs.sql in the Supabase SQL Editor first')
  }
  if (args.apply) {
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('repairFlaggedClaims')
  }
  const ordered = orderCandidates(loaded.work)
  const pendingFirst = [...ordered.filter(w => w.pending), ...ordered.filter(w => !w.pending)]
  const todo = args.limit
    ? (args.apply ? pendingFirst.slice(0, args.limit) : stratifiedSample(ordered, args.limit))
    : pendingFirst
  console.log(`${loaded.totalOpen} open flags; ${loaded.work.length} to repair${args.limit ? `, doing ${todo.length}` : ''}; ${loaded.notQuarantined} not quarantined and skipped; skipped as already finished: ${JSON.stringify(loaded.skipped)}`)

  const deps: RepairDeps = {
    judge: (statement, chunk, opts) => judgeFidelity(statement, chunk, opts),
    rewrite: async req => parseRewrite(await claudeJson(REPAIR_SYSTEM, buildRepairUser(req), 2000, MODEL, 'high')),
  }

  const tally: Record<string, number> = {}
  const report: string[] = []
  const started = Date.now()
  let consecutiveErrors = 0
  let exitCode = 0

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
      if (w.pending) {
        // The audit row is already written; only the apply steps are outstanding.
        result = { outcome: w.pending.outcome, source: w.pending.source as RepairResult['source'], newStatement: w.pending.new_statement, memberRawInsightId: w.pending.member_raw_insight_id, droppedNumbers: [], note: 'finishing a repair that was already judged', attempts: [] }
        if (args.apply) await applyRepaired(db, w, w.pending.outcome as 'repaired' | 'canonical_ok', w.pending.new_statement)
      } else {
        const members = await loadMembers(db, w.claimId)
        result = await repairClaim({ claimId: w.claimId, claim: w.claim, claimContextNote: w.contextNote, flag: flagFacts(w.flag), members }, deps)
        if (result.outcome !== 'error' && args.apply) await applyResult(db, w, result, runId)
      }
      const secs = (Date.now() - t0) / 1000
      tally[result.outcome] = (tally[result.outcome] ?? 0) + 1
      const text = block(i + 1, todo.length, w, result, secs)
      console.log(text)
      report.push(text)
      appendFileSync(progressFile, `${JSON.stringify({ at: new Date().toISOString(), claimId: w.claimId, applied: args.apply && result.outcome !== 'error', before: w.claim, ...result })}\n`)
      consecutiveErrors = result.outcome === 'error' ? consecutiveErrors + 1 : 0
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

  const summary = `${mode}: ${JSON.stringify(tally)} in ${((Date.now() - started) / 60000).toFixed(1)} min. Progress: ${progressFile}`
  console.log(`\n${summary}`)
  if (!args.apply) {
    const md = path.join(outDir, `${runId}-dryrun.md`)
    writeFileSync(md, `# Repair dry run ${runId}\n\n${summary}\n\nReview screen: ${ADMIN_FLAGS_URL}\n\n\`\`\`\n${report.join('\n\n')}\n\`\`\`\n`)
    console.log(`Dry-run report: ${md}`)
  }
  process.exitCode = exitCode
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
