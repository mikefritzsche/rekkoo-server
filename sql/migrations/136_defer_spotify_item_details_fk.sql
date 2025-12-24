-- 136_defer_spotify_item_details_fk.sql
-- Allow spotify_item_details inserts during BEFORE list_items triggers.

ALTER TABLE public.spotify_item_details
  DROP CONSTRAINT IF EXISTS spotify_item_details_list_item_id_fkey;

ALTER TABLE public.spotify_item_details
  ADD CONSTRAINT spotify_item_details_list_item_id_fkey
  FOREIGN KEY (list_item_id)
  REFERENCES public.list_items(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
