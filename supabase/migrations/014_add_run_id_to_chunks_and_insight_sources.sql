-- Migration: Add run_id to chunks and insight_sources to track which run created them
-- This allows deleting a specific run without affecting other runs' data

-- Add run_id to chunks table
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES source_processing_runs(id) ON DELETE CASCADE;

-- Add run_id to insight_sources table
ALTER TABLE insight_sources
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES source_processing_runs(id) ON DELETE CASCADE;

-- Add indexes for efficient lookups by run_id
CREATE INDEX IF NOT EXISTS chunks_run_id_idx ON chunks (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS insight_sources_run_id_idx ON insight_sources (run_id) WHERE run_id IS NOT NULL;

-- Note: Existing rows will have run_id = NULL
-- The application code will set run_id for new rows going forward
-- For existing data, you may want to backfill run_id based on created_at timestamps if needed

