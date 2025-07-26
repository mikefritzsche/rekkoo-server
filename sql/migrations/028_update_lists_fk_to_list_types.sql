-- 028_update_lists_fk_to_list_types.sql
-- Aligns lists table with new list_types reference:
--   • Drops temporary list_type_id column if it exists
--   • Adds foreign-key constraint on existing list_type column → list_types(id)
--   • Ensures all rows have a valid list_type value (defaults to 'custom')

-- 1. Drop superfluous list_type_id column (created by 027) if still present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lists' AND column_name = 'list_type_id'
  ) THEN
    ALTER TABLE public.lists DROP COLUMN list_type_id;
  END IF;
END $$;

-- 2. Fill nulls in existing list_type with 'custom' (so FK passes)
UPDATE public.lists SET list_type = 'custom' WHERE list_type IS NULL;

-- 3. Ensure list_type column matches list_types(id)
ALTER TABLE public.lists
  ALTER COLUMN list_type TYPE TEXT,           -- make sure types align
  ALTER COLUMN list_type SET NOT NULL,
  ALTER COLUMN list_type SET DEFAULT 'custom';

-- 4. Add foreign key (if not already)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'lists'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'list_type'
  ) THEN
    ALTER TABLE public.lists
      ADD CONSTRAINT fk_lists_list_type
      FOREIGN KEY (list_type) REFERENCES public.list_types(id);
  END IF;
END $$;

-- 5. Index for faster filtering
CREATE INDEX IF NOT EXISTS idx_lists_list_type ON public.lists(list_type); 