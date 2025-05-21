-- Add TV Details Table and Column
-- This migration adds:
-- 1. A new tv_details table for storing TV show information from TMDB
-- 2. A tv_detail_id column to the list_items table

-- First, add the tv_details table
CREATE TABLE IF NOT EXISTS public.tv_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    tmdb_id character varying(255),
    name text,
    tagline text,
    first_air_date date,
    last_air_date date,
    genres text[],
    rating numeric(3,1),
    vote_count integer,
    episode_run_time integer[],
    number_of_episodes integer,
    number_of_seasons integer,
    status character varying(50),
    type character varying(50),
    original_language character varying(10),
    original_name character varying(255),
    popularity numeric,
    poster_path text,
    backdrop_path text,
    production_companies jsonb,
    production_countries jsonb,
    spoken_languages jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    overview text,
    in_production boolean,
    CONSTRAINT tv_details_pkey PRIMARY KEY (id),
    CONSTRAINT tv_details_list_item_id_key UNIQUE (list_item_id),
    CONSTRAINT tv_details_tmdb_id_key UNIQUE (tmdb_id)
);

-- Add triggers for updated_at
CREATE TRIGGER update_tv_details_updated_at BEFORE UPDATE ON public.tv_details
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add indexes
CREATE INDEX idx_tv_details_list_item_id ON public.tv_details USING btree (list_item_id);
CREATE INDEX idx_tv_details_tmdb_id ON public.tv_details USING btree (tmdb_id);
CREATE INDEX idx_tv_details_deleted_at ON public.tv_details USING btree (deleted_at);

-- Now add the tv_detail_id column to list_items table
ALTER TABLE public.list_items
ADD COLUMN IF NOT EXISTS tv_detail_id uuid;

-- Add a foreign key constraint
ALTER TABLE public.list_items
ADD CONSTRAINT list_items_tv_detail_id_fkey
FOREIGN KEY (tv_detail_id)
REFERENCES public.tv_details(id)
ON DELETE SET NULL;

-- Add index on the new column
CREATE INDEX idx_list_items_tv_detail_id ON public.list_items USING btree (tv_detail_id); 