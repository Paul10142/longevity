-- Migration: Add source_processing_runs table to track processing history
-- Run this in Supabase SQL Editor or via migration tool

CREATE TABLE IF NOT EXISTS source_processing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE NOT NULL,
  processed_at timestamptz DEFAULT now() NOT NULL,
  chunks_created integer NOT NULL,
  chunks_processed integer NOT NULL,
  chunks_with_insights integer NOT NULL DEFAULT 0,
  chunks_without_insights integer NOT NULL DEFAULT 0,
  total_insights_created integer NOT NULL DEFAULT 0,
  processing_duration_seconds numeric NOT NULL,
  status text CHECK (status IN ('success', 'failed')) NOT NULL,
  error_message text,
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookups by source (most recent first)
CREATE INDEX IF NOT EXISTS source_processing_runs_source_idx ON source_processing_runs (source_id, processed_at DESC);

-- Index for status queries
CREATE INDEX IF NOT EXISTS source_processing_runs_status_idx ON source_processing_runs (status);

