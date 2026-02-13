-- Migration 140: ensure book detail FK constraint is deferrable
-- Matches movie/tv/place detail behavior so BEFORE INSERT triggers can
-- populate book_details rows referencing NEW.id without FK violations.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'book_details_list_item_id_fkey'
      AND table_schema = 'public'
      AND table_name = 'book_details'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE 'ALTER TABLE public.book_details
             ALTER CONSTRAINT book_details_list_item_id_fkey
             DEFERRABLE INITIALLY DEFERRED';
  ELSE
    EXECUTE 'ALTER TABLE public.book_details
             ADD CONSTRAINT book_details_list_item_id_fkey
             FOREIGN KEY (list_item_id) REFERENCES public.list_items(id)
             ON DELETE CASCADE
             DEFERRABLE INITIALLY DEFERRED';
  END IF;
END
$$;
