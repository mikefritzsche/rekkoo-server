-- Migration: Remove unique constraint from movie_details.tmdb_id
-- This allows multiple items to reference the same TMDB movie

-- Start transaction
BEGIN;

-- Drop the unique constraint on tmdb_id in movie_details table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'movie_details'
        AND constraint_name = 'movie_details_tmdb_id_key'
        AND constraint_type = 'UNIQUE'
    ) THEN
        ALTER TABLE movie_details DROP CONSTRAINT movie_details_tmdb_id_key;
        RAISE NOTICE 'Dropped unique constraint movie_details_tmdb_id_key';
    ELSE
        RAISE NOTICE 'Unique constraint movie_details_tmdb_id_key does not exist';
    END IF;
END $$;

-- Create a non-unique index on tmdb_id for performance (if it doesn't exist)
CREATE INDEX IF NOT EXISTS idx_movie_details_tmdb_id ON movie_details(tmdb_id);

-- Commit the transaction
COMMIT;