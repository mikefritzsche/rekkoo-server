-- Creates table to persist user search query embeddings
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.search_embeddings (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid,
    raw_query   text        NOT NULL,
    embedding   vector(384) NOT NULL,
    weight      real        DEFAULT 1.0,
    created_at  timestamptz DEFAULT CURRENT_TIMESTAMP,
    deleted_at  timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS search_embeddings_hnsw ON public.search_embeddings USING hnsw (embedding vector_l2_ops);
CREATE INDEX IF NOT EXISTS search_embeddings_trgm ON public.search_embeddings USING gin (raw_query gin_trgm_ops); 