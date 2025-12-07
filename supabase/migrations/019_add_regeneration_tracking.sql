-- Migration: Add last_regenerated_at fields to track when protocols/articles were last regenerated
-- Enables smart regeneration logic (only regenerate when new insights exist)

-- Add last_regenerated_at to topic_protocols
ALTER TABLE topic_protocols
  ADD COLUMN IF NOT EXISTS last_regenerated_at timestamptz;

-- Add last_regenerated_at to topic_articles
ALTER TABLE topic_articles
  ADD COLUMN IF NOT EXISTS last_regenerated_at timestamptz;

-- Initialize last_regenerated_at to created_at for existing records
UPDATE topic_protocols
SET last_regenerated_at = created_at
WHERE last_regenerated_at IS NULL;

UPDATE topic_articles
SET last_regenerated_at = created_at
WHERE last_regenerated_at IS NULL;

-- Add indexes for efficient queries
CREATE INDEX IF NOT EXISTS topic_protocols_last_regenerated_idx ON topic_protocols (last_regenerated_at);
CREATE INDEX IF NOT EXISTS topic_articles_last_regenerated_idx ON topic_articles (last_regenerated_at);

-- Add comments for documentation
COMMENT ON COLUMN topic_protocols.last_regenerated_at IS 'Timestamp when this protocol was last regenerated (used to determine if regeneration needed)';
COMMENT ON COLUMN topic_articles.last_regenerated_at IS 'Timestamp when this article was last regenerated (used to determine if regeneration needed)';

