-- Migration: Add topic_protocols table for protocol layer
-- Run this in Supabase SQL Editor or via migration tool

CREATE TABLE IF NOT EXISTS topic_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE NOT NULL,
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  outline jsonb NOT NULL,
  body_markdown text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(concept_id, version)
);

-- Add index for fast lookups (current protocol = highest version)
CREATE INDEX IF NOT EXISTS topic_protocols_concept_version_idx ON topic_protocols (concept_id, version DESC);

-- Use existing update_updated_at_column function (created in migration 003)
CREATE TRIGGER update_topic_protocols_updated_at BEFORE UPDATE ON topic_protocols
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

