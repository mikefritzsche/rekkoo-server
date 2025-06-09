-- Create the pgvector extension if it doesn't exist
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the embeddings table
CREATE TABLE IF NOT EXISTS public.embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    related_entity_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL, -- e.g., 'list_item', 'user_profile', 'review'
    embedding VECTOR(384) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add an index for faster similarity searches
CREATE INDEX IF NOT EXISTS embeddings_embedding_idx ON public.embeddings USING hnsw (embedding vector_l2_ops);

-- Add a unique constraint to prevent duplicate embeddings for the same entity
CREATE UNIQUE INDEX IF NOT EXISTS unique_entity_embedding ON public.embeddings (related_entity_id, entity_type);

-- Create a trigger to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_embeddings_updated_at
    BEFORE UPDATE ON public.embeddings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 