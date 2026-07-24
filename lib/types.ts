// Shared types for Medical Library
//
// ── v2 Knowledge Engine types ───────────────────────────────
// Layered model: sources → chunks → raw_insights → claims → topics.
// See ARCHITECTURE.md. Legacy v1 types remain below until every
// surface is migrated.

export type EvidenceType =
  | 'RCT' | 'Cohort' | 'MetaAnalysis' | 'CaseSeries'
  | 'Mechanistic' | 'Animal' | 'ExpertOpinion' | 'Other'
export type Confidence = 'high' | 'medium' | 'low'
export type Actionability = 'Low' | 'Medium' | 'High'
export type Audience = 'Patient' | 'Clinician' | 'Both'
export type InsightType =
  | 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote'
  | 'Warning' | 'Controversy' | 'Other'

export type InsightQualifiers = {
  population?: string | null
  dose?: string | null
  duration?: string | null
  outcome?: string | null
  effect_size?: string | null
  caveats?: string | null
}

// Immutable extraction record — one per (chunk, extracted statement).
export type RawInsight = {
  id: string
  source_id: string
  chunk_id: string | null
  run_id: string | null
  locator: string
  start_ms: number | null
  end_ms: number | null
  statement: string
  context_note: string | null
  direct_quote: string | null           // verbatim source span supporting the insight
  quote_char_start: number | null
  quote_char_end: number | null
  evidence_type: EvidenceType
  confidence: Confidence
  importance: 1 | 2 | 3 | null
  actionability: Actionability | null
  primary_audience: Audience | null
  insight_type: InsightType | null
  qualifiers: InsightQualifiers | null
  embedding: number[] | null
  extraction_model: string
  created_at: string
}

// ── v3 reference layer ──────────────────────────────────────
export type Reference = {
  id: string
  type: 'journal_article' | 'trial' | 'guideline' | 'book' | 'preprint' | 'other'
  title: string
  authors: string[] | null
  year: number | null
  journal: string | null
  doi: string | null
  url: string | null
  fingerprint: string
  resolved_source: 'crossref' | 'pubmed'
  created_at: string
}

export type ReferenceMention = {
  id: string
  source_id: string
  chunk_id: string | null
  run_id: string | null
  locator: string | null
  raw_text: string
  parsed: Record<string, unknown> | null
  resolution_status: 'pending' | 'resolved' | 'not_found'
  reference_id: string | null
  created_at: string
}

// Canonical deduplicated knowledge unit; the public-facing atom.
export type Claim = {
  id: string
  canonical_statement: string
  context_note: string | null
  status: 'active' | 'merged_into' | 'retired'
  merged_into_id: string | null
  best_evidence_type: EvidenceType | null
  max_importance: 1 | 2 | 3 | null
  actionability: Actionability | null
  primary_audience: Audience | null
  insight_type: InsightType | null
  qualifiers: InsightQualifiers | null
  member_count: number
  source_count: number
  needs_tagging: boolean
  created_at: string
  updated_at: string
}

export type ClaimMember = {
  claim_id: string
  raw_insight_id: string
  match_confidence: number | null
  matched_by: 'auto' | 'human' | 'seed'
  created_at: string
}

export type MergeReview = {
  id: string
  claim_id: string
  candidate_claim_id: string
  similarity: number | null
  model_verdict: 'SAME' | 'DIFFERENT' | 'UNSURE' | null
  model_confidence: number | null
  model_reasoning: string | null
  status: 'pending' | 'accepted' | 'rejected'
  decided_at: string | null
  decided_by: string | null
  created_at: string
}

export type Topic = {
  id: string
  name: string
  slug: string                 // stable identifier; assigned once, never re-derived on rename
  description: string | null
  parent_id: string | null
  status: 'active' | 'archived'
  merged_into_id: string | null // survivor topic when this one was merged (old slugs redirect here)
  created_by: 'ai' | 'human'
  reviewed_by_human: boolean
  claim_count: number
  created_at: string
  updated_at: string
}

export type JobType =
  | 'extract_source' | 'consolidate_source' | 'tag_claims'
  | 'discover_topics' | 'generate_topic' | 'claim_sweep'
  | 'extract_references' | 'resolve_references' | 'compute_relations'
  | 'update_topic'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export type Job = {
  id: string
  type: JobType
  payload: Record<string, unknown>
  status: JobStatus
  progress: Record<string, unknown>
  attempts: number
  max_attempts: number
  run_after: string
  locked_at: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export type PipelineRun = {
  id: string
  source_id: string | null
  kind: 'extract' | 'consolidate' | 'tag' | 'discover_topics' | 'generate_topic' | 'claim_sweep'
  status: 'running' | 'success' | 'failed'
  stats: Record<string, number | string>
  error_message: string | null
  started_at: string
  finished_at: string | null
}

// ── Legacy v1 types (being migrated phase by phase) ─────────

// Source types
export type SourceType = 'book' | 'podcast' | 'video' | 'article'
export type MediaType = 'audio' | 'video' | 'text' | 'book'
export type TranscriptOrigin = 'manual' | 'fireflies' | 'whisper' | 'other'
export type ProcessingStatus = 'pending' | 'processing' | 'succeeded' | 'failed'

export type Source = {
  id: string
  type: SourceType
  title: string
  authors: string[] | null
  date: string | null
  url: string | null
  transcript_quality: 'high' | 'medium' | 'low'
  external_id: string | null
  media_type: MediaType
  media_url: string | null
  media_duration_sec: number | null
  transcript_origin: TranscriptOrigin
  transcript: string | null
  // Timed caption segments for sources that carry timing (e.g. YouTube).
  // NULL for manual/pasted transcripts. See migration 010 + lib/transcriptSegments.
  timed_transcript: { text: string; start_ms: number; end_ms: number }[] | null
  processing_status: ProcessingStatus
  last_processed_at: string | null
  processing_error: string | null
  created_at: string
}

// Chunk types
export type Chunk = {
  id: string
  source_id: string
  locator: string
  content: string
  embedding: number[] | null
  start_ms: number | null
  end_ms: number | null
}

// Insight source link types
export type InsightSource = {
  insight_id: string
  source_id: string
  locator: string | null
  start_ms: number | null
  end_ms: number | null
}

// Membership types
export type MembershipTier = "free" | "annual" | "lifetime"

export type MembershipStatus = {
  tier: MembershipTier
  expiresAt: string | null // ISO date string, null for lifetime
  isActive: boolean
}

export type UserMembership = {
  userId: string
  membership: MembershipStatus
}

// Evidence view organization types
export type InsightSortOption = 'importance' | 'recency' | 'evidence_strength' | 'actionability'
export type InsightGroupOption = 'source' | 'evidence_type' | 'date' | 'none'

// Insight with metadata for display
export type InsightWithMetadata = {
  id: string
  statement: string
  context_note: string | null
  evidence_type: string
  qualifiers: any
  confidence: string
  importance: number | null
  actionability: string | null
  primary_audience: string | null
  insight_type: string | null
  created_at: string
  deleted_at: string | null
  locator: string
  source: {
    id: string
    title: string
    type: string
    created_at: string
  }
  isNew?: boolean // True if insight created in last 30 days
}
