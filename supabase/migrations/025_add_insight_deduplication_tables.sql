-- Migration: Add insight deduplication architecture (raw + unique layers)
-- Implements the raw_insights (existing insights table) + unique_insights architecture
-- Adds merge clustering tables for manual merge workflow

-- Step 1: Create unique_insights table
CREATE TABLE IF NOT EXISTS unique_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical wording taken from one of the raw insights
  canonical_statement text NOT NULL,
  canonical_raw_id uuid REFERENCES insights(id) ON DELETE SET NULL,
  canonical_source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  -- Optional denormalizations (can be computed via queries or periodically updated)
  avg_confidence numeric,
  source_count int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unique_insights_canonical_raw_idx ON unique_insights (canonical_raw_id);
CREATE INDEX IF NOT EXISTS unique_insights_canonical_source_idx ON unique_insights (canonical_source_id);
CREATE INDEX IF NOT EXISTS unique_insights_created_at_idx ON unique_insights (created_at DESC);

-- Step 2: Add columns to insights table (treating it as raw_insights)
ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locator text,
  ADD COLUMN IF NOT EXISTS start_ms integer,
  ADD COLUMN IF NOT EXISTS end_ms integer,
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES source_processing_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unique_insight_id uuid REFERENCES unique_insights(id) ON DELETE SET NULL;

-- Add indexes for the new columns
CREATE INDEX IF NOT EXISTS insights_source_id_idx ON insights (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS insights_run_id_idx ON insights (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS insights_unique_insight_id_idx ON insights (unique_insight_id) WHERE unique_insight_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS insights_locator_idx ON insights (locator) WHERE locator IS NOT NULL;

-- Step 3: Create merge_clusters table (for dashboard review)
CREATE TABLE IF NOT EXISTS merge_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  created_by text DEFAULT 'system',
  status text CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS merge_clusters_status_idx ON merge_clusters (status);
CREATE INDEX IF NOT EXISTS merge_clusters_created_at_idx ON merge_clusters (created_at DESC);

-- Step 4: Create merge_cluster_members table
CREATE TABLE IF NOT EXISTS merge_cluster_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid REFERENCES merge_clusters(id) ON DELETE CASCADE,
  raw_insight_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  similarity numeric,               -- similarity score vs. cluster anchor (0–1)
  is_selected boolean DEFAULT true   -- toggled in the UI
);

CREATE INDEX IF NOT EXISTS merge_cluster_members_cluster_idx ON merge_cluster_members (cluster_id);
CREATE INDEX IF NOT EXISTS merge_cluster_members_raw_insight_idx ON merge_cluster_members (raw_insight_id);
CREATE UNIQUE INDEX IF NOT EXISTS merge_cluster_members_unique ON merge_cluster_members (cluster_id, raw_insight_id);

-- Step 5: Backfill source_id from insight_sources
-- For insights with multiple source links, pick the first one (earliest or first row)
UPDATE insights i
SET source_id = (
  SELECT is2.source_id
  FROM insight_sources is2
  WHERE is2.insight_id = i.id
  ORDER BY is2.run_id NULLS LAST, is2.locator
  LIMIT 1
)
WHERE i.source_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM insight_sources is2
    WHERE is2.insight_id = i.id
  );

-- Step 6: Backfill run_id from insight_sources
UPDATE insights i
SET run_id = (
  SELECT is2.run_id
  FROM insight_sources is2
  WHERE is2.insight_id = i.id
    AND is2.run_id IS NOT NULL
  ORDER BY is2.run_id
  LIMIT 1
)
WHERE i.run_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM insight_sources is2
    WHERE is2.insight_id = i.id
      AND is2.run_id IS NOT NULL
  );

-- Step 7: Backfill locator from insight_sources (for consistency)
UPDATE insights i
SET locator = (
  SELECT is2.locator
  FROM insight_sources is2
  WHERE is2.insight_id = i.id
    AND is2.locator IS NOT NULL
  ORDER BY is2.locator
  LIMIT 1
)
WHERE i.locator IS NULL
  AND EXISTS (
    SELECT 1
    FROM insight_sources is2
    WHERE is2.insight_id = i.id
      AND is2.locator IS NOT NULL
  );

-- Step 8: Backfill start_ms and end_ms from insight_sources
UPDATE insights i
SET start_ms = (
  SELECT is2.start_ms
  FROM insight_sources is2
  WHERE is2.insight_id = i.id
    AND is2.start_ms IS NOT NULL
  LIMIT 1
),
end_ms = (
  SELECT is2.end_ms
  FROM insight_sources is2
  WHERE is2.insight_id = i.id
    AND is2.end_ms IS NOT NULL
  LIMIT 1
)
WHERE (i.start_ms IS NULL OR i.end_ms IS NULL)
  AND EXISTS (
    SELECT 1
    FROM insight_sources is2
    WHERE is2.insight_id = i.id
      AND (is2.start_ms IS NOT NULL OR is2.end_ms IS NOT NULL)
  );

-- Add comments for documentation
COMMENT ON TABLE unique_insights IS 'Deduplicated idea-level insights that aggregate multiple raw insights';
COMMENT ON COLUMN insights.source_id IS 'Direct link to source (replaces insight_sources dependency for new code)';
COMMENT ON COLUMN insights.locator IS 'Location within source (e.g., "seg-001", "page 10", "00:13:05")';
COMMENT ON COLUMN insights.run_id IS 'Processing run that created this raw insight';
COMMENT ON COLUMN insights.unique_insight_id IS 'Link to unique_insights if this raw has been merged';
COMMENT ON TABLE merge_clusters IS 'Candidate groups of similar raw insights for manual review';
COMMENT ON TABLE merge_cluster_members IS 'Individual raw insights within a merge cluster';
