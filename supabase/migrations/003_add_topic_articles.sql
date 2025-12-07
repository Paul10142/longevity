-- Migration: Add topic_articles table for narrative layer
-- Run this in Supabase SQL Editor or via migration tool

CREATE TABLE IF NOT EXISTS topic_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE NOT NULL,
  audience text CHECK (audience IN ('clinician','patient')) NOT NULL,
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  outline jsonb NOT NULL,
  body_markdown text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(concept_id, audience, version)
);

-- Add index for fast lookups
CREATE INDEX IF NOT EXISTS topic_articles_concept_audience_idx ON topic_articles (concept_id, audience);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_topic_articles_updated_at BEFORE UPDATE ON topic_articles
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

