-- Migration: Update embedding dimensions from 384 to 768
-- Date: 2024-11-17
-- Reason: AI server upgraded to use a model that produces 768-dimensional embeddings

BEGIN;

-- Step 1: Drop existing embeddings since they're incompatible (384-dim vs 768-dim)
-- We'll need to regenerate them with the new model
DELETE FROM embeddings;
DELETE FROM search_embeddings;

-- Step 2: Drop the old indexes
DROP INDEX IF EXISTS embeddings_embedding_idx;
DROP INDEX IF EXISTS search_embeddings_embedding_idx;

-- Step 3: Alter the embedding columns to use 768 dimensions
ALTER TABLE embeddings
  ALTER COLUMN embedding TYPE vector(768);

ALTER TABLE search_embeddings
  ALTER COLUMN embedding TYPE vector(768);

-- Step 4: Recreate the indexes with the new dimension
CREATE INDEX embeddings_embedding_idx
  ON embeddings
  USING hnsw (embedding vector_l2_ops);

CREATE INDEX search_embeddings_embedding_idx
  ON search_embeddings
  USING hnsw (embedding vector_l2_ops);

-- Step 5: Clear the embedding queue to avoid processing with old dimensions
UPDATE embedding_queue
  SET status = 'pending',
      retry_count = 0,
      error_message = 'Reset after dimension upgrade'
  WHERE status != 'completed';

-- Add a comment to track this migration
COMMENT ON COLUMN embeddings.embedding IS 'Vector embedding with 768 dimensions (upgraded from 384)';
COMMENT ON COLUMN search_embeddings.embedding IS 'Search query embedding with 768 dimensions (upgraded from 384)';

COMMIT;

-- Note: After running this migration, you'll need to:
-- 1. Regenerate all embeddings using the new 768-dimensional model
-- 2. Users will need to regenerate their preference embeddings