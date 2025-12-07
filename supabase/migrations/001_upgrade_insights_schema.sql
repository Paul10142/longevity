-- Migration: Upgrade Insights Schema
-- Add new fields to insights table for richer, more detailed insights
-- Run this in Supabase SQL Editor or via migration tool

ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS importance int DEFAULT 2 CHECK (importance IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS actionability text CHECK (actionability IN ('Background','Low','Medium','High')) DEFAULT 'Medium',
  ADD COLUMN IF NOT EXISTS primary_audience text CHECK (primary_audience IN ('Patient','Clinician','Both')) DEFAULT 'Both',
  ADD COLUMN IF NOT EXISTS insight_type text CHECK (insight_type IN ('Protocol','Explanation','Mechanism','Anecdote','Warning','Controversy','Other')) DEFAULT 'Explanation',
  ADD COLUMN IF NOT EXISTS has_direct_quote boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS direct_quote text,
  ADD COLUMN IF NOT EXISTS tone text CHECK (tone IN ('Neutral','Surprised','Skeptical','Cautious','Enthusiastic','Concerned','Other')) DEFAULT 'Neutral';

-- Add index on importance for sorting
CREATE INDEX IF NOT EXISTS insights_importance_idx ON insights (importance DESC);

-- Add index on actionability for filtering
CREATE INDEX IF NOT EXISTS insights_actionability_idx ON insights (actionability);

-- Add index on insight_type for filtering
CREATE INDEX IF NOT EXISTS insights_type_idx ON insights (insight_type);

