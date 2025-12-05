-- Migration: Add time-coded audio reference fields
-- Future-proofs schema for audio/video transcription with timestamps

-- Add new fields to sources table
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS media_type text CHECK (media_type IN ('audio', 'video', 'text', 'book')),
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_duration_sec integer,
  ADD COLUMN IF NOT EXISTS transcript_origin text CHECK (transcript_origin IN ('manual', 'fireflies', 'whisper', 'other'));

-- Add timestamp fields to chunks table
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS start_ms integer,
  ADD COLUMN IF NOT EXISTS end_ms integer;

-- Add timestamp fields to insight_sources table
ALTER TABLE insight_sources
  ADD COLUMN IF NOT EXISTS start_ms integer,
  ADD COLUMN IF NOT EXISTS end_ms integer;

-- Add indexes for time-based queries (future use)
CREATE INDEX IF NOT EXISTS chunks_start_ms_idx ON chunks (start_ms) WHERE start_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_end_ms_idx ON chunks (end_ms) WHERE end_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS insight_sources_start_ms_idx ON insight_sources (start_ms) WHERE start_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS insight_sources_end_ms_idx ON insight_sources (end_ms) WHERE end_ms IS NOT NULL;
