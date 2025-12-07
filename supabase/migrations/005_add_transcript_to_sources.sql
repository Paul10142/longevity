-- Migration: Add transcript column to sources table
-- Run this in Supabase SQL Editor or via migration tool

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS transcript text;

-- Add index for full-text search if needed (optional)
-- CREATE INDEX IF NOT EXISTS sources_transcript_idx ON sources USING gin(to_tsvector('english', transcript));

