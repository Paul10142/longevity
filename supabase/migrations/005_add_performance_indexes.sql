-- Migration: Add performance indexes for topic/insight queries
-- These indexes optimize the queries used when loading topic pages

-- Index for filtering insights by deleted_at (used in public views)
CREATE INDEX IF NOT EXISTS insights_deleted_at_idx ON insights (deleted_at) WHERE deleted_at IS NULL;

-- Composite index for insight_concepts lookups (concept_id + insight_id)
-- This optimizes the query: SELECT * FROM insight_concepts WHERE concept_id = ?
CREATE INDEX IF NOT EXISTS insight_concepts_concept_insight_idx ON insight_concepts (concept_id, insight_id);

-- Index for insight_concepts by insight_id (used when fetching all concepts for an insight)
CREATE INDEX IF NOT EXISTS insight_concepts_insight_idx ON insight_concepts (insight_id);

-- Index for concepts by slug (used in topic page lookups)
CREATE INDEX IF NOT EXISTS concepts_slug_idx ON concepts (slug);

-- Index for topic_articles lookups (already exists but ensuring it's there)
CREATE INDEX IF NOT EXISTS topic_articles_concept_audience_idx ON topic_articles (concept_id, audience);

-- Index for sorting insights by importance (used when displaying evidence view)
CREATE INDEX IF NOT EXISTS insights_importance_idx ON insights (importance DESC NULLS LAST);
