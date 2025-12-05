-- Add needs_tagging column to insights table
-- This flag marks insights that need to be auto-tagged by the async batch job
ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS needs_tagging boolean NOT NULL DEFAULT false;

-- Add partial index for efficient batch job queries
-- Only indexes rows where needs_tagging = true, keeping the index small
CREATE INDEX IF NOT EXISTS insights_needs_tagging_idx
  ON insights(needs_tagging)
  WHERE needs_tagging = true;
