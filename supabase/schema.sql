-- Medical Library Schema
-- Run this in your Supabase project SQL Editor

-- Enable vector extension for future embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Concepts table (for future concept organization)
CREATE TABLE IF NOT EXISTS concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE,
  description text,
  created_at timestamptz DEFAULT now()
);

-- Concept parents (for hierarchical concepts)
CREATE TABLE IF NOT EXISTS concept_parents (
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  PRIMARY KEY (concept_id, parent_id)
);

-- Sources table
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text CHECK (type IN ('book','podcast','video','article')) NOT NULL,
  title text NOT NULL,
  authors text[],
  date date,
  url text,
  transcript_quality text CHECK (transcript_quality IN ('high','medium','low')) DEFAULT 'high',
  external_id text,
  media_type text CHECK (media_type IN ('audio', 'video', 'text', 'book')),
  media_url text,
  media_duration_sec integer,
  transcript_origin text CHECK (transcript_origin IN ('manual', 'fireflies', 'whisper', 'other')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sources_external_id_idx ON sources (external_id);

-- Chunks table (segmented transcript content)
CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  locator text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  start_ms integer,
  end_ms integer
);

CREATE INDEX IF NOT EXISTS chunks_source_id_idx ON chunks (source_id);

-- Insights table (extracted canonical statements)
CREATE TABLE IF NOT EXISTS insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement text NOT NULL,
  context_note text,
  evidence_type text CHECK (evidence_type IN ('RCT','Cohort','MetaAnalysis','CaseSeries','Mechanistic','Animal','ExpertOpinion','Other')) NOT NULL,
  qualifiers jsonb,
  confidence text CHECK (confidence IN ('high','medium','low')) NOT NULL,
  insight_hash text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insights_created_at_idx ON insights (created_at DESC);
CREATE INDEX IF NOT EXISTS insights_hash_idx ON insights (insight_hash);

-- Insight sources (links insights to sources with locators)
CREATE TABLE IF NOT EXISTS insight_sources (
  insight_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  locator text,
  start_ms integer,
  end_ms integer,
  PRIMARY KEY (insight_id, source_id, locator)
);

CREATE INDEX IF NOT EXISTS insight_sources_insight_idx ON insight_sources (insight_id);
CREATE INDEX IF NOT EXISTS insight_sources_source_idx ON insight_sources (source_id);

-- Insight concepts (for future concept assignment)
CREATE TABLE IF NOT EXISTS insight_concepts (
  insight_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  PRIMARY KEY (insight_id, concept_id)
);

CREATE INDEX IF NOT EXISTS insight_concepts_concept_idx ON insight_concepts (concept_id);
