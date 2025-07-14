-- Migration 015: add watch_providers column to movie_details and tv_details
ALTER TABLE IF EXISTS public.movie_details
ADD COLUMN IF NOT EXISTS watch_providers JSONB;

ALTER TABLE IF EXISTS public.tv_details
ADD COLUMN IF NOT EXISTS watch_providers JSONB; 