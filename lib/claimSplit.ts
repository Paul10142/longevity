/**
 * Writing a repair SPLIT (Paul, 2026-11-08/09): one quarantined claim whose repair found several distinct
 * facts becomes several claims. lib/claimRepair.ts DECIDES the split (RepairResult.claims); this module
 * turns that decision into one validated plan and hands it to the database function `apply_claim_split`
 * (supabase/migrations_v2/041_claim_split_repair.sql), which writes every row in ONE transaction.
 *
 *   buildSplitPlan   pure: RepairResult + the claim's current members -> a SplitPlan, or a SplitPlanError.
 *                    Checks that no member insight is lost, invented or placed in two claims, that every
 *                    resulting claim has a statement and a member, and that claim 0 is the original id.
 *   planRows         pure: the exact rows the plan writes, for the dry run and for tests.
 *   applySplit       embeds the statements FIRST (so a failure writes nothing), then calls the function.
 *                    Returns applied | already_applied | stale. A thrown error means NOTHING was written.
 *   savePlan / loadPlans / dropPlan
 *                    a plan is saved to disk before the write and removed after it, so a write that failed
 *                    (network, OpenAI) is retried from the saved plan on the next run instead of paying for
 *                    the model work again.
 *
 * Nothing here talks to a model. The database and the embedder are injected, so tests need neither.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statusAfterResolution } from './claimGate'
import type { FlagFacts, RepairResult } from './claimRepair'
import { insightEmbeddingText } from './embeddings'

export class SplitPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SplitPlanError'
  }
}

export type SplitClaimPlan = {
  /** The original claim's id for claim 0; a freshly chosen id for every other piece. */
  id: string
  statement: string
  /** raw_insights ids that belong to this claim after the split. */
  memberIds: string[]
}

export type SplitPlan = {
  version: 1
  runId: string
  claimId: string
  flagId: string
  /** The wording the repair read; the database refuses the write when the claim no longer has exactly this. */
  expectedStatement: string
  /** Copied onto every new claim and part of every embedded text. */
  contextNote: string | null
  /** The status the claim gate gives a 'reworded' extraction_fidelity flag (lib/claimGate.ts). */
  statusAfter: 'active'
  claims: SplitClaimPlan[]
  audit: {
    verdictBefore: string
    offendingBefore: string
    reasoningBefore: string
    model: string
    note: string
    /** Stored in claim_repairs.attempts: every judged step, the per-fact ledger, and the split map. */
    attempts: unknown[]
  }
  /** Merged into the flag's evidence.repair when it resolves. */
  flagRepair: Record<string, unknown>
}

export type BuildSplitInput = {
  runId: string
  claimId: string
  flagId: string
  /** canonical_statement as read from the database. */
  originalStatement: string
  contextNote: string | null
  flag: FlagFacts
  /** raw_insight ids that are members of the claim right now. */
  currentMemberIds: string[]
  result: RepairResult
  model: string
  /** Test seam; defaults to crypto.randomUUID. */
  newId?: () => string
  /** Test seam; defaults to now. */
  now?: () => Date
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function buildSplitPlan(input: BuildSplitInput): SplitPlan {
  const { result } = input
  if (result.outcome !== 'repaired') throw new SplitPlanError(`only a repaired claim can be split (outcome ${result.outcome})`)
  if (result.claims.length < 2) throw new SplitPlanError(`a split needs at least two claims (got ${result.claims.length})`)

  // Every member insight in exactly one resulting claim, and exactly the claim's current members.
  const current = new Set(input.currentMemberIds)
  if (current.size === 0) throw new SplitPlanError('the claim has no member insights')
  const seen = new Set<string>()
  result.claims.forEach((c, i) => {
    if (!c.statement.trim()) throw new SplitPlanError(`resulting claim ${i + 1} has no statement`)
    if (c.memberRawInsightIds.length === 0) throw new SplitPlanError(`resulting claim ${i + 1} has no member insight (a claim without a member is retired by the pipeline)`)
    for (const id of c.memberRawInsightIds) {
      if (!current.has(id)) throw new SplitPlanError(`resulting claim ${i + 1} lists insight ${id}, which is not a member of the claim`)
      if (seen.has(id)) throw new SplitPlanError(`insight ${id} is placed in two resulting claims (claim_members.raw_insight_id is unique)`)
      seen.add(id)
    }
  })
  const lost = [...current].filter(id => !seen.has(id))
  if (lost.length) throw new SplitPlanError(`${lost.length} member insight${lost.length === 1 ? '' : 's'} would be left behind: ${lost.join(', ')}`)

  const statements = result.claims.map(c => normText(c.statement))
  if (new Set(statements).size !== statements.length) throw new SplitPlanError('two resulting claims have the same wording')

  const statusAfter = statusAfterResolution('flagged', 'extraction_fidelity', 'reworded')
  if (statusAfter !== 'active') throw new SplitPlanError('the claim gate would not restore a claim after a reworded resolution; refusing to write')

  const newId = input.newId ?? randomUUID
  const claims: SplitClaimPlan[] = result.claims.map((c, i) => ({
    id: i === 0 ? input.claimId : newId(),
    statement: c.statement.trim(),
    memberIds: [...c.memberRawInsightIds],
  }))

  const at = (input.now ?? (() => new Date()))().toISOString()
  const splitMap = {
    kind: 'split',
    original_claim_id: input.claimId,
    claims: claims.map((c, i) => ({
      claim_id: c.id, keeps_original_id: i === 0, statement: c.statement,
      member_raw_insight_ids: c.memberIds, facts: result.claims[i].units,
    })),
    also_fits: result.alsoBacks,
  }
  return {
    version: 1,
    runId: input.runId,
    claimId: input.claimId,
    flagId: input.flagId,
    expectedStatement: input.originalStatement,
    contextNote: input.contextNote,
    statusAfter,
    claims,
    audit: {
      verdictBefore: input.flag.verdict,
      offendingBefore: input.flag.offending,
      reasoningBefore: input.flag.reasoning,
      model: input.model,
      note: result.note,
      attempts: [...result.attempts, { kind: 'ledger', passages: result.passageCount, units: result.ledger }, splitMap],
    },
    flagRepair: {
      outcome: 'repaired', run_id: input.runId, at, note: result.note,
      split_into: claims.map(c => c.id),
    },
  }
}

// ── What it writes (dry run, tests) ─────────────────────────────

export type WriteRow = {
  table: 'claim_repairs' | 'claims' | 'claim_members' | 'claim_embeddings' | 'claim_flags'
  op: 'INSERT' | 'UPDATE' | 'MOVE' | 'UPSERT'
  /** One line a person can read. */
  summary: string
  /** The values written (long text is included whole; embeddings are computed at write time). */
  values: Record<string, unknown>
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Every row `apply_claim_split` writes for this plan, in the order it writes them. */
export function planRows(plan: SplitPlan): WriteRow[] {
  const rows: WriteRow[] = []
  const [first, ...rest] = plan.claims
  rows.push({
    table: 'claim_repairs', op: 'INSERT',
    summary: `audit row for ${plan.claimId} (outcome repaired): the old wording (${plan.expectedStatement.length} characters), the judge's verdict, the per-fact ledger and the split map`,
    values: {
      claim_id: plan.claimId, flag_id: plan.flagId, run_id: plan.runId, outcome: 'repaired', source: 'rewrite',
      original_statement: plan.expectedStatement, new_statement: first.statement,
      verdict_before: plan.audit.verdictBefore, offending_before: plan.audit.offendingBefore, reasoning_before: plan.audit.reasoningBefore,
      note: plan.audit.note, model: plan.audit.model,
    },
  })
  rows.push({
    table: 'claims', op: 'UPDATE',
    summary: `${plan.claimId} keeps its id: canonical_statement ${plan.expectedStatement.length} → ${first.statement.length} characters, needs_tagging = true`,
    values: { id: plan.claimId, canonical_statement: first.statement, needs_tagging: true },
  })
  rest.forEach((c, i) => {
    rows.push({
      table: 'claims', op: 'INSERT',
      summary: `NEW claim ${c.id} (piece ${i + 2} of ${plan.claims.length}, ${c.memberIds.length} insight${c.memberIds.length === 1 ? '' : 's'}): ${clip(c.statement, 140)}`,
      values: {
        id: c.id, canonical_statement: c.statement, status: plan.statusAfter, needs_tagging: true, split_from_claim_id: plan.claimId,
        context_note: '(copied from the original)', actionability: '(copied)', primary_audience: '(copied)', insight_type: '(copied)', qualifiers: '(copied)',
      },
    })
  })
  plan.claims.forEach((c, i) => {
    if (i === 0) return
    for (const m of c.memberIds) {
      rows.push({
        table: 'claim_members', op: 'MOVE',
        summary: `insight ${m}: claim ${plan.claimId} → ${c.id} (matched_by and match_confidence kept)`,
        values: { raw_insight_id: m, from_claim_id: plan.claimId, to_claim_id: c.id },
      })
    }
  })
  plan.claims.forEach((c, i) => {
    rows.push({
      table: 'claim_embeddings', op: 'UPSERT',
      summary: `${i === 0 ? 'replace' : 'create'} the vector of ${c.id} from its statement${plan.contextNote ? ' + context note' : ''} (computed at write time)`,
      values: { claim_id: c.id },
    })
  })
  rows.push({
    table: 'claims', op: 'UPDATE',
    summary: `aggregates (member_count, source_count, max_importance, best_evidence_type) recomputed for all ${plan.claims.length} claims; ${plan.claimId} status flagged → ${plan.statusAfter}`,
    values: { ids: plan.claims.map(c => c.id), member_counts: plan.claims.map(c => c.memberIds.length), status: plan.statusAfter },
  })
  rows.push({
    table: 'claim_flags', op: 'UPDATE',
    summary: `flag ${plan.flagId}: resolved_at = now, resolution = reworded, evidence.repair records the split into ${plan.claims.length} claims`,
    values: { id: plan.flagId, resolution: 'reworded', evidence_repair: plan.flagRepair },
  })
  return rows
}

/** The dry-run block: one line per row. */
export function describeSplit(plan: SplitPlan): string[] {
  const rows = planRows(plan)
  return [
    `   WOULD WRITE (one database transaction, apply_claim_split): ${rows.length} row operations`,
    ...rows.map(r => `     ${r.table.padEnd(16)} ${r.op.padEnd(6)} ${r.summary}`),
  ]
}

// ── Writing it ──────────────────────────────────────────────────

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null }

export type SplitDeps = {
  /** Embeds all texts in one call, in order (lib/embeddings.generateEmbeddingsBatch). */
  embedBatch: (texts: string[]) => Promise<number[][]>
  /** Calls a database function (supabase rpc). */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>
}

export type SplitOutcome =
  | { status: 'applied'; claimIds: string[] }
  | { status: 'already_applied' }
  | { status: 'stale'; reason: string }

/**
 * Write the split. Embeddings are computed before anything is written; the database function then runs as
 * one transaction. THROWS when the write did not happen (embedding or database error): the claim is exactly as
 * it was and the same plan can be applied again. Returns `stale` when the claim, its flag or its members
 * changed since they were read (nothing written; the repair must be redone), `already_applied` when an
 * earlier attempt had committed.
 */
export async function applySplit(plan: SplitPlan, deps: SplitDeps): Promise<SplitOutcome> {
  const texts = plan.claims.map(c => insightEmbeddingText({ statement: c.statement, context_note: plan.contextNote }))
  const vectors = await deps.embedBatch(texts)
  if (vectors.length !== plan.claims.length || vectors.some(v => !Array.isArray(v) || v.length === 0)) {
    throw new Error(`embedding for ${plan.claimId}: expected ${plan.claims.length} vectors, got ${vectors.length}`)
  }
  const payload = {
    status_after: plan.statusAfter,
    claims: plan.claims.map((c, i) => ({ id: c.id, statement: c.statement, member_ids: c.memberIds, embedding: `[${vectors[i].join(',')}]` })),
    audit: {
      verdict_before: plan.audit.verdictBefore, offending_before: plan.audit.offendingBefore, reasoning_before: plan.audit.reasoningBefore,
      attempts: plan.audit.attempts, note: plan.audit.note, model: plan.audit.model,
    },
    flag_repair: plan.flagRepair,
  }
  const { data, error } = await deps.rpc('apply_claim_split', {
    p_claim_id: plan.claimId, p_flag_id: plan.flagId, p_run_id: plan.runId, p_expected_statement: plan.expectedStatement, p_plan: payload,
  })
  if (error) throw new Error(`apply_claim_split ${plan.claimId}: ${error.message}`)
  const res = (data ?? {}) as { status?: string; reason?: string; claim_ids?: string[] }
  if (res.status === 'applied') return { status: 'applied', claimIds: res.claim_ids ?? plan.claims.map(c => c.id) }
  if (res.status === 'already_applied') return { status: 'already_applied' }
  if (res.status === 'stale') return { status: 'stale', reason: res.reason ?? 'the claim changed after it was read' }
  throw new Error(`apply_claim_split ${plan.claimId}: unexpected answer ${JSON.stringify(data)}`)
}

/**
 * applySplit with the plan saved on disk around it: saved BEFORE the write, removed once the claim no longer
 * needs it (written, already written, or stale). When the write throws, the plan stays on disk and the claim is
 * untouched, so the next run retries it with retryPendingSplits instead of paying for the model work again.
 */
export async function writeSplit(plan: SplitPlan, deps: SplitDeps, dir: string): Promise<SplitOutcome> {
  savePlan(dir, plan)
  const outcome = await applySplit(plan, deps) // throws -> the saved plan is kept
  dropPlan(dir, plan.claimId)
  return outcome
}

export type PendingReport = {
  applied: string[]
  alreadyApplied: string[]
  /** The claim changed since the plan was made: the plan was discarded and the claim will be repaired again. */
  stale: Array<{ claimId: string; reason: string }>
  /** The write failed again: the plan is kept for the next run, and the claim must not be repaired again meanwhile. */
  failed: Array<{ claimId: string; error: string }>
  unreadable: string[]
}

/** Retry every saved plan (call at the start of an --apply run, before any new model work). */
export async function retryPendingSplits(dir: string, deps: SplitDeps): Promise<PendingReport> {
  const { plans, unreadable } = loadPlans(dir)
  const report: PendingReport = { applied: [], alreadyApplied: [], stale: [], failed: [], unreadable }
  for (const plan of plans) {
    try {
      const outcome = await applySplit(plan, deps)
      if (outcome.status === 'applied') report.applied.push(plan.claimId)
      else if (outcome.status === 'already_applied') report.alreadyApplied.push(plan.claimId)
      else report.stale.push({ claimId: plan.claimId, reason: outcome.reason })
      dropPlan(dir, plan.claimId)
    } catch (err) {
      report.failed.push({ claimId: plan.claimId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}

/** True when the migration that creates apply_claim_split has been applied (a read-only probe: it writes nothing). */
export async function splitWriterInstalled(rpc: SplitDeps['rpc']): Promise<boolean> {
  const zero = '00000000-0000-0000-0000-000000000000'
  const { data, error } = await rpc('apply_claim_split', {
    p_claim_id: zero, p_flag_id: zero, p_run_id: 'probe', p_expected_statement: '',
    p_plan: { status_after: 'active', claims: [{ id: zero, statement: 'x', member_ids: [zero], embedding: '[0]' }, { id: '00000000-0000-0000-0000-000000000001', statement: 'y', member_ids: [zero], embedding: '[0]' }] },
  })
  if (error) return false
  return (data as { status?: string } | null)?.status === 'stale'
}

// ── Saved plans (a failed write is retried without redoing the model work) ──

const planFile = (dir: string, claimId: string) => path.join(dir, `${claimId}.json`)

export function savePlan(dir: string, plan: SplitPlan): string {
  mkdirSync(dir, { recursive: true })
  const file = planFile(dir, plan.claimId)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(plan))
  renameSync(tmp, file) // never a half-written plan
  return file
}

export function dropPlan(dir: string, claimId: string): void {
  const file = planFile(dir, claimId)
  if (existsSync(file)) unlinkSync(file)
}

/** Plans that were saved and not yet written. A file that does not parse is reported, not deleted. */
export function loadPlans(dir: string): { plans: SplitPlan[]; unreadable: string[] } {
  if (!existsSync(dir)) return { plans: [], unreadable: [] }
  const plans: SplitPlan[] = []
  const unreadable: string[] = []
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    try {
      const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SplitPlan
      if (p.version !== 1 || !p.claimId || !Array.isArray(p.claims) || p.claims.length < 2) throw new Error('not a split plan')
      plans.push(p)
    } catch {
      unreadable.push(f)
    }
  }
  return { plans, unreadable }
}
