-- Migration 139: ensure place detail FK constraint is deferrable
-- This matches the behavior of other detail tables so BEFORE INSERT triggers
-- can create place_details rows referencing the pending list_items record.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'place_details_list_item_id_fkey'
      AND table_schema = 'public'
      AND table_name = 'place_details'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE 'ALTER TABLE public.place_details
             ALTER CONSTRAINT place_details_list_item_id_fkey
             DEFERRABLE INITIALLY DEFERRED';
  ELSE
    EXECUTE 'ALTER TABLE public.place_details
             ADD CONSTRAINT place_details_list_item_id_fkey
             FOREIGN KEY (list_item_id) REFERENCES public.list_items(id)
             ON DELETE CASCADE
             DEFERRABLE INITIALLY DEFERRED';
  END IF;
END
$$;
