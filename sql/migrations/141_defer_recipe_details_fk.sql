-- Migration 141: ensure recipe detail FK constraint is deferrable

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'recipe_details_list_item_id_fkey'
      AND table_schema = 'public'
      AND table_name = 'recipe_details'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE 'ALTER TABLE public.recipe_details
             DROP CONSTRAINT recipe_details_list_item_id_fkey';
  END IF;

  EXECUTE 'ALTER TABLE public.recipe_details
           ADD CONSTRAINT recipe_details_list_item_id_fkey
           FOREIGN KEY (list_item_id) REFERENCES public.list_items(id)
           ON DELETE CASCADE
           DEFERRABLE INITIALLY DEFERRED';
END
$$;
