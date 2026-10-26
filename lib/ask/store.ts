/**
 * Stage 5 — storage and the answer cache (design §6.1, §6.6).
 *
 * `ask_answers` is three things at once: the log the admin reads, the cache that
 * keeps a repeated question at $0, and (its `not_covered` rows) the content
 * roadmap. Service-role only; RLS on with no policies (migrations 034 and 035).
 */

import { supabaseAdmin } from '../supabaseServer'
import type { Sentence } from '../blocks'
import type { AskBackend, AskStatus, CachedInfo, RelatedTopic, StoredCandidate } from './types'

/** A stored answer is stale once the corpus has grown by more than this share (design §6.6). */
export const STALE_GROWTH = 0.1
/** Nearest earlier question that still counts as "the same question" (design §6.6). */
export const NEAR_QUESTION_SIMILARITY = 0.95

/** lower-cased, trimmed, whitespace-collapsed (design §6.1). */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The corpus has grown by more than 10% since the answer was written. */
export function isStale(corpusAtAnswer: number | null, corpusNow: number): boolean {
  if (!corpusAtAnswer || corpusAtAnswer <= 0) return false
  return corpusNow > corpusAtAnswer * (1 + STALE_GROWTH)
}

export type StageStats = Record<string, unknown>

/** A row of `ask_answers`, as the app reads it. */
export type AnswerRow = {
  id: string
  question: string
  question_norm: string
  status: AskStatus
  candidates: StoredCandidate[]
  cited_claim_ids: string[]
  body_markdown: string | null
  sentences: Sentence[] | null
  follow_ups: string[] | null
  related_topics: RelatedTopic[] | null
  thin: boolean
  dangling_markers: number
  model: string | null
  effort: string | null
  /** Which backend wrote it: 'api' or 'claude-code' (the developer's subscription). */
  backend: AskBackend
  latency_ms: number | null
  first_token_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  stage_stats: StageStats | null
  groundedness_score: number | null
  corpus_claims: number | null
  asked_by: string | null
  error: string | null
  created_at: string
}

const ANSWER_COLUMNS =
  'id, question, question_norm, status, candidates, cited_claim_ids, body_markdown, sentences, follow_ups, related_topics, ' +
  'thin, dangling_markers, model, effort, backend, latency_ms, first_token_ms, input_tokens, output_tokens, stage_stats, ' +
  'groundedness_score, corpus_claims, asked_by, error, created_at'

export type NewAnswer = Omit<AnswerRow, 'id' | 'created_at' | 'groundedness_score'> & {
  question_embedding: number[] | null
}

export async function saveAnswer(row: NewAnswer): Promise<string> {
  const { data, error } = await supabaseAdmin.from('ask_answers').insert(row).select('id').single()
  if (error) throw new Error(`saving the answer failed: ${error.message}`)
  return (data as { id: string }).id
}

/** The slice of the Supabase client the cache reads through (injectable so the lookup is testable). */
export type Db = typeof supabaseAdmin

export async function loadAnswer(id: string, db: Db = supabaseAdmin): Promise<AnswerRow | null> {
  const { data, error } = await db.from('ask_answers').select(ANSWER_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`reading the answer failed: ${error.message}`)
  return (data as AnswerRow | null) ?? null
}

/** Active claims right now; stored with each answer to judge staleness later. */
export async function corpusClaimCount(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
  if (error) throw new Error(`counting claims failed: ${error.message}`)
  return count ?? 0
}

export type CacheHit = { answer: AnswerRow; info: CachedInfo }

/**
 * Exact normalised question first, then the nearest earlier question at cosine
 * 0.95 or better. `failed` rows are never served. A cache error is a miss, not a
 * failed question.
 */
export async function findCached(
  norm: string,
  embedding: number[] | null,
  corpusNow: number,
  db: Db = supabaseAdmin
): Promise<CacheHit | null> {
  try {
    const { data: exact } = await db
      .from('ask_answers')
      .select(ANSWER_COLUMNS)
      .eq('question_norm', norm)
      .in('status', ['answered', 'not_covered'])
      .order('created_at', { ascending: false })
      .limit(1)
    const hit = (exact as AnswerRow[] | null)?.[0]
    if (hit) return { answer: hit, info: cachedInfo(hit, corpusNow, 'exact') }

    if (!embedding) return null
    const { data: near } = await db.rpc('match_ask_answers', {
      query_embedding: embedding,
      match_threshold: NEAR_QUESTION_SIMILARITY,
      match_count: 1,
    })
    const nearId = (near as { id: string }[] | null)?.[0]?.id
    if (!nearId) return null
    const answer = await loadAnswer(nearId, db)
    return answer ? { answer, info: cachedInfo(answer, corpusNow, 'near') } : null
  } catch {
    return null
  }
}

function cachedInfo(a: AnswerRow, corpusNow: number, match: CachedInfo['match']): CachedInfo {
  return { answered_at: a.created_at, stale: isStale(a.corpus_claims, corpusNow), match }
}

export async function saveFeedback(answerId: string, rating: 1 | -1, note: string | null): Promise<void> {
  const { error } = await supabaseAdmin.from('ask_feedback').insert({ answer_id: answerId, rating, note })
  if (error) throw new Error(`saving feedback failed: ${error.message}`)
}

/** Write the audit result back; `auditStats` is merged into `stage_stats.audit` for the measurement table. */
export async function setAudit(answerId: string, score: number | null, auditStats: Record<string, unknown>): Promise<void> {
  const { data } = await supabaseAdmin.from('ask_answers').select('stage_stats').eq('id', answerId).maybeSingle()
  const stats = { ...((data as { stage_stats: StageStats | null } | null)?.stage_stats ?? {}), audit: auditStats }
  const { error } = await supabaseAdmin
    .from('ask_answers')
    .update({ groundedness_score: score, stage_stats: stats })
    .eq('id', answerId)
  if (error) throw new Error(`saving the audit score failed: ${error.message}`)
}
