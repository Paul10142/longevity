-- ============================================================
-- Taxonomy durability: merge redirects
-- ============================================================
-- A merged/archived topic points at its survivor so old slugs can 301
-- instead of 404. Mirrors claims.merged_into_id. Combined with frozen slugs
-- (a topic's slug is assigned once at creation and never changes on rename),
-- this keeps topic URLs and generated-article references stable as the
-- taxonomy evolves over thousands of sources. See ARCHITECTURE.md.
-- ============================================================

ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES topics(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS topics_merged_into_idx
  ON topics (merged_into_id) WHERE merged_into_id IS NOT NULL;

COMMENT ON COLUMN topics.merged_into_id IS
  'When a topic is merged into another, points to the survivor so old slugs redirect (301) instead of 404.';
