-- Migration: Add processing status fields and enforce NOT NULL defaults
-- Hardens the foundation for automation by tracking processing lifecycle

-- Step 1: Backfill NULL values for existing sources
UPDATE sources SET media_type = 'text' WHERE media_type IS NULL;
UPDATE sources SET transcript_origin = 'manual' WHERE transcript_origin IS NULL;

-- Step 2: Add processing status fields to sources
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending' 
    CHECK (processing_status IN ('pending', 'processing', 'succeeded', 'failed')),
  ADD COLUMN IF NOT EXISTS last_processed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS processing_error text NULL;

-- Step 3: Enforce NOT NULL constraints on media_type and transcript_origin
-- (These were added as nullable in migration 006, now we're hardening them)
ALTER TABLE sources
  ALTER COLUMN media_type SET NOT NULL,
  ALTER COLUMN media_type SET DEFAULT 'text',
  ALTER COLUMN transcript_origin SET NOT NULL,
  ALTER COLUMN transcript_origin SET DEFAULT 'manual';

-- Step 4: Add index for processing_status (useful for automation queries)
CREATE INDEX IF NOT EXISTS sources_processing_status_idx ON sources(processing_status);

-- Step 5: Set initial processing_status for existing sources
-- If a source has chunks, assume it was successfully processed
UPDATE sources
SET processing_status = 'succeeded',
    last_processed_at = (
      SELECT MAX(created_at) 
      FROM chunks 
      WHERE chunks.source_id = sources.id
    )
WHERE EXISTS (
  SELECT 1 FROM chunks WHERE chunks.source_id = sources.id
);

-- Sources without chunks remain as 'pending' (default)

