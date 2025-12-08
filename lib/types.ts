// Shared types for Medical Library

export type TopicArticleSection = {
  id: string
  title: string
  paragraphs: {
    id: string
    text: string
    insight_ids: string[]
  }[]
}

export type TopicArticle = {
  id: string
  concept_id: string
  audience: 'clinician' | 'patient'
  version: number
  title: string
  outline: {
    sections: TopicArticleSection[]
  }
  body_markdown: string
  created_at: string
  updated_at: string
}

export type TopicProtocolSection = {
  id: string
  title: string
  paragraphs: {
    id: string
    text: string
    insight_ids: string[]
  }[]
}

export type TopicProtocol = {
  id: string
  concept_id: string
  version: number
  title: string
  outline: {
    sections: TopicProtocolSection[]
  }
  body_markdown: string
  created_at: string
  updated_at: string
}

export type LeverMetadata = {
  tagline: string
  primaryBenefits: string[]
}

export type Concept = {
  id: string
  name: string
  slug: string
  description: string | null
  created_at: string
  is_lever?: boolean | null
  lever_order?: number | null
  lever_metadata?: LeverMetadata | null
}

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
