/**
 * Shared shapes for "Ask the Library" (docs/ask-the-library-design.md).
 */

/** Models for each stage (design §5). Opus writes the prose; Haiku does the support work. */
export const ASK_EXPAND_MODEL = 'claude-haiku-5-5'
export const ASK_COMPOSE_MODEL = 'claude-opus-5-5'
export const ASK_AUDIT_MODEL = 'claude-haiku-5-5'

/** Which backend answered (`LLM_BACKEND`, lib/llm.ts): the Anthropic API, or the local claude CLI on a subscription. */
export type AskBackend = 'api' | 'claude-code'

/** One claim retrieved for a question. */
export type Candidate = {
  id: string
  statement: string
  context: string | null
  evidenceType: string | null
  importance: number | null
  sourceCount: number
  insightType: string | null
  /** Newest source date among the claim's members, YYYY-MM-DD. */
  latestDate: string | null
  /** Best cosine similarity across all phrasings of the question. */
  similarity: number
  /** Ranking score (similarity plus the §6.2 bonuses). */
  score: number
}

/** A near-identical twin removed from the candidate set (kept in the record for the evidence panel). */
export type CollapsedTwin = { id: string; into: string; similarity: number }

/** What the stored `ask_answers.candidates` column holds, per candidate. */
export type StoredCandidate = { id: string; similarity: number; collapsed_into?: string }

export type RelatedTopic = { id: string; name: string; slug: string; similarity: number }

/** Evidence tiers from design §6.3. */
export type EvidenceTier = 'none' | 'thin' | 'ok'

export type AskStatus = 'answered' | 'not_covered' | 'failed'

/** A citation as the client sees it: `n` is the number printed in the text. */
export type Cited = { n: number; claim_id: string }

/** Events on the POST /api/ask NDJSON stream (design §6.7). */
export type AskEvent =
  | { type: 'retrieval'; count: number; thin: boolean; cached?: CachedInfo }
  | { type: 'delta'; text: string }
  | {
      type: 'done'
      answer_id: string
      cited: Cited[]
      follow_ups: string[]
      latency_ms: number
      /** The final cleaned markdown: identical to the concatenated deltas, sent so a client can reconcile. */
      body: string
      thin: boolean
      /** Nearest public topic pages ("Related pages"). */
      related_topics: RelatedTopic[]
      cached?: CachedInfo
    }
  | { type: 'not_covered'; answer_id: string; nearest_topics: RelatedTopic[]; cached?: CachedInfo }
  | { type: 'error'; message: string }

export type CachedInfo = {
  /** ISO timestamp the stored answer was written. */
  answered_at: string
  /** The corpus has grown by more than 10% since; the UI offers "refresh". */
  stale: boolean
  /** `exact` = same question text; `near` = a question with cosine >= 0.95. */
  match: 'exact' | 'near'
}
