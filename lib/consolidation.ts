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

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'
import type { EvidenceType, RawInsight } from './types'

const ADJUDICATION_MODEL = 'gpt-5-mini'

// Similarity floor for ANN candidates (cosine). Below this, no LLM call.
const CANDIDATE_THRESHOLD = 0.8
const CANDIDATE_COUNT = 5
// Verdict confidence needed to auto-merge without human review.
const AUTO_MERGE_CONFIDENCE = 0.85

// Evidence strength for choosing a claim's best_evidence_type.
const EVIDENCE_RANK: Record<EvidenceType, number> = {
  MetaAnalysis: 8, RCT: 7, Cohort: 6, CaseSeries: 5,
  Mechanistic: 4, Animal: 3, ExpertOpinion: 2, Other: 1,
}

let openaiInstance: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
    openaiInstance = new OpenAI({ apiKey })
  }
  return openaiInstance
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
  reasoning: string
}

const ADJUDICATION_SYSTEM = `
You decide whether a NEW medical/health insight expresses the SAME underlying claim as any of several EXISTING claims in a knowledge base.

"Same claim" means the same substantive assertion — same relationship, mechanism, recommendation, or finding — even if worded differently, at a different level of detail, or with different examples. Two statements are DIFFERENT if they make distinct assertions, apply to different populations/conditions in a way that changes the takeaway, or one is a general principle and the other a specific unrelated fact.

Return STRICT JSON:
{"verdict":"SAME|DIFFERENT|UNSURE","candidate_index":<1-based index of the matching existing claim, or null>,"confidence":<0..1>,"reasoning":"<one sentence>"}

- "SAME" + the index of the existing claim it matches, when you are confident they are the same claim.
- "DIFFERENT" when the new insight is a distinct claim from all candidates.
- "UNSURE" when it plausibly matches one but you cannot be confident (e.g. partial overlap, ambiguous scope).
confidence is your certainty in the verdict.
`.trim()

async function adjudicate(rawStatement: string, candidates: Candidate[]): Promise<Adjudication> {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.canonical_statement}${c.context_note ? ` (${c.context_note})` : ''}`)
    .join('\n')

  const completion = await getOpenAI().chat.completions.create({
    model: ADJUDICATION_MODEL,
    messages: [
      { role: 'system', content: ADJUDICATION_SYSTEM },
      { role: 'user', content: `NEW insight:\n${rawStatement}\n\nEXISTING claims:\n${list}` },
    ],
    response_format: { type: 'json_object' },
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) return { verdict: 'DIFFERENT', candidate_index: null, confidence: 0, reasoning: 'no model output' }
  try {
    const parsed = JSON.parse(raw) as Adjudication
    return {
      verdict: parsed.verdict === 'SAME' || parsed.verdict === 'UNSURE' ? parsed.verdict : 'DIFFERENT',
      candidate_index: typeof parsed.candidate_index === 'number' ? parsed.candidate_index : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning ?? '',
    }
  } catch {
    return { verdict: 'DIFFERENT', candidate_index: null, confidence: 0, reasoning: 'unparseable model output' }
  }
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

/** Attach a raw insight to an existing claim and refresh that claim's aggregates. */
async function attachMember(
  claimId: string,
  raw: RawInsight,
  confidence: number,
  matchedBy: 'auto' | 'human'
): Promise<void> {
  const { error: memErr } = await db().from('claim_members').insert({
    claim_id: claimId,
    raw_insight_id: raw.id,
    match_confidence: confidence,
    matched_by: matchedBy,
  })
  if (memErr) throw new Error(`Failed to attach claim member: ${memErr.message}`)
  await recomputeAggregates(claimId)
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
  const SWEEP_THRESHOLD = 0.86 // stricter than ingestion — these are claim-vs-claim

  const { data: claimsData, error } = await db()
    .from('claims')
    .select('id, canonical_statement, context_note, embedding')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load claims for sweep: ${error.message}`)

  const claims = (claimsData ?? []) as { id: string; canonical_statement: string; context_note: string | null; embedding: number[] | null }[]
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

export type ConsolidateCheckpoint = { processed: number; total: number; claims_created: number; reviews_queued: number }

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

  const { data: run } = await db()
    .from('pipeline_runs')
    .insert({ source_id: sourceId, kind: 'consolidate', status: 'running' })
    .select('id')
    .single()
  const runId = run?.id

  // Unconsolidated raw insights for this source (no membership yet), oldest first.
  const { data: rawRows, error } = await db()
    .from('raw_insights')
    .select('*')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load raw insights: ${error.message}`)

  const { data: existingMembers } = await db()
    .from('claim_members')
    .select('raw_insight_id')
  const memberSet = new Set((existingMembers ?? []).map((m: { raw_insight_id: string }) => m.raw_insight_id))

  // `pending` is *already* filtered to raw insights without a membership, so
  // it naturally shrinks across resumes. We therefore always iterate from 0 —
  // using the checkpoint index here would skip the tail on resume (the list is
  // shorter than it was when the checkpoint was written). `processed` is a
  // cumulative counter for progress display only.
  const pending = (rawRows ?? []).filter((r: RawInsight) => !memberSet.has(r.id)) as RawInsight[]

  let cp: ConsolidateCheckpoint = {
    processed: checkpoint?.processed ?? 0,
    total: (checkpoint?.processed ?? 0) + pending.length,
    claims_created: checkpoint?.claims_created ?? 0,
    reviews_queued: checkpoint?.reviews_queued ?? 0,
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
        await attachMember(chosen.id, raw, verdict.confidence, 'auto')
      } else if (verdict.verdict === 'DIFFERENT') {
        await createClaimFromRaw(raw)
        cp = { ...cp, claims_created: cp.claims_created + 1 }
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

  if (runId) {
    await db()
      .from('pipeline_runs')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        stats: { processed: cp.processed, claims_created: cp.claims_created, reviews_queued: cp.reviews_queued },
      })
      .eq('id', runId)
  }

  return { done: true, checkpoint: cp }
}
