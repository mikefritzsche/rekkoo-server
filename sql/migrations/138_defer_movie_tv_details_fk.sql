-- Migration 138: ensure movie/tv detail FK constraints are deferrable
-- This allows BEFORE INSERT triggers on list_items to create detail rows referencing NEW.id

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'movie_details_list_item_id_fkey'
      AND table_name = 'movie_details'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE 'ALTER TABLE public.movie_details
             ALTER CONSTRAINT movie_details_list_item_id_fkey
             DEFERRABLE INITIALLY DEFERRED';
  ELSE
    EXECUTE 'ALTER TABLE public.movie_details
             ADD CONSTRAINT movie_details_list_item_id_fkey
             FOREIGN KEY (list_item_id) REFERENCES public.list_items(id)
             ON DELETE CASCADE
             DEFERRABLE INITIALLY DEFERRED';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tv_details_list_item_id_fkey'
      AND table_name = 'tv_details'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE 'ALTER TABLE public.tv_details
             ALTER CONSTRAINT tv_details_list_item_id_fkey
             DEFERRABLE INITIALLY DEFERRED';
  ELSE
    EXECUTE 'ALTER TABLE public.tv_details
             ADD CONSTRAINT tv_details_list_item_id_fkey
             FOREIGN KEY (list_item_id) REFERENCES public.list_items(id)
             ON DELETE CASCADE
             DEFERRABLE INITIALLY DEFERRED';
  END IF;
END
$$;
