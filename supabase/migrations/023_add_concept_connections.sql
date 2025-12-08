-- Migration: Add concept connections table for cross-concept relationships
-- Enables storing explicit relationships between concepts (shared insights, semantic similarity, hierarchy)

CREATE TABLE IF NOT EXISTS concept_connections (
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  related_concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  connection_strength numeric(5,4) NOT NULL,
  connection_type text CHECK (connection_type IN ('shared_insights', 'semantic', 'hierarchy')) NOT NULL,
  shared_insight_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (concept_id, related_concept_id),
  CHECK (concept_id != related_concept_id)
);

CREATE INDEX IF NOT EXISTS concept_connections_concept_idx ON concept_connections (concept_id);
CREATE INDEX IF NOT EXISTS concept_connections_related_idx ON concept_connections (related_concept_id);
CREATE INDEX IF NOT EXISTS concept_connections_strength_idx ON concept_connections (connection_strength DESC);
CREATE INDEX IF NOT EXISTS concept_connections_type_idx ON concept_connections (connection_type);

-- Add comment for documentation
COMMENT ON TABLE concept_connections IS 'Stores relationships between concepts based on shared insights, semantic similarity, or hierarchy. Used for cross-concept navigation and narrative generation.';
