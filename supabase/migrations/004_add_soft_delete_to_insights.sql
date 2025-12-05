-- Migration: Add soft delete to insights table
-- Run this in Supabase SQL Editor or via migration tool

ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Add index for filtering non-deleted insights
CREATE INDEX IF NOT EXISTS insights_deleted_at_idx ON insights (deleted_at) WHERE deleted_at IS NULL;
