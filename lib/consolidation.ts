/**
 * Consolidation stage (v2): raw_insights → claims via semantic dedup.
 *
 * For each raw insight not yet attached to a claim:
 *   1. ANN search over claims.embedding (match_claims RPC).
 *   2. No candidate above the floor → create a new claim (seed).
 *   3. Candidates → one LLM adjudication call (SAME / DIFFERENT / UNSURE).
 *      - SAME, high confidence  → attach as a member (auto-merge).
 *      - DIFFERENT               → create a new claim.
 *      - UNSURE / low-confidence → create a new claim + queue a merge_review.
 *
 * Raw insights are never mutated. Claims aggregate their members. Wrong
 * merges are reversible (detach a member). A periodic claim_sweep catches
 * near-duplicate claims that slipped through (e.g. from sources consolidated
 * concurrently).
 */

import { supabaseAdmin } from './supabaseServer'
import type { EvidenceType, RawInsight } from './types'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from './llm'
import { ADJUDICATION_V3 } from './adjudicationPrompts'
import { synthesizeEnrichedCanonical, ENRICH_MERGE_ENABLED, type EnrichResult } from './enrichMerge'
import { selectAllPaged } from './pagination'

// Judgment tier: deciding whether two claims are the same is the call that
// determines whether the library deduplicates correctly.
const ADJUDICATION_MODEL = CLAUDE_JUDGMENT_MODEL

// Similarity floor for ANN candidates (cosine). Below this, no LLM call — so an
// insight whose nearest claim sits under the floor becomes a singleton with no
// dedup check at all. This is the dominant gate on the ~7% dedup rate: on the
// 2026-07-25 corpus only 138 of 1,792 claims had a neighbour ≥0.80, while 498 sat
// in 0.75–0.80 (gated out) and 309 more in 0.72–0.75. Env-tunable so a
// re-consolidation experiment can lower it (e.g. 0.75) without a code edit;
// default 0.80 keeps current behaviour until deliberately changed.
const CANDIDATE_THRESHOLD = envNum('CONSOLIDATION_CANDIDATE_THRESHOLD', 0.8)
const CANDIDATE_COUNT = envInt('CONSOLIDATION_CANDIDATE_COUNT', 5)
// Verdict confidence needed to auto-merge without human review.
const AUTO_MERGE_CONFIDENCE = envNum('CONSOLIDATION_AUTO_MERGE_CONFIDENCE', 0.85)
// Claim-vs-claim floor for the periodic sweep — stricter than ingestion by
// default, since these are already-canonical claims. Env-tunable for the same
// re-consolidation experiment (lower it to catch the parked near-duplicates).
const SWEEP_THRESHOLD = envNum('SWEEP_THRESHOLD', 0.86)

/** Read a float from env, falling back to `def` on unset/blank/NaN. */
function envNum(name: string, def: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return def
  const n = Number(raw)
  return Number.isFinite(n) ? n : def
}
/** Read a positive integer from env, falling back to `def`. */
function envInt(name: string, def: number): number {
  const n = envNum(name, def)
  return Number.isInteger(n) && n > 0 ? n : def
}

// Stable reasoning stored when the adjudicator itself failed (CLI crash / usage
// limit) rather than returning a verdict. A constant string — never the raw error,
// which embedded the whole system prompt and flooded the merge cards (2026-07-25).
// A row carrying this is a re-adjudication candidate, not a genuine UNSURE call.
export const ADJUDICATION_FAILED_REASONING =
  'Automatic duplicate-check was unavailable (checker error); queued for manual review.'

// Evidence strength for choosing a claim's best_evidence_type.
const EVIDENCE_RANK: Record<EvidenceType, number> = {
  MetaAnalysis: 8, RCT: 7, Cohort: 6, CaseSeries: 5,
  Mechanistic: 4, Animal: 3, ExpertOpinion: 2, Other: 1,
}

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

type Candidate = { id: string; canonical_statement: string; context_note: string | null; similarity: number }

type Adjudication = {
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

async function adjudicate(rawStatement: string, candidates: Candidate[]): Promise<Adjudication> {
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
      const parsed = await claudeJson<Partial<Adjudication>>(ADJUDICATION_SYSTEM, user, 2000, ADJUDICATION_MODEL)
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
      lastErr = err
    }
  }
  // Exhausted retries: a checker failure is NOT a confident verdict. Return UNSURE
  // (consolidateSource then creates the claim AND queues a merge_review, surfacing
  // it) rather than a silent DIFFERENT that fabricates a split from a transport error.
  //
  // Store a STABLE, human-facing reasoning — never the raw error. The raw CLI error
  // embedded the entire system prompt (execFile's `Command failed: claude … <prompt>`),
  // which is what filled the merge cards with a wall of text (2026-07-25). The
  // technical detail is logged for debugging but must not reach merge_reviews.
  console.warn(
    `[consolidate] adjudication failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
  return {
    verdict: 'UNSURE',
    candidate_index: null,
    confidence: 0,
    enrich: false,
    reasoning: ADJUDICATION_FAILED_REASONING,
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
async function linkNearDuplicate(a: string, b: string, similarity: number | null): Promise<void> {
  if (a === b) return
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const { error } = await db()
    .from('claim_links')
    .upsert(
      { claim_id: lo, related_claim_id: hi, kind: 'near_duplicate', similarity },
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
      embedding: raw.embedding,
      member_count: 1,
      source_count: 1,
      needs_tagging: true,
    })
    .select('id')
    .single()
  if (error || !claim) throw new Error(`Failed to create claim: ${error?.message}`)

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
  if (opts?.enrich && ENRICH_MERGE_ENABLED) {
    await enrichClaimCanonical(claimId)
  }
}

/**
 * Enrich-merge (DB wrapper): rewrite one claim's `canonical_statement` to carry
 * every detail from its current members. Grounded in members only; the fidelity
 * guard in `synthesizeEnrichedCanonical` rejects a rewrite that invents a specific
 * no member carried, in which case the prior canonical is kept. Idempotent and
 * re-runnable — safe to call from `attachMember` inline OR from a batched sweep.
 * Returns the EnrichResult so a caller/sweep can log rejects for review.
 *
 * `claims.canonical_statement` is mutable; `raw_insights` are immutable and never
 * touched here.
 */
export async function enrichClaimCanonical(claimId: string): Promise<EnrichResult> {
  const { data: claim, error: claimErr } = await db()
    .from('claims')
    .select('canonical_statement')
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
  // its only member. Only multi-member claims can bury a side.
  if (statements.length <= 1) {
    return { canonical: claim.canonical_statement, changed: false, rejected: false, invented: [], reason: 'single member' }
  }

  const result = await synthesizeEnrichedCanonical(claim.canonical_statement, statements, { memberQuotes: quotes })

  if (result.changed) {
    const { error: updErr } = await db()
      .from('claims')
      .update({ canonical_statement: result.canonical, needs_tagging: true })
      .eq('id', claimId)
    if (updErr) throw new Error(`enrich: failed to update canonical: ${updErr.message}`)
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

/**
 * Merge `loserId` into `winnerId`: move the loser's members onto the winner,
 * mark the loser merged, and refresh the winner's aggregates. Reversible by
 * detaching members and reactivating. Used by the review queue's "accept".
 */
export async function mergeClaims(loserId: string, winnerId: string): Promise<void> {
  if (loserId === winnerId) return

  // Move the loser's members onto the winner. A raw_insight that is already a
  // member of the winner would collide on the (claim_id, raw_insight_id) PK and
  // abort the whole merge, so first drop the loser's rows that already exist on
  // the winner (they are redundant duplicates), then move the remainder.
  const { data: winnerMembers, error: wmErr } = await db()
    .from('claim_members').select('raw_insight_id').eq('claim_id', winnerId)
  if (wmErr) throw new Error(`Failed to read winner members: ${wmErr.message}`)
  const winnerIds = (winnerMembers ?? []).map((m: { raw_insight_id: string }) => m.raw_insight_id)
  if (winnerIds.length > 0) {
    const { error: dupErr } = await db()
      .from('claim_members').delete().eq('claim_id', loserId).in('raw_insight_id', winnerIds)
    if (dupErr) throw new Error(`Failed to drop duplicate members: ${dupErr.message}`)
  }
  const { error: moveErr } = await db()
    .from('claim_members')
    .update({ claim_id: winnerId, matched_by: 'human' })
    .eq('claim_id', loserId)
  if (moveErr) throw new Error(`Failed to move members: ${moveErr.message}`)

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

/**
 * Periodic claim-vs-claim sweep: catches near-duplicate claims that slipped
 * through (e.g. two sources consolidated concurrently each seeding their own
 * claim for the same idea). For each active claim, find higher-similarity
 * peers; adjudicate; auto-merge SAME/high-confidence, queue the rest for review.
 * Bounded per invocation by `timeBudgetMs`; idempotent (merged claims drop out).
 */
export async function sweepClaims(
  onProgress: (done: number, total: number, merged: number) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: { processed: number; total: number; merged: number } }> {
  const started = Date.now()

  // Paged: PostgREST caps an unpaginated select at 1000 rows, and an active
  // corpus passes that quickly — an unpaged read would sweep only the oldest
  // 1000 claims and never look at the newest, which are exactly the ones a
  // freshly-consolidated source just created.
  type SweepClaim = { id: string; canonical_statement: string; context_note: string | null; embedding: number[] | null }
  const claims = await selectAllPaged<SweepClaim>(
    (from, to) => db()
      .from('claims')
      .select('id, canonical_statement, context_note, embedding')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .range(from, to),
    500 // embeddings are 1536 floats each — keep the page small
  )
  const merged = new Set<string>()
  let processed = 0

  for (const claim of claims) {
    if (Date.now() - started > timeBudgetMs) {
      return { done: false, checkpoint: { processed, total: claims.length, merged: merged.size } }
    }
    processed++
    if (merged.has(claim.id) || !claim.embedding) continue

    const { data: candData } = await db().rpc('match_claims', {
      query_embedding: claim.embedding,
      match_threshold: SWEEP_THRESHOLD,
      match_count: CANDIDATE_COUNT + 1,
    })
    // Exclude self and already-merged peers.
    const peers = ((candData ?? []) as Candidate[]).filter(c => c.id !== claim.id && !merged.has(c.id))
    if (peers.length === 0) continue

    const verdict = await adjudicate(claim.canonical_statement, peers)
    const chosen =
      verdict.candidate_index && verdict.candidate_index >= 1 && verdict.candidate_index <= peers.length
        ? peers[verdict.candidate_index - 1]
        : peers[0]

    if (verdict.verdict === 'SAME' && verdict.confidence >= AUTO_MERGE_CONFIDENCE) {
      // Keep the older claim (loaded first) as the winner.
      await mergeClaims(chosen.id, claim.id)
      merged.add(chosen.id)
    } else if (verdict.verdict === 'UNSURE') {
      // Only queue if not already under review.
      const { data: existing } = await db()
        .from('merge_reviews')
        .select('id')
        .or(`and(claim_id.eq.${chosen.id},candidate_claim_id.eq.${claim.id}),and(claim_id.eq.${claim.id},candidate_claim_id.eq.${chosen.id})`)
        .limit(1)
      if (!existing || existing.length === 0) {
        await db().from('merge_reviews').insert({
          claim_id: chosen.id,
          candidate_claim_id: claim.id,
          similarity: chosen.similarity,
          model_verdict: verdict.verdict,
          model_confidence: verdict.confidence,
          model_reasoning: verdict.reasoning,
        })
      }
    }
    await onProgress(processed, claims.length, merged.size)
  }

  return { done: true, checkpoint: { processed, total: claims.length, merged: merged.size } }
}

export type ConsolidateCheckpoint = {
  processed: number
  total: number
  claims_created: number
  reviews_queued: number
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
    reviews_queued: checkpoint?.reviews_queued ?? 0,
    run_id: runId,
  }

  for (let i = 0; i < pending.length; i++) {
    if (Date.now() - started > timeBudgetMs) {
      return { done: false, checkpoint: { ...cp } }
    }
    const raw = pending[i]
    if (!raw.embedding) {
      // Should not happen (extraction embeds inline), but skip defensively.
      cp = { ...cp, processed: cp.processed + 1 }
      await onProgress(cp)
      continue
    }

    const { data: candData } = await db().rpc('match_claims', {
      query_embedding: raw.embedding,
      match_threshold: CANDIDATE_THRESHOLD,
      match_count: CANDIDATE_COUNT,
    })
    const candidates = (candData ?? []) as Candidate[]

    if (candidates.length === 0) {
      await createClaimFromRaw(raw)
      cp = { ...cp, claims_created: cp.claims_created + 1 }
    } else {
      const verdict = await adjudicate(raw.statement, candidates)
      const chosen =
        verdict.candidate_index && verdict.candidate_index >= 1 && verdict.candidate_index <= candidates.length
          ? candidates[verdict.candidate_index - 1]
          : candidates[0]

      if (verdict.verdict === 'SAME' && verdict.confidence >= AUTO_MERGE_CONFIDENCE) {
        await attachMember(chosen.id, raw, verdict.confidence, 'auto', { enrich: verdict.enrich })
      } else if (verdict.verdict === 'DIFFERENT') {
        const newClaimId = await createClaimFromRaw(raw)
        cp = { ...cp, claims_created: cp.claims_created + 1 }
        // Kept separate, but they were close enough for ANN to pair them and the
        // V3 prompt splits ONLY on genuine contradiction or a material
        // difference — so this is a variant of an existing idea, not new ground.
        // Record it (spec §6 "F3 fix"). Without the link the relationship is
        // lost: a reader loses the "these are variants" structure, and the
        // novelty metric (§9) can only ever see exact merges, under-reporting
        // refinements — which are the engine's actual value.
        await linkNearDuplicate(newClaimId, chosen.id, chosen.similarity)
      } else {
        // UNSURE, or SAME below the auto-merge bar → provisional claim + review.
        const newClaimId = await createClaimFromRaw(raw)
        cp = { ...cp, claims_created: cp.claims_created + 1 }
        await db().from('merge_reviews').insert({
          claim_id: newClaimId,
          candidate_claim_id: chosen.id,
          similarity: chosen.similarity,
          model_verdict: verdict.verdict,
          model_confidence: verdict.confidence,
          model_reasoning: verdict.reasoning,
        })
        cp = { ...cp, reviews_queued: cp.reviews_queued + 1 }
      }
    }

    cp = { ...cp, processed: cp.processed + 1 }
    await onProgress(cp)
  }

  await finishRun(runId, {
    processed: cp.processed,
    claims_created: cp.claims_created,
    reviews_queued: cp.reviews_queued,
  })

  return { done: true, checkpoint: cp }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
}
