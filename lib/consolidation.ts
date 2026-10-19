/**
 * Consolidation stage (v2): raw_insights → claims via semantic dedup.
 *
 * For each raw insight not yet attached to a claim:
 *   1. ANN search over claim_embeddings (match_claims RPC).
 *   2. No candidate above the floor → create a new claim (seed).
 *   3. Candidates → one LLM adjudication call (SAME / DIFFERENT / UNSURE).
 *      - SAME at or above AUTO_MERGE_CONFIDENCE → attach as a member (auto-merge).
 *      - anything else → create a new claim, linked `near_duplicate` to the
 *        candidate, the verdict written on the link's `note` (verdictNote()).
 *
 * No merge_review is ever filed (Paul, 2026-10-12). Until then a SAME verdict
 * below the bar, and every UNSURE, filed one for him to read: 143 in a single
 * six-hour run, 348 pending. His own decisions on the sub-0.80 ones were 17
 * accepted / 36 rejected, and no confidence level separates the two (0.70–0.72:
 * 13/18; 0.75–0.78: 4/13), so the queue cost his time without a bar that could
 * shrink it. Those pairs now stay apart, and a later second-opinion pass finds
 * them by the link note: `judge:SAME@…`, `judge:UNSURE@…`, `judge:REFUSED`.
 * The same rule holds in sweepClaims. pairAction() is the rule; tests/
 * consolidationRule.test.ts pins it.
 *
 * Raw insights are never mutated. Claims aggregate their members. Wrong
 * merges are reversible (detach a member). A periodic claim_sweep catches
 * near-duplicate claims that slipped through (e.g. from sources consolidated
 * concurrently).
 */

import { supabaseAdmin } from './supabaseServer'
import type { EvidenceType, RawInsight } from './types'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'
import { claudeJson, CLAUDE_JUDGMENT_MODEL, ModelRefusalError, type Effort } from './llm'
import { rethrowIfUsageLimit } from './usageLimit'
import { ADJUDICATION_V3 } from './adjudicationPrompts'
import { synthesizeEnrichedCanonical, ENRICH_MERGE_ENABLED, type EnrichResult } from './enrichMerge'
import { selectAllPaged } from './pagination'
import { generateEmbedding, insightEmbeddingText } from './embeddings'
import { runOrdered } from './judgePipeline'

// Judgment tier (Opus 5.5): deciding whether two claims are the same is the call
// that determines whether the library deduplicates correctly.
const ADJUDICATION_MODEL = CLAUDE_JUDGMENT_MODEL

// Similarity floor for ANN candidates (cosine). Below this, no LLM call — so an
// insight whose nearest claim sits under the floor becomes a singleton with no
// dedup check at all. This is the dominant gate on the dedup rate: on the
// 2026-07-25 corpus only 138 of 1,792 claims had a neighbour ≥0.80, while 498 sat
// in 0.75–0.80 (gated out) and 309 more in 0.72–0.75.
//
// 0.80 → 0.75 on 2026-10-11, on three measurements (docs/plan-review-2026-10-11.md
// §5): 27% of active claims have their nearest neighbour in 0.75–0.80; on nine
// episodes the corpus holds twice (captions, then Deepgram) only 50% of the
// second copy's facts merged, and 42% of the misses sit in that band; and the
// production adjudicator, shown 31 pairs from the band, called 26 SAME (84%),
// flat across it. The 2026-08-14 "do not lower the floor" note rested on pairs
// at 0.82–0.87 and a 0.86 sweep — a different band. Recall is now tracked by
// scripts/evalTwinRecall.ts. Still env-tunable for experiments.
//
// 0.75 → 0.70 the same evening, once the benchmark had judged the misses band
// by band: 29/30 SAME in 0.70–0.75 on the twin episodes (estimated recall 72% →
// 85% when the gate reaches that band), and 18/23 SAME (78%) on random corpus
// pairs from the band, the five DIFFERENT verdicts reading as genuinely distinct
// facts. Below 0.70 the twin set was still 27/30 SAME, but there is no
// corpus-wide precision evidence there yet, so the gate stops here; judging
// every insight with no gate at all is the next experiment, not the default.
const CANDIDATE_THRESHOLD = envNum('CONSOLIDATION_CANDIDATE_THRESHOLD', 0.70)
// 5 → 8 (2026-10-11): on a lower floor the shortlist fills with near-topic
// neighbours, and the twin-episode misses included 28 pairs ABOVE 0.80 that a
// five-deep list had pushed out. The judge sees the extra rows at trivial cost.
const CANDIDATE_COUNT = envInt('CONSOLIDATION_CANDIDATE_COUNT', 8)
// Verdict confidence needed to auto-merge without human review.
//
// Lowered 0.85 → 0.80 (Paul, 2026-08-16) as the direct consequence of turning
// enrich-merge on. The bar was set high because a merge was LOSSY: the winner
// kept its own canonical, so auto-merging a "same claim" verdict quietly buried
// the other side's detail, and parking borderline pairs for a human was the only
// protection. Enrich-merge removes that failure mode — the surviving canonical
// now carries both sides — so a confident-enough SAME verdict no longer costs
// anything to act on.
//
// The evidence: every one of the 145 reviews parked under the old bar was a SAME
// verdict, 83 of them clustered at 0.82–0.83 — they failed a threshold, not a
// judgement. Accepting that band produced 77 merges with 0 failures and visibly
// richer canonicals. Below ~0.80 the verdicts are genuinely uncertain (0.60–0.78).
//
// Since 2026-10-12 "below the bar" means kept separate with a recorded verdict,
// not a review (see the header). The bar itself did not move.
export const AUTO_MERGE_CONFIDENCE = envNum('CONSOLIDATION_AUTO_MERGE_CONFIDENCE', 0.8)
// Claim-vs-claim floor for the periodic sweep. Was 0.86 — "stricter than
// ingestion, since these are already-canonical claims" — which defeated the
// sweep's purpose: it exists to catch the duplicates ingestion could not see
// (a later source seeding its own claim for an idea an earlier one already
// held), and those pairs sit exactly where ingestion's gate sits, not above it.
// At 0.86 nothing is left to find: the 2026-08-15 full sweep produced 14 merges
// in 11,502 claims. Same floor as ingestion from 2026-10-11.
const SWEEP_THRESHOLD = envNum('SWEEP_THRESHOLD', 0.70)

// How many of ONE source's facts the judge reads at once (lib/judgePipeline.ts).
// Writes still land in order and a verdict is reused only if the candidate list is
// unchanged by the writes ahead of it, so this changes speed, not decisions.
// 1 = the original one-at-a-time loop. Default 4: 3.2x on the judge stage alone, and
// tests/judgePipeline.test.ts shows the writes and the lists the judge sees are the
// sequential loop's (docs/judge-speedup.md).
const JUDGE_CONCURRENCY = envInt('CONSOLIDATION_JUDGE_CONCURRENCY', 4)
// A call started this close to the end of a tick would not finish inside it.
const JUDGE_LAUNCH_MARGIN_MS = envInt('CONSOLIDATION_JUDGE_LAUNCH_MARGIN_MS', 45_000)
// Reasoning depth for the judge's calls. Unset = the CLI/API default, which is what
// every verdict on file was made at. Lower values are faster; scripts/evalJudgeSpeedup.ts
// measures what they change before one is made the default.
const JUDGE_EFFORT = envEffort('CONSOLIDATION_JUDGE_EFFORT')

/** PostgREST returns a one-to-one embed as an object; some client versions wrap it
 *  in a one-element array. Either way, hand back the vector or null. */
function embeddingOf(rel: unknown): unknown {
  if (Array.isArray(rel)) return (rel[0] as { embedding?: unknown } | undefined)?.embedding ?? null
  return (rel as { embedding?: unknown } | null)?.embedding ?? null
}

/** Read a float from env, falling back to `def` on unset/blank/NaN. */
function envNum(name: string, def: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return def
  const n = Number(raw)
  return Number.isFinite(n) ? n : def
}
/** Read a reasoning-effort level from env; unset or unrecognised = no cap. */
function envEffort(name: string): Effort | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max' ? raw : undefined
}
/** Read a positive integer from env, falling back to `def`. */
function envInt(name: string, def: number): number {
  const n = envNum(name, def)
  return Number.isInteger(n) && n > 0 ? n : def
}

// LEGACY marker (no longer written as of 2026-08-15): reasoning stored on
// merge_reviews filed while the adjudicator itself was down. adjudicate() now
// throws AdjudicationUnavailableError instead, so the job retries rather than
// filing a junk row. Kept exported so scripts/readjudicateCheckerErrors.ts can
// find and re-adjudicate the historical rows.
export const ADJUDICATION_FAILED_REASONING =
  'Automatic duplicate-check was unavailable (checker error); queued for manual review.'

// The dedup checker itself failed after retries (usage-limit window / CLI
// crash). Message is truncated: the raw CLI error embeds the entire system
// prompt (execFile's `Command failed: claude … <prompt>`), which must reach
// neither merge_reviews nor jobs.last_error as a wall of text (2026-07-25).
export class AdjudicationUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Dedup adjudicator unavailable after retries: ${detail.slice(0, 200)}`)
    this.name = 'AdjudicationUnavailableError'
  }
}

// Evidence strength for choosing a claim's best_evidence_type.
const EVIDENCE_RANK: Record<EvidenceType, number> = {
  MetaAnalysis: 8, RCT: 7, Cohort: 6, CaseSeries: 5,
  Mechanistic: 4, Animal: 3, ExpertOpinion: 2, Other: 1,
}

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

export type Candidate = { id: string; canonical_statement: string; context_note: string | null; similarity: number }

export type Adjudication = {
  verdict: 'SAME' | 'DIFFERENT' | 'UNSURE'
  candidate_index: number | null // 1-based index into the candidate list, or null
  confidence: number
  // True when the new insight carries detail the matched claim's canonical lacks,
  // so the merge step rewrites the canonical to hold both sides (enrich-merge).
  // Only meaningful when verdict === 'SAME'.
  enrich: boolean
  reasoning: string
}

// Enrich-merge adjudication (V3), versioned in lib/adjudicationPrompts.ts so the
// measurement harness can run the exact before/after. Paul confirmed the model
// 2026-07-23: the engine merges liberally (same fact at any level of detail →
// SAME) and keeps separate ONLY on genuine contradiction/unrelatedness; the
// danger is not over-merging but *lossy* merging, fixed by rewriting the
// canonical to carry every detail when `enrich` is flagged.
const ADJUDICATION_SYSTEM = ADJUDICATION_V3

export async function adjudicate(
  rawStatement: string,
  candidates: Candidate[],
  opts: { effort?: Effort; model?: string } = {}
): Promise<Adjudication> {
  const effort = opts.effort ?? JUDGE_EFFORT
  const model = opts.model ?? ADJUDICATION_MODEL
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.canonical_statement}${c.context_note ? ` (${c.context_note})` : ''}`)
    .join('\n')
  const user = `NEW insight:\n${rawStatement}\n\nEXISTING claims:\n${list}`

  // Retry transient CLI/parse failures before giving up (the claude-code backend
  // intermittently returns prose, so claudeJson throws). Swallowing that as a
  // verdict corrupts the merge, so we retry with backoff first.
  let lastErr: unknown
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1500 * 2 ** (attempt - 1), 12_000)))
    try {
      const parsed = await claudeJson<Partial<Adjudication>>(ADJUDICATION_SYSTEM, user, 2000, model, effort)
      const verdict = parsed.verdict === 'SAME' || parsed.verdict === 'UNSURE' ? parsed.verdict : 'DIFFERENT'
      return {
        verdict,
        candidate_index: typeof parsed.candidate_index === 'number' ? parsed.candidate_index : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        // Default enrich conservatively: only honour it on a SAME verdict, and only
        // when the model set it true — a missing/false flag never triggers a rewrite.
        enrich: verdict === 'SAME' && parsed.enrich === true,
        reasoning: parsed.reasoning ?? '',
      }
    } catch (err) {
      // A safety-filter refusal is an answer about the text, not an outage:
      // retrying re-sends the same text to the same filter. Callers decide.
      if (err instanceof ModelRefusalError) throw err
      // A full usage window is not a verdict and retrying cannot help: let the
      // worker defer the job (no attempt spent) until the window reopens.
      rethrowIfUsageLimit(err)
      lastErr = err
    }
  }
  // Exhausted retries: the checker itself is down (usage-limit window / CLI
  // crash), which is a missing measurement, never a verdict. Throw, so the job
  // fails loudly and the supervisor's heal loop retries it with its checkpoint
  // intact — the same rule extractChunk applies. Until 2026-08-15 this returned
  // a fabricated UNSURE instead, which filed one junk merge_review PER INSIGHT
  // while the CLI was down (121 rows in the 05:08 UTC outage alone) — burying
  // the genuine review queue and, because sweepClaims skips any pair that has a
  // review row regardless of status, permanently blocking re-adjudication.
  console.warn(
    `[consolidate] adjudication failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
  throw new AdjudicationUnavailableError(lastErr)
}

/** A verdict as the pipeline acts on it: the adjudicator's, or REFUSED when the
 *  model's safety filter declined the pair. */
export type PairVerdict =
  | Adjudication
  | { verdict: 'REFUSED'; candidate_index: null; confidence: 0; enrich: false; reasoning: string }

/**
 * The merge rule, for both paths. Merge only a SAME at or above the auto-merge
 * bar; everything else — SAME below it, UNSURE, DIFFERENT, REFUSED — keeps the
 * two claims apart. There is no third outcome: nothing goes to human review.
 * UNSURE is treated like a low-confidence SAME by Paul's call (2026-10-12):
 * it is by definition less certain, and the V3 judge has never yet returned a
 * real one (the 34 UNSURE reviews on file were all checker-outage placeholders).
 */
export function pairAction(v: Pick<PairVerdict, 'verdict' | 'confidence'>): 'merge' | 'keep_separate' {
  return v.verdict === 'SAME' && v.confidence >= AUTO_MERGE_CONFIDENCE ? 'merge' : 'keep_separate'
}

/** The verdict as written on the pair's claim_links.note, so a second-opinion
 *  pass can select it (`note like 'judge:SAME@%'`) without a review table. */
export function verdictNote(v: Pick<PairVerdict, 'verdict' | 'confidence'>): string {
  return v.verdict === 'REFUSED' ? 'judge:REFUSED' : `judge:${v.verdict}@${v.confidence.toFixed(2)}`
}

/**
 * adjudicate() for the two pipeline paths: a safety-filter refusal on ONE pair
 * becomes a REFUSED verdict (kept separate, logged) instead of an error. Before
 * 2026-10-12 it threw, the whole consolidate job failed, and every retry hit the
 * same pair again — job 652e4ec4 failed this way on every attempt overnight.
 * Every other failure still throws, so an outage is never read as a verdict.
 */
async function judgePair(statement: string, candidates: Candidate[], label: string): Promise<PairVerdict> {
  try {
    return await adjudicate(statement, candidates)
  } catch (err) {
    if (!(err instanceof ModelRefusalError)) throw err
    console.warn(`[consolidate] safety filter declined ${label}; kept separate. ${err.message}`)
    return { verdict: 'REFUSED', candidate_index: null, confidence: 0, enrich: false, reasoning: err.message }
  }
}

/**
 * Record that two claims are variants of one idea (spec §6, table from migration
 * 013). Called when adjudication keeps a close pair SEPARATE — the split is
 * correct, but the relationship is real and is otherwise thrown away.
 *
 * The pair is stored smaller-uuid-first because the relationship is symmetric:
 * writing both directions would double-count every refinement in the §9 novelty
 * tally. Never fatal — a missing link degrades a metric, it does not corrupt the
 * corpus, so a failure here must not abort a source's consolidation.
 */
export async function linkNearDuplicate(
  a: string,
  b: string,
  similarity: number | null,
  note: string | null = null
): Promise<void> {
  if (a === b) return
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const { error } = await db()
    .from('claim_links')
    .upsert(
      { claim_id: lo, related_claim_id: hi, kind: 'near_duplicate', similarity, note },
      { onConflict: 'claim_id,related_claim_id,kind', ignoreDuplicates: true }
    )
  if (error) console.warn(`[consolidate] near-duplicate link failed (${lo}→${hi}): ${error.message}`)
}

/** Create a new claim seeded by a raw insight, and attach it as the seed member. */
async function createClaimFromRaw(raw: RawInsight): Promise<string> {
  const { data: claim, error } = await db()
    .from('claims')
    .insert({
      canonical_statement: raw.statement,
      context_note: raw.context_note,
      best_evidence_type: raw.evidence_type,
      max_importance: raw.importance,
      actionability: raw.actionability,
      primary_audience: raw.primary_audience,
      insight_type: raw.insight_type,
      qualifiers: raw.qualifiers,
      member_count: 1,
      source_count: 1,
      needs_tagging: true,
    })
    .select('id')
    .single()
  if (error || !claim) throw new Error(`Failed to create claim: ${error?.message}`)

  // The vector lives in claim_embeddings (migration 029), not on the claim row,
  // so its index entry is written once here and never rewritten by the
  // aggregate / enrich updates that follow on every attach. A claim without a
  // vector is invisible to match_claims forever, so a failed write must not
  // leave the half-made claim behind: it has no members or links yet, so
  // removing it and failing the insight (which the job retries) is the clean path.
  const { error: embErr } = await db()
    .from('claim_embeddings')
    .insert({ claim_id: claim.id, embedding: raw.embedding })
  if (embErr) {
    await db().from('claims').delete().eq('id', claim.id)
    throw new Error(`Failed to store claim embedding: ${embErr.message}`)
  }

  const { error: memErr } = await db().from('claim_members').insert({
    claim_id: claim.id,
    raw_insight_id: raw.id,
    match_confidence: 1,
    matched_by: 'seed',
  })
  if (memErr) throw new Error(`Failed to seed claim member: ${memErr.message}`)
  return claim.id as string
}

/** Attach a raw insight to an existing claim and refresh that claim's aggregates.
 *  When `enrich` is set AND enrich-merge is enabled (env `ENRICH_MERGE=1`), the
 *  claim's canonical is then rewritten to fold in the new member's detail
 *  (enrich-merge). Off by default so switching to the V3 adjudicator does not
 *  silently start mutating canonicals — see the surfaced inline-vs-sweep decision. */
async function attachMember(
  claimId: string,
  raw: RawInsight,
  confidence: number,
  matchedBy: 'auto' | 'human',
  opts?: { enrich?: boolean }
): Promise<void> {
  // Idempotent: a resumed/retried consolidate_source run can re-adjudicate an
  // insight already attached to this claim (the memberSet is loaded once per job
  // run, so an attach from earlier in the SAME run isn't reflected). Re-attaching
  // the identical (claim_id, raw_insight_id) is a genuine no-op, so DO NOTHING on
  // conflict rather than letting one existing member abort the whole source's
  // consolidation (the claim_members_pkey duplicate that stranded 48 insights).
  const { error: memErr } = await db().from('claim_members').upsert({
    claim_id: claimId,
    raw_insight_id: raw.id,
    match_confidence: confidence,
    matched_by: matchedBy,
  }, { onConflict: 'claim_id,raw_insight_id', ignoreDuplicates: true })
  if (memErr) throw new Error(`Failed to attach claim member: ${memErr.message}`)
  await recomputeAggregates(claimId)
  if (ENRICH_MERGE_ENABLED) {
    if (opts?.enrich) {
      await enrichClaimCanonical(claimId)
    } else {
      // The adjudicator judged this member carries no detail the canonical lacks,
      // so there is nothing to fold in and an LLM call would buy nothing. Stamp
      // anyway: `enriched_at` records that a claim's enrichment state has been
      // DECIDED, not that a rewrite happened — enrichClaimCanonical already
      // stamps on a no-change result for exactly that reason.
      //
      // Without this, every merge the adjudicator declines to enrich (~36% of
      // them — V3 flags enrich on 64%) left `enriched_at` NULL forever, which is
      // indistinguishable from a pre-enrich-era claim. Measured 2026-08-17:
      // right after the backfill reported 1,230/1,230 complete, 48 multi-member
      // claims read as un-enriched, and all 48 had been merged during that same
      // run. `scripts/backfillEnrich.ts` selects on `enriched_at IS NULL`, so the
      // count climbs forever, a rerun silently redoes finished work, and
      // enrichment coverage cannot be audited.
      await stampEnrichmentDecided(claimId)
    }
  }
}

/**
 * Record that a claim's enrichment state has been decided as of now.
 *
 * Deliberately does NOT touch `canonical_statement` — it is the bookkeeping half
 * of enrichment, used where the fold-in itself is a no-op (nothing to merge, or
 * the adjudicator judged the new member adds nothing).
 *
 * Note for a future full re-enrich pass: because this marks "decided", a sweep
 * that wants to re-examine claims the adjudicator declined must select on
 * `member_count > 1` rather than `enriched_at IS NULL`.
 */
async function stampEnrichmentDecided(claimId: string): Promise<void> {
  const { error } = await db()
    .from('claims')
    .update({ enriched_at: new Date().toISOString() })
    .eq('id', claimId)
  if (error) throw new Error(`enrich: failed to stamp enriched_at on ${claimId}: ${error.message}`)
}

/**
 * Enrich-merge (DB wrapper): rewrite one claim's `canonical_statement` to carry
 * every detail from its current members. Grounded in members only; the fidelity
 * guard in `synthesizeEnrichedCanonical` rejects a rewrite that invents a specific
 * no member carried or drops one a member carried, in which case the prior canonical is kept. Idempotent and
 * re-runnable — safe to call from `attachMember` inline OR from a batched sweep.
 * Returns the EnrichResult so a caller/sweep can log rejects for review.
 *
 * `claims.canonical_statement` is mutable; `raw_insights` are immutable and never
 * touched here.
 */
export async function enrichClaimCanonical(claimId: string): Promise<EnrichResult> {
  const { data: claim, error: claimErr } = await db()
    .from('claims')
    .select('canonical_statement, context_note')
    .eq('id', claimId)
    .single()
  if (claimErr || !claim) throw new Error(`enrich: failed to load claim ${claimId}: ${claimErr?.message}`)

  const { data: memberRows, error: memErr } = await db()
    .from('claim_members')
    .select('raw_insights(statement, direct_quote)')
    .eq('claim_id', claimId)
  if (memErr) throw new Error(`enrich: failed to load members: ${memErr.message}`)

  type Row = { raw_insights: { statement: string; direct_quote: string | null } | null }
  const members = (memberRows ?? []) as Row[]
  const statements = members.map(m => m.raw_insights?.statement ?? '').filter(Boolean)
  const quotes = members.map(m => m.raw_insights?.direct_quote ?? '').filter((q): q is string => Boolean(q))

  // A single-member claim has nothing to fold in — its canonical already equals
  // its only member. Only multi-member claims can bury a side. That is still a
  // decided enrichment state, so stamp it rather than returning silently and
  // leaving the claim indistinguishable from one never evaluated.
  if (statements.length <= 1) {
    await stampEnrichmentDecided(claimId)
    return { canonical: claim.canonical_statement, changed: false, rejected: false, invented: [], missing: [], reason: 'single member' }
  }

  const result = await synthesizeEnrichedCanonical(claim.canonical_statement, statements, { memberQuotes: quotes })
  // The guard keeps the prior wording (the members stay linked), so a rejection loses nothing — but
  // its rate is the signal that the rewrite is dropping or inventing numbers, so it is always logged.
  if (result.rejected) {
    console.log(`[enrich] guard rejected the rewrite of claim ${claimId} (${statements.length} members) — prior canonical kept: ${result.reason}`)
  } else if (result.retriedWithThinking) {
    console.log(`[enrich] fast rewrite of claim ${claimId} not accepted, thinking re-run used (${result.fastRejection})`)
  }

  // `enriched_at` marks "this claim's members have been folded in", and is
  // stamped on every successful evaluation — including one that changed nothing,
  // which is still a real answer ("already carries every member's detail").
  // Without it the column was dead and there was no way to tell an enriched
  // claim from one that predates enrich-merge, which is exactly what the
  // backfill (scripts/backfillEnrich.ts) needs to resume safely.
  const enrichedAt = new Date().toISOString()
  const patch = result.changed
    ? { canonical_statement: result.canonical, needs_tagging: true, enriched_at: enrichedAt }
    : { enriched_at: enrichedAt }
  const { error: updErr } = await db().from('claims').update(patch).eq('id', claimId)
  if (updErr) throw new Error(`enrich: failed to update claim ${claimId}: ${updErr.message}`)

  if (result.changed) {
    // The vector must follow the text it indexes. Until 2026-10-11 a claim kept
    // its FIRST member's vector for life, so a claim that had absorbed six
    // members was still found — or missed — by the wording of the first one.
    const vector = await generateEmbedding(
      insightEmbeddingText({ statement: result.canonical, context_note: claim.context_note })
    )
    const { error: embErr } = await db()
      .from('claim_embeddings')
      .upsert({ claim_id: claimId, embedding: vector, updated_at: new Date().toISOString() }, { onConflict: 'claim_id' })
    if (embErr) throw new Error(`enrich: failed to refresh the embedding of ${claimId}: ${embErr.message}`)
  }

  return result
}

/** Recompute a claim's rollups from its current members. */
export async function recomputeAggregates(claimId: string): Promise<void> {
  const { data: members, error } = await db()
    .from('claim_members')
    .select('raw_insights(source_id, importance, evidence_type)')
    .eq('claim_id', claimId)
  if (error) throw new Error(`Failed to load members for aggregates: ${error.message}`)

  type MemberRow = { source_id: string; importance: number | null; evidence_type: EvidenceType }
  const rows: MemberRow[] = (members ?? []).map(
    (m: { raw_insights: unknown }) => m.raw_insights as MemberRow
  )

  if (rows.length === 0) {
    // No members left — retire the claim so it drops out of active views.
    await db().from('claims').update({ status: 'retired' }).eq('id', claimId)
    return
  }

  const sourceCount = new Set(rows.map(r => r.source_id)).size
  const maxImportance = rows.reduce<number | null>(
    (max, r) => (r.importance != null && (max == null || r.importance > max) ? r.importance : max),
    null
  )
  const bestEvidence = rows.reduce<EvidenceType>(
    (best, r) => (EVIDENCE_RANK[r.evidence_type] > EVIDENCE_RANK[best] ? r.evidence_type : best),
    'Other'
  )

  await db()
    .from('claims')
    .update({
      member_count: rows.length,
      source_count: sourceCount,
      max_importance: maxImportance,
      best_evidence_type: bestEvidence,
    })
    .eq('id', claimId)
}

/** Rows per read/write batch when merging. At or below the 1000-row server cap. */
const MERGE_BATCH = 500

/**
 * Merge `loserId` into `winnerId`: move the loser's members AND topic filings
 * onto the winner, mark the loser merged, and refresh the winner's aggregates.
 * Reversible by detaching members and reactivating. Used by the review queue's
 * "accept" and by the sweep's auto-merge.
 */
export async function mergeClaims(loserId: string, winnerId: string): Promise<void> {
  if (loserId === winnerId) return

  // Move the loser's members onto the winner. A raw_insight that is already a
  // member of the winner would collide on the (claim_id, raw_insight_id) PK and
  // abort the whole merge, so first drop the loser's rows that already exist on
  // the winner (they are redundant duplicates), then move the remainder.
  //
  // Paged: this read was unpaginated, so on a winner with more than 1000 members
  // PostgREST silently returned the first 1000 (see lib/pagination.ts) — the
  // dedup-delete below then missed the rest and the move aborted the whole merge
  // on the PK. Ordered by raw_insight_id so paging cannot skip or repeat.
  const winnerMembers = await selectAllPaged<{ raw_insight_id: string }>(
    (from, to) =>
      db()
        .from('claim_members')
        .select('raw_insight_id')
        .eq('claim_id', winnerId)
        .order('raw_insight_id', { ascending: true })
        .range(from, to),
    MERGE_BATCH
  )
  const winnerIds = winnerMembers.map(m => m.raw_insight_id)
  // Chunked: a single `.in()` carrying thousands of ids overflows the request URL.
  for (let i = 0; i < winnerIds.length; i += MERGE_BATCH) {
    const { error: dupErr } = await db()
      .from('claim_members')
      .delete()
      .eq('claim_id', loserId)
      .in('raw_insight_id', winnerIds.slice(i, i + MERGE_BATCH))
    if (dupErr) throw new Error(`Failed to drop duplicate members: ${dupErr.message}`)
  }
  const { error: moveErr } = await db()
    .from('claim_members')
    .update({ claim_id: winnerId, matched_by: 'human' })
    .eq('claim_id', loserId)
  if (moveErr) throw new Error(`Failed to move members: ${moveErr.message}`)

  // Move the loser's topic filings onto the winner. Without this they stayed
  // pointed at the retired claim: the winner silently lost those topics and the
  // rows became orphans (229 of them in the live DB before this fix). The
  // `needs_tagging` flag set below only papers over it when a re-tag actually
  // runs — every breadth-extraction run so far has deferred tagging with
  // SKIP_TAGGING=1, so in practice the filings were simply lost.
  //
  // Read → upsert → delete-only-what-was-read, in batches: the same shape as
  // mergeTopics, which keeps a concurrent tag_claims insert from being dropped
  // and dodges the 1000-row read cap. `ignoreDuplicates` keeps the winner's own
  // filing (and its confidence) when both claims sit under the same topic.
  type TopicLink = { topic_id: string; confidence: number | null; assigned_by: string }
  for (let pass = 0; pass < 100; pass++) {
    const { data: links, error: readErr } = await db()
      .from('claim_topics')
      .select('topic_id, confidence, assigned_by')
      .eq('claim_id', loserId)
      .limit(MERGE_BATCH)
    if (readErr) throw new Error(`Failed to read merged claim's topics: ${readErr.message}`)
    const rows = (links ?? []) as TopicLink[]
    if (rows.length === 0) break

    const { error: upErr } = await db()
      .from('claim_topics')
      .upsert(
        rows.map(r => ({
          claim_id: winnerId,
          topic_id: r.topic_id,
          confidence: r.confidence,
          // Preserved, not overwritten: assigned_by is constrained to ai/human.
          assigned_by: r.assigned_by,
        })),
        { onConflict: 'claim_id,topic_id', ignoreDuplicates: true }
      )
    if (upErr) throw new Error(`Failed to move topics onto the surviving claim: ${upErr.message}`)

    const { error: delErr } = await db()
      .from('claim_topics')
      .delete()
      .eq('claim_id', loserId)
      .in('topic_id', rows.map(r => r.topic_id))
    if (delErr) throw new Error(`Failed to clear merged claim's topics: ${delErr.message}`)
  }

  const { error: markErr } = await db()
    .from('claims')
    .update({ status: 'merged_into', merged_into_id: winnerId, member_count: 0, source_count: 0 })
    .eq('id', loserId)
  if (markErr) throw new Error(`Failed to mark merged claim: ${markErr.message}`)

  await db().from('claims').update({ needs_tagging: true }).eq('id', winnerId)
  await recomputeAggregates(winnerId)
  // The winner keeps its own canonical, so the loser's members' detail would be
  // buried exactly as in attachMember. Fold it in when enrich-merge is enabled.
  if (ENRICH_MERGE_ENABLED) {
    await enrichClaimCanonical(winnerId)
  }
}

export type SweepCheckpoint = {
  processed: number
  total: number
  merged: number
  // Keyset cursor: the (created_at, id) of the last claim fully swept. The next
  // tick resumes strictly AFTER it. Null on a fresh run.
  cursor_created_at: string | null
  cursor_id: string | null
}

/**
 * Periodic claim-vs-claim sweep: catches near-duplicate claims that slipped
 * through (e.g. two sources consolidated concurrently each seeding their own
 * claim for the same idea). For each active claim, find higher-similarity
 * peers; adjudicate; auto-merge SAME/high-confidence; record the rest on a
 * near_duplicate link (pairAction / verdictNote — no reviews since 2026-10-12).
 * Bounded per invocation by `timeBudgetMs`; idempotent (merged claims drop out).
 *
 * **Checkpoint-resumable.** A single tick rarely sweeps the whole corpus, so it
 * yields on `timeBudgetMs` and the worker re-invokes it. Without a cursor the
 * scan restarted from the oldest claim every tick — the non-merging front claims
 * persist there and got re-adjudicated forever while the newer claims (the ones a
 * fresh consolidation just created, i.e. the likeliest duplicates) were never
 * reached. Resuming after the last-swept `(created_at, id)` makes each tick
 * advance through the full corpus exactly once.
 */
export async function sweepClaims(
  onProgress: (done: number, total: number, merged: number) => Promise<void>,
  timeBudgetMs = 220_000,
  checkpoint?: Partial<SweepCheckpoint>
): Promise<{ done: boolean; checkpoint: SweepCheckpoint }> {
  const started = Date.now()
  const priorProcessed = checkpoint?.processed ?? 0
  const priorMerged = checkpoint?.merged ?? 0
  const cursorTs = checkpoint?.cursor_created_at ?? null
  const cursorId = checkpoint?.cursor_id ?? null

  // Paged: PostgREST caps an unpaginated select at 1000 rows, and an active
  // corpus passes that quickly. Ordered by (created_at, id) — id breaks ties so
  // batch-inserted claims sharing a created_at can't be skipped or repeated by
  // the keyset resume below.
  type SweepClaim = { id: string; created_at: string; canonical_statement: string; context_note: string | null; claim_embeddings: unknown }
  const claims = await selectAllPaged<SweepClaim>(
    (from, to) => {
      let q = db()
        .from('claims')
        // The vector comes from the side table (migration 029), embedded one-to-one.
        .select('id, created_at, canonical_statement, context_note, claim_embeddings(embedding)')
        .eq('status', 'active')
      // Resume strictly after the cursor: created_at > ts OR (created_at = ts AND id > id).
      // Timestamp is double-quoted because it contains a space and a `+` offset.
      if (cursorTs && cursorId) {
        q = q.or(`created_at.gt."${cursorTs}",and(created_at.eq."${cursorTs}",id.gt.${cursorId})`)
      }
      return q
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    },
    500 // embeddings are 1536 floats each — keep the page small
  )
  const merged = new Set<string>()
  let processed = priorProcessed
  const total = priorProcessed + claims.length
  let lastTs = cursorTs
  let lastId = cursorId

  const cp = (done: boolean): { done: boolean; checkpoint: SweepCheckpoint } => ({
    done,
    checkpoint: { processed, total, merged: priorMerged + merged.size, cursor_created_at: lastTs, cursor_id: lastId },
  })

  for (const claim of claims) {
    // Budget check BEFORE touching this claim — so the cursor we yield points at
    // the previous, fully-swept claim and this one is re-loaded next tick.
    if (Date.now() - started > timeBudgetMs) {
      return cp(false)
    }
    processed++
    lastTs = claim.created_at
    lastId = claim.id
    const embedding = embeddingOf(claim.claim_embeddings)
    if (merged.has(claim.id) || !embedding) continue

    const { data: candData, error: candErr } = await db().rpc('match_claims', {
      query_embedding: embedding,
      match_threshold: SWEEP_THRESHOLD,
      match_count: CANDIDATE_COUNT + 1,
    })
    // Same rule as consolidateSource: a failed search must not read as "no
    // peers" — that silently skipped the claim and moved the cursor past it.
    if (candErr) throw new Error(`match_claims failed for claim ${claim.id}: ${candErr.message}`)
    // Exclude self and already-merged peers.
    const peers = ((candData ?? []) as Candidate[]).filter(c => c.id !== claim.id && !merged.has(c.id))
    if (peers.length === 0) continue

    const verdict = await judgePair(claim.canonical_statement, peers, `sweep of claim ${claim.id}`)
    const chosen =
      verdict.candidate_index && verdict.candidate_index >= 1 && verdict.candidate_index <= peers.length
        ? peers[verdict.candidate_index - 1]
        : peers[0]

    if (pairAction(verdict) === 'merge') {
      // Keep the older claim (loaded first) as the winner.
      await mergeClaims(chosen.id, claim.id)
      merged.add(chosen.id)
    } else if (verdict.verdict !== 'DIFFERENT') {
      // Low-confidence SAME, UNSURE, or REFUSED: both claims already exist, so
      // keeping them apart costs nothing — record the verdict for a second
      // opinion instead of filing a review (until 2026-10-12, UNSURE filed one).
      // A DIFFERENT pair is left unlinked here, as it always was in the sweep.
      await linkNearDuplicate(chosen.id, claim.id, chosen.similarity, verdictNote(verdict))
    }
    await onProgress(processed, total, priorMerged + merged.size)
  }

  return cp(true)
}

export type ConsolidateCheckpoint = {
  processed: number
  total: number
  claims_created: number
  // Pairs kept apart on a low-confidence SAME or an UNSURE (no longer reviewed).
  kept_separate: number
  // Pairs the model's safety filter declined; kept apart, logged.
  refused: number
  run_id?: string | null
}

/**
 * Consolidate one source's raw insights into claims, resuming from `checkpoint`.
 * Only raw insights without a claim_member are processed, so re-running is safe.
 */
export async function consolidateSource(
  sourceId: string,
  checkpoint: Partial<ConsolidateCheckpoint> | undefined,
  onProgress: (cp: ConsolidateCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: ConsolidateCheckpoint }> {
  const started = Date.now()

  const runId = await startOrResumeRun('consolidate', sourceId, checkpoint?.run_id)

  try {
  // Unconsolidated raw insights for this source (no membership yet), oldest
  // first. Paged: a long transcript can exceed the 1000-row server cap on its
  // own, and a truncated read here would leave that source's tail permanently
  // unconsolidated — invisibly, since the job would report done.
  const allRows = await selectAllPaged<RawInsight>(
    (from, to) => db()
      .from('raw_insights')
      .select('*')
      .eq('source_id', sourceId)
      .order('created_at', { ascending: true })
      .range(from, to)
  )

  // Which of THIS source's insights already have a membership, looked up in
  // batches. A single unpaginated `from('claim_members').select(...)` is capped
  // by PostgREST at 1000 rows (db-max-rows), so once the corpus passed 1000
  // memberships the set silently lost its tail: consolidated insights looked
  // pending, were re-adjudicated (a judgment call each), and could be attached
  // to a SECOND claim — one insight's provenance split across two claims, both
  // counting it. Scoping to this source also keeps the lookup O(source).
  const memberSet = new Set<string>()
  for (let i = 0; i < allRows.length; i += 200) {
    const ids = allRows.slice(i, i + 200).map(r => r.id)
    const { data: memberRows, error: memErr } = await db()
      .from('claim_members')
      .select('raw_insight_id')
      .in('raw_insight_id', ids)
    if (memErr) throw new Error(`Failed to load existing memberships: ${memErr.message}`)
    for (const m of (memberRows ?? []) as { raw_insight_id: string }[]) memberSet.add(m.raw_insight_id)
  }

  // `pending` is *already* filtered to raw insights without a membership, so
  // it naturally shrinks across resumes. We therefore always iterate from 0 —
  // using the checkpoint index here would skip the tail on resume (the list is
  // shorter than it was when the checkpoint was written). `processed` is a
  // cumulative counter for progress display only.
  const pending = allRows.filter(r => !memberSet.has(r.id))

  let cp: ConsolidateCheckpoint = {
    processed: checkpoint?.processed ?? 0,
    total: (checkpoint?.processed ?? 0) + pending.length,
    claims_created: checkpoint?.claims_created ?? 0,
    kept_separate: checkpoint?.kept_separate ?? 0,
    refused: checkpoint?.refused ?? 0,
    run_id: runId,
  }

  // Search and judge may run ahead (CONSOLIDATION_JUDGE_CONCURRENCY); the writes
  // below run strictly in order, each after every earlier write has landed, and a
  // verdict is used only if the candidate list is the one it was judged on.
  const search = async (raw: RawInsight): Promise<Candidate[] | null> => {
    if (!raw.embedding) return null // Should not happen (extraction embeds inline); skipped below.
    const { data: candData, error: candErr } = await db().rpc('match_claims', {
      query_embedding: raw.embedding,
      match_threshold: CANDIDATE_THRESHOLD,
      match_count: CANDIDATE_COUNT,
    })
    // A failed search is a MISSING measurement, never "no candidates". Until
    // 2026-10-11 the error was discarded, so a timed-out or dropped search made
    // the insight a brand-new claim with no duplicate check at all — silently,
    // and the job reported success. match_claims has run up to 7.9 s against an
    // 8 s statement timeout (pg_stat_statements), so this was a live path. Throw:
    // the job fails, backs off, and resumes from this same insight.
    if (candErr) throw new Error(`match_claims failed for insight ${raw.id}: ${candErr.message}`)
    return (candData ?? []) as Candidate[]
  }

  const tickStart = Date.now()
  const { applied, stats } = await runOrdered<RawInsight, Candidate, PairVerdict>(pending, {
    concurrency: JUDGE_CONCURRENCY,
    outOfTime: () => Date.now() - started > timeBudgetMs,
    canLaunch: () => Date.now() - started < timeBudgetMs - JUDGE_LAUNCH_MARGIN_MS,
    search,
    judge: (raw, candidates) => judgePair(raw.statement, candidates, `insight ${raw.id}`),
    apply: async (raw, candidates, verdict) => {
      if (candidates === null) {
        cp = { ...cp, processed: cp.processed + 1 }
        await onProgress(cp)
        return
      }
      if (candidates.length === 0 || !verdict) {
        await createClaimFromRaw(raw)
        cp = { ...cp, claims_created: cp.claims_created + 1 }
      } else {
        const chosen =
          verdict.candidate_index && verdict.candidate_index >= 1 && verdict.candidate_index <= candidates.length
            ? candidates[verdict.candidate_index - 1]
            : candidates[0]

        if (pairAction(verdict) === 'merge') {
          await attachMember(chosen.id, raw, verdict.confidence, 'auto', { enrich: verdict.enrich })
        } else {
          const newClaimId = await createClaimFromRaw(raw)
          cp = { ...cp, claims_created: cp.claims_created + 1 }
          // Kept separate, but they were close enough for ANN to pair them and the
          // V3 prompt splits ONLY on genuine contradiction or a material
          // difference — so this is a variant of an existing idea, not new ground.
          // Record it (spec §6 "F3 fix"). Without the link the relationship is
          // lost: a reader loses the "these are variants" structure, and the
          // novelty metric (§9) can only ever see exact merges, under-reporting
          // refinements — which are the engine's actual value. The note carries
          // the verdict, so the low-confidence SAME / UNSURE / REFUSED pairs that
          // used to become merge_reviews can be found for a second opinion.
          await linkNearDuplicate(newClaimId, chosen.id, chosen.similarity, verdictNote(verdict))
          if (verdict.verdict === 'REFUSED') cp = { ...cp, refused: cp.refused + 1 }
          else if (verdict.verdict !== 'DIFFERENT') cp = { ...cp, kept_separate: cp.kept_separate + 1 }
        }
      }
      cp = { ...cp, processed: cp.processed + 1 }
      await onProgress(cp)
    },
  })
  // The measured cost per fact, in the log, so the speed of a real run is read from the run
  // and not estimated: `reused` early verdicts kept, `stale` ones re-judged because a write
  // ahead of them changed the candidate list.
  if (applied > 0) {
    const secs = (Date.now() - tickStart) / 1000
    console.log(
      `[consolidate] source ${sourceId.slice(0, 8)}: ${applied} fact(s) in ${secs.toFixed(0)}s = ${(secs / applied).toFixed(1)} s/fact ` +
        `(judge concurrency ${JUDGE_CONCURRENCY}; judged ${stats.judged}, early verdict reused ${stats.reused}, re-judged ${stats.stale}, no candidates ${stats.unjudged})`
    )
  }
  // Out of time before the end: yield, and the next tick resumes from what is
  // still unconsolidated.
  if (applied < pending.length) return { done: false, checkpoint: { ...cp } }

  await finishRun(runId, {
    processed: cp.processed,
    claims_created: cp.claims_created,
    kept_separate: cp.kept_separate,
    refused: cp.refused,
  })

  return { done: true, checkpoint: cp }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
}
