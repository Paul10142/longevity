-- Migration: Add lever fields to concepts table
-- Makes levers a subset of concepts with additional metadata

-- Add lever-specific fields to concepts table
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS is_lever boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS lever_order integer,
  ADD COLUMN IF NOT EXISTS lever_metadata jsonb;

-- Add index for fast lever queries
CREATE INDEX IF NOT EXISTS concepts_is_lever_idx ON concepts (is_lever) WHERE is_lever = true;
CREATE INDEX IF NOT EXISTS concepts_lever_order_idx ON concepts (lever_order) WHERE is_lever = true;

-- Add comment for documentation
COMMENT ON COLUMN concepts.is_lever IS 'True if this concept is one of the 5 core health levers';
COMMENT ON COLUMN concepts.lever_order IS 'Display order for levers (1-5)';
COMMENT ON COLUMN concepts.lever_metadata IS 'JSONB field storing lever-specific data: {tagline, primaryBenefits: string[]}';

