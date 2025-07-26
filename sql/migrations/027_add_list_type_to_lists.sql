-- 027_add_list_type_to_lists.sql
-- Adds list_type_id column to public.lists table and links it to list_types.
-- Ensures existing lists default to 'custom' list type for backward compatibility.

-- 1. Ensure list_types table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'list_types'
  ) THEN
    RAISE EXCEPTION 'list_types table must exist before running this migration.';
  END IF;
END $$;

-- 2. Add column if it does not already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lists' AND column_name = 'list_type_id'
  ) THEN
    ALTER TABLE public.lists
      ADD COLUMN list_type_id TEXT REFERENCES public.list_types(id);
  END IF;
END $$;

-- 3. Populate existing rows with sensible default ('custom')
UPDATE public.lists
SET list_type_id = 'custom'
WHERE list_type_id IS NULL;

-- 4. Make column NOT NULL with default
ALTER TABLE public.lists
  ALTER COLUMN list_type_id SET NOT NULL,
  ALTER COLUMN list_type_id SET DEFAULT 'custom';

-- 5. Add index for faster queries by list_type_id
CREATE INDEX IF NOT EXISTS idx_lists_list_type_id ON public.lists(list_type_id); 