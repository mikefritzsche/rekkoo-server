-- Adds soft-delete and weighting support to embeddings table
-- Run AFTER 006_add_embeddings_table.sql

-- Add deleted_at column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema = 'public'
          AND  table_name   = 'embeddings'
          AND  column_name  = 'deleted_at')
    THEN
        ALTER TABLE public.embeddings
        ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
    END IF;
END;
$$;

-- Add weight column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema = 'public'
          AND  table_name   = 'embeddings'
          AND  column_name  = 'weight')
    THEN
        ALTER TABLE public.embeddings
        ADD COLUMN weight REAL DEFAULT 1.0;

        -- Backfill existing rows to weight = 1.0 (ALTER TABLE default already does for NULL, but make explicit)
        UPDATE public.embeddings SET weight = 1.0 WHERE weight IS NULL;
    END IF;
END;
$$; 