-- ============================================================
-- Knowledge Engine v2 — Baseline Schema
-- ============================================================
-- Replaces the v1 insight/concept schema with the layered model:
--   sources → chunks → raw_insights → claims → topics → articles/protocols
--
-- DESTRUCTIVE: drops all derived v1 tables. `sources` (including
-- transcripts) is preserved; everything else is re-derived by the
-- new pipeline. A full JSON backup was taken before this ran
-- (backups/2026-07-18-pre-v2/).
--
-- Run in the Supabase SQL Editor as a single script.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------
-- 1. Drop v1 derived tables, functions, and views
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS search_insights_semantic(vector, uuid, float, int);
DROP FUNCTION IF EXISTS search_insights_semantic(vector(1536), uuid, double precision, integer);

DROP TABLE IF EXISTS model_predictions CASCADE;
DROP TABLE IF EXISTS training_data_exports CASCADE;
DROP TABLE IF EXISTS deduplication_models CASCADE;
DROP TABLE IF EXISTS merge_cluster_members CASCADE;
DROP TABLE IF EXISTS merge_clusters CASCADE;
DROP TABLE IF EXISTS unique_insights CASCADE;
DROP TABLE IF EXISTS insight_concepts CASCADE;
DROP TABLE IF EXISTS insight_sources CASCADE;
DROP TABLE IF EXISTS insights CASCADE;
DROP TABLE IF EXISTS topic_articles CASCADE;
DROP TABLE IF EXISTS topic_protocols CASCADE;
DROP TABLE IF EXISTS concept_connections CASCADE;
DROP TABLE IF EXISTS concept_parents CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;
DROP TABLE IF EXISTS source_processing_runs CASCADE;

-- Chunks are re-derived from stored transcripts on re-extraction.
TRUNCATE TABLE chunks;
ALTER TABLE chunks DROP COLUMN IF EXISTS run_id;

-- ------------------------------------------------------------
-- 2. Pipeline runs (generalizes source_processing_runs)
-- ------------------------------------------------------------
CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('extract', 'consolidate', 'tag', 'discover_topics', 'generate_topic', 'claim_sweep')),
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')) DEFAULT 'running',
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,   -- counters: chunks_processed, insights_created, cost_usd, ...
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX pipeline_runs_source_idx ON pipeline_runs (source_id);
CREATE INDEX pipeline_runs_kind_idx ON pipeline_runs (kind, started_at DESC);

-- ------------------------------------------------------------
-- 3. Job queue
-- ------------------------------------------------------------
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('extract_source', 'consolidate_source', 'tag_claims', 'discover_topics', 'generate_topic', 'claim_sweep')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')) DEFAULT 'queued',
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,  -- resumable checkpoint (e.g. { "chunk_index": 12 })
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,          -- heartbeat: stale running jobs get reclaimed
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_after) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_created_idx ON jobs (created_at DESC);

-- Atomically claim the next runnable job (SKIP LOCKED so concurrent
-- workers never double-claim). Stale 'running' jobs (heartbeat older
-- than 10 minutes) are reclaimable — their checkpoint makes resume safe.
CREATE OR REPLACE FUNCTION claim_next_job()
RETURNS SETOF jobs
LANGUAGE plpgsql
AS $$
DECLARE
  claimed jobs%ROWTYPE;
BEGIN
  SELECT * INTO claimed
  FROM jobs
  WHERE (status = 'queued' AND run_after <= now())
     OR (status = 'running' AND locked_at < now() - interval '10 minutes')
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF claimed.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE jobs
  SET status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      started_at = COALESCE(started_at, now())
  WHERE id = claimed.id
  RETURNING * INTO claimed;

  RETURN NEXT claimed;
END;
$$;

-- ------------------------------------------------------------
-- 4. Raw insights (immutable extraction records)
-- ------------------------------------------------------------
CREATE TABLE raw_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
  run_id uuid REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  locator text NOT NULL,             -- "seg-001"; survives chunk regeneration
  start_ms integer,
  end_ms integer,
  statement text NOT NULL,
  context_note text,
  evidence_type text NOT NULL CHECK (evidence_type IN ('RCT','Cohort','MetaAnalysis','CaseSeries','Mechanistic','Animal','ExpertOpinion','Other')),
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  importance int CHECK (importance IN (1, 2, 3)),
  actionability text CHECK (actionability IN ('Low','Medium','High')),
  primary_audience text CHECK (primary_audience IN ('Patient','Clinician','Both')),
  insight_type text CHECK (insight_type IN ('Protocol','Explanation','Mechanism','Anecdote','Warning','Controversy','Other')),
  qualifiers jsonb,                  -- { population, dose, duration, outcome, effect_size, caveats }
  embedding vector(1536),
  extraction_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX raw_insights_source_idx ON raw_insights (source_id);
CREATE INDEX raw_insights_run_idx ON raw_insights (run_id);
CREATE INDEX raw_insights_created_idx ON raw_insights (created_at DESC);
COMMENT ON TABLE raw_insights IS 'Immutable per-chunk extraction records. Never mutated or merged; consolidation happens in claims/claim_members.';

-- ------------------------------------------------------------
-- 5. Claims (canonical deduplicated knowledge units)
-- ------------------------------------------------------------
CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_statement text NOT NULL,
  context_note text,
  status text NOT NULL CHECK (status IN ('active', 'merged_into', 'retired')) DEFAULT 'active',
  merged_into_id uuid REFERENCES claims(id) ON DELETE SET NULL,
  -- aggregates maintained by consolidation
  best_evidence_type text CHECK (best_evidence_type IN ('RCT','Cohort','MetaAnalysis','CaseSeries','Mechanistic','Animal','ExpertOpinion','Other')),
  max_importance int CHECK (max_importance IN (1, 2, 3)),
  actionability text CHECK (actionability IN ('Low','Medium','High')),
  primary_audience text CHECK (primary_audience IN ('Patient','Clinician','Both')),
  insight_type text CHECK (insight_type IN ('Protocol','Explanation','Mechanism','Anecdote','Warning','Controversy','Other')),
  qualifiers jsonb,
  member_count int NOT NULL DEFAULT 0,
  source_count int NOT NULL DEFAULT 0,
  embedding vector(1536),
  needs_tagging boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_status_idx ON claims (status) WHERE status = 'active';
CREATE INDEX claims_needs_tagging_idx ON claims (needs_tagging) WHERE needs_tagging;
CREATE INDEX claims_importance_idx ON claims (max_importance DESC NULLS LAST);
CREATE INDEX claims_created_idx ON claims (created_at DESC);
-- ANN index for consolidation + search (ivfflat is fine at this scale;
-- revisit lists/HNSW past ~100k claims)
CREATE INDEX claims_embedding_idx ON claims
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE claim_members (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  raw_insight_id uuid NOT NULL UNIQUE REFERENCES raw_insights(id) ON DELETE CASCADE,
  match_confidence numeric CHECK (match_confidence >= 0 AND match_confidence <= 1),
  matched_by text NOT NULL CHECK (matched_by IN ('auto', 'human', 'seed')) DEFAULT 'auto',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, raw_insight_id)
);
CREATE INDEX claim_members_raw_idx ON claim_members (raw_insight_id);
COMMENT ON COLUMN claim_members.matched_by IS 'seed = the raw insight that created the claim; auto = LLM adjudication; human = review-queue decision';

-- ------------------------------------------------------------
-- 6. Merge review queue (borderline dedup decisions)
-- ------------------------------------------------------------
CREATE TABLE merge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,           -- provisional new claim
  candidate_claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE, -- existing claim it might equal
  similarity numeric,
  model_verdict text CHECK (model_verdict IN ('SAME', 'DIFFERENT', 'UNSURE')),
  model_confidence numeric,
  model_reasoning text,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')) DEFAULT 'pending',
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, candidate_claim_id)
);
CREATE INDEX merge_reviews_pending_idx ON merge_reviews (created_at DESC) WHERE status = 'pending';

-- ------------------------------------------------------------
-- 7. Topics (AI-managed hierarchical taxonomy)
-- ------------------------------------------------------------
CREATE TABLE topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  parent_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  created_by text NOT NULL CHECK (created_by IN ('ai', 'human')) DEFAULT 'ai',
  reviewed_by_human boolean NOT NULL DEFAULT false,   -- audit flag: cleared edits mark true
  embedding vector(1536),
  claim_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topics_parent_idx ON topics (parent_id);
CREATE INDEX topics_status_idx ON topics (status) WHERE status = 'active';

CREATE TABLE claim_topics (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence numeric,
  assigned_by text NOT NULL CHECK (assigned_by IN ('ai', 'human')) DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, topic_id)
);
CREATE INDEX claim_topics_topic_idx ON claim_topics (topic_id);

-- ------------------------------------------------------------
-- 8. Generated content (articles + protocols, citing claims)
-- ------------------------------------------------------------
CREATE TABLE topic_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('clinician', 'patient')),
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  outline jsonb NOT NULL,          -- sections/paragraphs; paragraphs carry claim_ids[]
  body_markdown text NOT NULL,
  generation_model text,
  claims_snapshot_at timestamptz,  -- latest claim change included; staleness = topic changed since
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, audience, version)
);
CREATE INDEX topic_articles_topic_idx ON topic_articles (topic_id, audience, version DESC);

CREATE TABLE topic_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  outline jsonb NOT NULL,
  body_markdown text NOT NULL,
  generation_model text,
  claims_snapshot_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, version)
);
CREATE INDEX topic_protocols_topic_idx ON topic_protocols (topic_id, version DESC);

-- ------------------------------------------------------------
-- 9. ANN search functions
-- ------------------------------------------------------------
-- Candidate claims for consolidating a new raw insight (and for search).
CREATE OR REPLACE FUNCTION match_claims(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.80,
  match_count int DEFAULT 8
)
RETURNS TABLE (
  id uuid,
  canonical_statement text,
  context_note text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT c.id, c.canonical_statement, c.context_note,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM claims c
  WHERE c.status = 'active'
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Candidate topics for tagging a claim.
CREATE OR REPLACE FUNCTION match_topics(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.30,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  description text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT t.id, t.name, t.slug, t.description,
         1 - (t.embedding <=> query_embedding) AS similarity
  FROM topics t
  WHERE t.status = 'active'
    AND t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) >= match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ------------------------------------------------------------
-- 10. updated_at triggers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER claims_touch BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER topics_touch BEFORE UPDATE ON topics
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
