-- 137_drop_spotify_item_details_spotify_id_unique.sql
-- Allow multiple list_items to reference the same spotify_id.

ALTER TABLE public.spotify_item_details
  DROP CONSTRAINT IF EXISTS spotify_item_details_spotify_id_key;
