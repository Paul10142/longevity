-- Migration: Add embeddings column to insights table for semantic search
-- Enables semantic similarity search using pgvector

-- Add embedding column (1536 dimensions for OpenAI text-embedding-3-small)
ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create ivfflat index for fast similarity search
-- Using 100 lists (good for datasets up to ~100k vectors)
-- Adjust lists parameter based on dataset size: lists = rows / 1000 (min 10, max 1000)
CREATE INDEX IF NOT EXISTS insights_embedding_idx ON insights 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100)
  WHERE embedding IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN insights.embedding IS 'Vector embedding for semantic search (OpenAI text-embedding-3-small, 1536 dimensions)';

