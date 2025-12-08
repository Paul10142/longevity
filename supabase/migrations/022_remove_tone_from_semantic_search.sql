-- Migration: Remove tone field from semantic search RPC function
-- Tone field has been consolidated into insight_type (Warning/Controversy)

CREATE OR REPLACE FUNCTION search_insights_semantic(
  query_embedding vector(1536),
  concept_id uuid DEFAULT NULL,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  statement text,
  context_note text,
  evidence_type text,
  qualifiers jsonb,
  confidence text,
  importance int,
  actionability text,
  primary_audience text,
  insight_type text,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    i.id,
    i.statement,
    i.context_note,
    i.evidence_type,
    i.qualifiers,
    i.confidence,
    i.importance,
    i.actionability,
    i.primary_audience,
    i.insight_type,
    i.created_at,
    1 - (i.embedding <=> query_embedding) as similarity
  FROM insights i
  LEFT JOIN insight_concepts ic ON i.id = ic.insight_id
  WHERE 
    i.embedding IS NOT NULL
    AND i.deleted_at IS NULL
    AND (concept_id IS NULL OR ic.concept_id = concept_id)
    AND (1 - (i.embedding <=> query_embedding)) > match_threshold
  ORDER BY i.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION search_insights_semantic IS 'Semantic search function for insights using cosine similarity. Returns insights with similarity score above threshold.';
