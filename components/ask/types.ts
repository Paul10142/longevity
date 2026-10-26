/**
 * Types for the Ask the Library UI.
 *
 * The stream events are the contract in docs/ask-the-library-design.md §6.7.
 * Fields marked optional are things the UI will show when the backend sends
 * them and quietly skips when it does not.
 */

export type TopicLink = { name: string; slug: string }

/** One citation: marker `[n]` in the prose resolves to this claim. */
export type Cited = {
  n: number
  claim_id: string
  /** The claim's own statement, when the stream carries it. */
  statement?: string | null
}

export type AskEvent =
  | { type: "retrieval"; count: number; thin: boolean; cached?: boolean; answered_at?: string | null }
  | { type: "delta"; text: string }
  | {
      type: "done"
      answer_id: string
      cited: Cited[]
      follow_ups: string[]
      latency_ms: number
      related_topics?: TopicLink[]
      cached?: boolean
      answered_at?: string | null
    }
  | { type: "not_covered"; nearest_topics: TopicLink[] }
  | { type: "error"; message: string }

export type AskPhase = "idle" | "retrieving" | "streaming" | "done" | "not_covered" | "error"

export type AskState = {
  phase: AskPhase
  question: string
  body: string
  thin: boolean
  retrievalCount: number | null
  cached: boolean
  answeredAt: string | null
  answerId: string | null
  cited: Cited[]
  followUps: string[]
  relatedTopics: TopicLink[]
  nearestTopics: TopicLink[]
  latencyMs: number | null
  error: string | null
}

/** A stored answer, as returned by GET /api/ask/[id] (shape normalised by `normalizeStored`). */
export type StoredAnswer = {
  id: string
  question: string
  status: "answered" | "not_covered" | "failed"
  body: string
  cited: Cited[]
  followUps: string[]
  relatedTopics: TopicLink[]
  nearestTopics: TopicLink[]
  createdAt: string | null
}

/** A source (episode) as the members payload returns it: public links only. */
export type MemberSource = {
  id: string
  title: string
  type?: string
  links?: { kind: string; label: string; href: string }[]
  video_url?: string | null
  /** Added to the members payload by the backend window; may be absent. */
  date?: string | null
}

export type ClaimMember = {
  raw_insight_id: string
  statement?: string | null
  direct_quote?: string | null
  locator?: string | null
  start_ms?: number | null
  evidence_type?: string | null
  confidence?: string | null
  /** Added to the members payload by the backend window; may be absent. */
  speaker?: string | null
  date?: string | null
  source: MemberSource | null
}

export type MembersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; members: ClaimMember[]; statement: string | null }

export type Episode = {
  id: string
  title: string
  date: string | null
  href: string | null
  /** How many different citations in this answer the episode supports. */
  citations: number
}
