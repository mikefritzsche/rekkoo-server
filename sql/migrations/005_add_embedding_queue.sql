-- Migration: Add embedding_queue table
-- Description: Creates a table to manage asynchronous embedding generation tasks

-- Up Migration
CREATE TABLE IF NOT EXISTS public.embedding_queue (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entity_id uuid NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_attempt TIMESTAMP WITH TIME ZONE,
    next_attempt TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB,
    CONSTRAINT embedding_queue_pkey PRIMARY KEY (id),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT unique_entity UNIQUE (entity_id, entity_type)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON public.embedding_queue(status);
CREATE INDEX IF NOT EXISTS idx_embedding_queue_next_attempt ON public.embedding_queue(next_attempt);
CREATE INDEX IF NOT EXISTS idx_embedding_queue_entity ON public.embedding_queue(entity_id, entity_type);

-- Add trigger for updated_at
CREATE TRIGGER update_embedding_queue_updated_at
    BEFORE UPDATE ON public.embedding_queue
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column(); 