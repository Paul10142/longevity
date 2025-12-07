-- Migration: Add embeddings column to concepts table for semantic concept matching
-- Enables finding similar concepts when auto-creating new ones

-- Add embedding column (1536 dimensions for OpenAI text-embedding-3-small)
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create ivfflat index for fast similarity search
-- Using 10 lists (good for smaller datasets like concepts)
CREATE INDEX IF NOT EXISTS concepts_embedding_idx ON concepts 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 10)
  WHERE embedding IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN concepts.embedding IS 'Vector embedding for semantic concept matching (OpenAI text-embedding-3-small, 1536 dimensions)';

