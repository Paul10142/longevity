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

export type Concept = {
  id: string
  name: string
  slug: string
  description: string | null
  created_at: string
}

// Source types
export type SourceType = 'book' | 'podcast' | 'video' | 'article'
export type MediaType = 'audio' | 'video' | 'text' | 'book'
export type TranscriptOrigin = 'manual' | 'fireflies' | 'whisper' | 'other'

export type Source = {
  id: string
  type: SourceType
  title: string
  authors: string[] | null
  date: string | null
  url: string | null
  transcript_quality: 'high' | 'medium' | 'low'
  external_id: string | null
  media_type: MediaType | null
  media_url: string | null
  media_duration_sec: number | null
  transcript_origin: TranscriptOrigin | null
  transcript: string | null
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
