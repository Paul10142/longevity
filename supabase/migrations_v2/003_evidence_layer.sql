-- ============================================================
-- Knowledge Engine v3 — Evidence layer + scale durability
-- ============================================================
-- Adds the trust primitives for physician-grade content:
--   • verbatim quotes on raw insights
--   • verified third-party references (resolved vs PubMed/CrossRef)
-- and retires two v2 scale shortcuts:
--   • ivfflat → HNSW vector indexes (accurate into the millions)
--   • a topic_claims() RPC so synthesis/evidence never build an unbounded
--     IN(...) of a topic's claim ids in app memory.
-- See ARCHITECTURE.md (v3 evidence layer + scale invariants).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Verbatim anchor on raw insights
-- ------------------------------------------------------------
ALTER TABLE raw_insights
  ADD COLUMN IF NOT EXISTS direct_quote text,          -- exact source words
  ADD COLUMN IF NOT EXISTS quote_char_start integer,   -- offset into the chunk
  ADD COLUMN IF NOT EXISTS quote_char_end integer;

-- ------------------------------------------------------------
-- 2. Source authority tier (for weighting/labeling in synthesis)
-- ------------------------------------------------------------
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS authority_tier text
    CHECK (authority_tier IN ('guideline','peer_reviewed','expert','popular','unknown'))
    DEFAULT 'unknown';

-- ------------------------------------------------------------
-- 3. References — canonical, VERIFIED third-party works only
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS references_ (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text CHECK (type IN ('journal_article','trial','guideline','book','preprint','other')) DEFAULT 'other',
  title text NOT NULL,
  authors text[],
  year int,
  journal text,
  doi text,
  url text,
  fingerprint text NOT NULL,               -- normalized title+year (or doi) for dedup
  resolved_source text CHECK (resolved_source IN ('crossref','pubmed')) NOT NULL,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fingerprint)
);
CREATE UNIQUE INDEX IF NOT EXISTS references_doi_idx ON references_ (doi) WHERE doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS references_year_idx ON references_ (year DESC NULLS LAST);
COMMENT ON TABLE references_ IS 'Canonical, PubMed/CrossRef-verified references. Unverified mentions never appear here.';

-- Immutable per-source mentions (mirrors raw_insights → claims split).
CREATE TABLE IF NOT EXISTS reference_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
  run_id uuid REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  locator text,
  raw_text text NOT NULL,                  -- exactly as the source cited it
  parsed jsonb,                            -- { title, authors, year, journal, doi } best-effort
  resolution_status text NOT NULL CHECK (resolution_status IN ('pending','resolved','not_found')) DEFAULT 'pending',
  reference_id uuid REFERENCES references_(id) ON DELETE SET NULL,  -- set only when resolved
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reference_mentions_source_idx ON reference_mentions (source_id);
CREATE INDEX IF NOT EXISTS reference_mentions_chunk_idx ON reference_mentions (chunk_id);
CREATE INDEX IF NOT EXISTS reference_mentions_pending_idx ON reference_mentions (created_at) WHERE resolution_status = 'pending';

-- Which verified references support a claim.
CREATE TABLE IF NOT EXISTS claim_references (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  reference_id uuid NOT NULL REFERENCES references_(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, reference_id)
);
CREATE INDEX IF NOT EXISTS claim_references_ref_idx ON claim_references (reference_id);

-- ------------------------------------------------------------
-- 4. Scale: ivfflat → HNSW for claims/topics, + references index
-- ------------------------------------------------------------
DROP INDEX IF EXISTS claims_embedding_idx;
CREATE INDEX claims_embedding_idx ON claims USING hnsw (embedding vector_cosine_ops);

-- topics used ivfflat implicitly? create HNSW for topics too (match_topics).
DROP INDEX IF EXISTS topics_embedding_idx;
CREATE INDEX topics_embedding_idx ON topics USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS references_embedding_idx ON references_ USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------
-- 5. topic_claims RPC — scored + paginated in SQL (no app-side IN)
-- ------------------------------------------------------------
-- Composite score mirrors lib/synthesis claimScore(): importance, actionability,
-- evidence strength, and cross-source corroboration.
CREATE OR REPLACE FUNCTION topic_claims(
  p_topic_id uuid,
  p_audience text DEFAULT NULL,     -- 'patient' | 'clinician' | NULL (any)
  p_limit int DEFAULT 250,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  canonical_statement text,
  context_note text,
  best_evidence_type text,
  max_importance int,
  actionability text,
  primary_audience text,
  insight_type text,
  qualifiers jsonb,
  member_count int,
  source_count int,
  score numeric
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE tree AS (
    SELECT id FROM topics WHERE id = p_topic_id AND status = 'active'
    UNION
    SELECT t.id FROM topics t JOIN tree ON t.parent_id = tree.id WHERE t.status = 'active'
  ),
  topic_claim_ids AS (
    SELECT DISTINCT ct.claim_id FROM claim_topics ct JOIN tree ON ct.topic_id = tree.id
  )
  SELECT c.id, c.canonical_statement, c.context_note, c.best_evidence_type,
         c.max_importance, c.actionability, c.primary_audience, c.insight_type,
         c.qualifiers, c.member_count, c.source_count,
         (COALESCE(c.max_importance, 2) * 10
          + CASE c.actionability WHEN 'High' THEN 15 WHEN 'Low' THEN 5 ELSE 10 END
          + CASE c.best_evidence_type
              WHEN 'MetaAnalysis' THEN 15 WHEN 'RCT' THEN 12 WHEN 'Cohort' THEN 9
              WHEN 'CaseSeries' THEN 6 WHEN 'ExpertOpinion' THEN 0 ELSE 3 END
          + LEAST(c.source_count, 5) * 2)::numeric AS score
  FROM claims c
  JOIN topic_claim_ids tci ON tci.claim_id = c.id
  WHERE c.status = 'active'
    AND (p_audience IS NULL
         OR c.primary_audience = 'Both'
         OR c.primary_audience = CASE WHEN p_audience = 'patient' THEN 'Patient' ELSE 'Clinician' END)
  ORDER BY score DESC, c.source_count DESC
  LIMIT p_limit OFFSET p_offset;
$$;

-- Count of distinct claims under a topic subtree (for Evidence pagination).
CREATE OR REPLACE FUNCTION topic_claim_count(p_topic_id uuid)
RETURNS int
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE tree AS (
    SELECT id FROM topics WHERE id = p_topic_id AND status = 'active'
    UNION
    SELECT t.id FROM topics t JOIN tree ON t.parent_id = tree.id WHERE t.status = 'active'
  )
  SELECT COUNT(DISTINCT ct.claim_id)::int
  FROM claim_topics ct JOIN tree ON ct.topic_id = tree.id
  JOIN claims c ON c.id = ct.claim_id AND c.status = 'active';
$$;

-- ------------------------------------------------------------
-- 6. match_references RPC — ANN for reference dedup
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_references(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.85,
  match_count int DEFAULT 5
)
RETURNS TABLE (id uuid, title text, doi text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT r.id, r.title, r.doi, 1 - (r.embedding <=> query_embedding) AS similarity
  FROM references_ r
  WHERE r.embedding IS NOT NULL
    AND 1 - (r.embedding <=> query_embedding) >= match_threshold
  ORDER BY r.embedding <=> query_embedding
  LIMIT match_count;
$$;
