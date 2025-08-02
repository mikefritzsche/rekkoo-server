-- 032_create_item_tags.sql
-- Adds item_tags table for many-to-many tag assignment and migrates existing data.

BEGIN;

-- 1. Create new table if it does not exist
CREATE TABLE IF NOT EXISTS public.item_tags (
  item_id    uuid NOT NULL,
  tag_id     uuid NOT NULL,
  deleted_at timestamp,
  PRIMARY KEY (item_id, tag_id)
);

-- 2. Index to speed up soft-delete lookups
CREATE INDEX IF NOT EXISTS idx_item_tags_deleted_at ON public.item_tags(deleted_at);

-- 3. Migrate rows from legacy list_item_tags if that table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'list_item_tags'
  ) THEN
     INSERT INTO public.item_tags (item_id, tag_id, deleted_at)
     SELECT item_id, tag_id, deleted_at
     FROM   public.list_item_tags
     ON CONFLICT (item_id, tag_id) DO NOTHING;
  END IF;
END$$;

COMMIT; 