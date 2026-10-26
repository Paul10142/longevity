/**
 * Stage 2 — retrieval (design §5, §6.1–§6.3). No model calls.
 *
 *   embeddings of each phrasing ─▶ search_claims (≤4, in parallel)
 *     ─▶ union by claim id (best similarity wins) ─▶ rank (§6.2)
 *     ─▶ drop near-identical twins (cosine >= 0.95) ─▶ cap at 150
 *     ─▶ evidence tier (§6.3): none / thin / ok
 *
 * The ranking, twin collapse and evidence floor are pure functions so the unit
 * tests (tests/ask.test.ts) pin them without a database.
 */

import { supabaseAdmin } from '../supabaseServer'
import type { Candidate, CollapsedTwin, EvidenceTier } from './types'

/** Lowest cosine a hit may have and still be considered (design §6.1 default). */
export const SEARCH_THRESHOLD = 0.45
/** Rows requested per phrasing; ef_search = 300 inside search_claims bounds what can come back. */
export const PER_QUERY_COUNT = 150
export const CANDIDATE_CAP = 150
/** Candidates at or above this cosine to a higher-ranked candidate are twins. */
export const TWIN_SIMILARITY = 0.95
/** How many top-ranked candidates are checked for twins (a few extra, so the cap still fills after collapse). */
const TWIN_CHECK_DEPTH = 200

/**
 * Evidence floor, design §6.3. Starting values, to be calibrated on the eval set:
 * fewer than `none` candidates at or above `similarity` -> not covered; up to
 * `thin` -> answer under a "thin evidence" banner; more -> normal.
 */
export const FLOOR = { similarity: 0.55, none: 5, thin: 15 }

/** A row from the search_claims RPC. */
export type RawHit = {
  id: string
  canonical_statement: string
  context_note: string | null
  best_evidence_type: string | null
  max_importance: number | null
  source_count: number | null
  insight_type: string | null
  latest_source_date: string | null
  similarity: number
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

/** 0..0.03, falling linearly to zero at five years old. */
export function recencyBonus(latestDate: string | null, now: Date): number {
  if (!latestDate) return 0
  const t = Date.parse(latestDate)
  if (Number.isNaN(t)) return 0
  const ageYears = (now.getTime() - t) / MS_PER_YEAR
  return 0.03 * Math.min(1, Math.max(0, 1 - ageYears / 5))
}

export function evidenceBonus(evidenceType: string | null): number {
  if (evidenceType === 'MetaAnalysis' || evidenceType === 'RCT') return 0.04
  if (evidenceType === 'Cohort') return 0.02
  return 0
}

/** Design §6.2: similarity + 0.02·min(source_count,5) + evidence bonus + recency, in cosine units. */
export function rankScore(hit: RawHit, now: Date): number {
  return (
    hit.similarity +
    0.02 * Math.min(hit.source_count ?? 0, 5) +
    evidenceBonus(hit.best_evidence_type) +
    recencyBonus(hit.latest_source_date, now)
  )
}

/** Union of per-phrasing results by claim id, keeping each claim's best similarity. */
export function unionHits(perQuery: RawHit[][]): RawHit[] {
  const best = new Map<string, RawHit>()
  for (const hits of perQuery) {
    for (const h of hits) {
      const prev = best.get(h.id)
      if (!prev || h.similarity > prev.similarity) best.set(h.id, h)
    }
  }
  return [...best.values()]
}

/** Score and sort (best first; ties broken by id so the order is stable). */
export function rankHits(hits: RawHit[], now: Date): Candidate[] {
  return hits
    .map(h => ({
      id: h.id,
      statement: h.canonical_statement,
      context: h.context_note,
      evidenceType: h.best_evidence_type,
      importance: h.max_importance,
      sourceCount: h.source_count ?? 0,
      insightType: h.insight_type,
      latestDate: h.latest_source_date,
      similarity: h.similarity,
      score: rankScore(h, now),
    }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

export type TwinPair = { claim_id: string; twin_id: string; similarity: number }

/**
 * Walk the ranked list best-first and drop any candidate that is a twin of one
 * already KEPT. (A twin of a dropped candidate stays: in a chain A≈B≈C where A and
 * C differ, C is not a duplicate of anything shown.) The dropped one is recorded
 * with the candidate it collapsed into, so the evidence panel can still show it.
 */
export function collapseTwins(
  ranked: Candidate[],
  pairs: TwinPair[],
  cap = CANDIDATE_CAP
): { kept: Candidate[]; collapsed: CollapsedTwin[] } {
  const twinsOf = new Map<string, Map<string, number>>()
  const link = (a: string, b: string, sim: number) => {
    const m = twinsOf.get(a) ?? new Map<string, number>()
    m.set(b, sim)
    twinsOf.set(a, m)
  }
  for (const p of pairs) {
    link(p.claim_id, p.twin_id, p.similarity)
    link(p.twin_id, p.claim_id, p.similarity)
  }

  const kept: Candidate[] = []
  const collapsed: CollapsedTwin[] = []
  for (const c of ranked) {
    const twins = twinsOf.get(c.id)
    let into: string | null = null
    if (twins) {
      for (const k of kept) {
        if (twins.has(k.id)) { into = k.id; break }
      }
    }
    if (into) {
      collapsed.push({ id: c.id, into, similarity: twinsOf.get(c.id)!.get(into)! })
    } else if (kept.length < cap) {
      kept.push(c)
    }
  }
  return { kept, collapsed }
}

/** Design §6.3. */
export function evidenceTier(candidates: Pick<Candidate, 'similarity'>[]): EvidenceTier {
  const strong = candidates.filter(c => c.similarity >= FLOOR.similarity).length
  if (strong < FLOOR.none) return 'none'
  if (strong <= FLOOR.thin) return 'thin'
  return 'ok'
}

export type Retrieval = {
  candidates: Candidate[]
  collapsed: CollapsedTwin[]
  tier: EvidenceTier
  /** Rows each phrasing returned before the union (diagnostics for the measurement table). */
  perQueryCounts: number[]
  /** Distinct claims after the union, before twins and the cap. */
  unionSize: number
}

export async function searchClaims(embedding: number[], threshold = SEARCH_THRESHOLD, count = PER_QUERY_COUNT): Promise<RawHit[]> {
  const { data, error } = await supabaseAdmin.rpc('search_claims', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: count,
  })
  if (error) throw new Error(`search_claims failed: ${error.message}`)
  return (data ?? []) as RawHit[]
}

async function findTwins(ids: string[]): Promise<TwinPair[]> {
  if (ids.length < 2) return []
  const { data, error } = await supabaseAdmin.rpc('claim_twins', { claim_ids: ids, min_similarity: TWIN_SIMILARITY })
  if (error) throw new Error(`claim_twins failed: ${error.message}`)
  return (data ?? []) as TwinPair[]
}

/** Run every phrasing's embedding through search_claims and reduce to the candidate set. */
export async function retrieve(embeddings: number[][], now = new Date()): Promise<Retrieval> {
  const perQuery = await Promise.all(embeddings.map(e => searchClaims(e)))
  const union = unionHits(perQuery)
  const ranked = rankHits(union, now)
  const checked = ranked.slice(0, TWIN_CHECK_DEPTH)
  const pairs = await findTwins(checked.map(c => c.id))
  const { kept, collapsed } = collapseTwins(checked, pairs)
  return {
    candidates: kept,
    collapsed,
    tier: evidenceTier(kept),
    perQueryCounts: perQuery.map(h => h.length),
    unionSize: union.length,
  }
}
