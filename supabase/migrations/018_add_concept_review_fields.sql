-- Migration: Add fields to concepts table for auto-creation and review workflow
-- Enables tracking which concepts were auto-created and need review

-- Add auto-creation tracking fields
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS auto_created boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_from_source_id uuid REFERENCES sources(id) ON DELETE SET NULL;

-- Add indexes for efficient queries
CREATE INDEX IF NOT EXISTS concepts_needs_review_idx ON concepts (needs_review) WHERE needs_review = true;
CREATE INDEX IF NOT EXISTS concepts_auto_created_idx ON concepts (auto_created) WHERE auto_created = true;

-- Add comments for documentation
COMMENT ON COLUMN concepts.auto_created IS 'True if this concept was automatically created during source processing';
COMMENT ON COLUMN concepts.needs_review IS 'True if this concept needs admin review (typically for auto-created concepts)';
COMMENT ON COLUMN concepts.created_from_source_id IS 'Source that triggered the creation of this concept (for auto-created concepts)';

