-- 116_add_packing_list_type.sql
-- Ensure the packing list type exists so clients can sync packing lists.

-- Temporarily disable list_types change trigger so we can seed without requiring a user_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_list_types_changes'
      AND tgrelid = 'public.list_types'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.list_types DISABLE TRIGGER trg_list_types_changes';
  END IF;
END $$;

-- Seed packing list type if missing
INSERT INTO public.list_types (id, label, description, icon, gradient, icon_color, created_at, updated_at)
SELECT
  'packing',
  'Packing',
  'Plan what to bring for trips with destination and travel dates',
  'card-travel',
  ARRAY['#f2994a', '#f2c94c'],
  '#ffffff',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM public.list_types WHERE id = 'packing'
);

-- Re-enable trigger after seeding
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_list_types_changes'
      AND tgrelid = 'public.list_types'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.list_types ENABLE TRIGGER trg_list_types_changes';
  END IF;
END $$;

-- Ensure change_log captures the new record for sync clients
WITH target AS (
  SELECT *
  FROM public.list_types
  WHERE id = 'packing'
),
actor AS (
  SELECT id AS user_id
  FROM public.users
  WHERE deleted_at IS NULL
  ORDER BY created_at ASC NULLS LAST
  LIMIT 1
)
INSERT INTO change_log (user_id, table_name, record_id, operation, change_data)
SELECT
  actor.user_id,
  'list_types',
  target.id::text,
  'create',
  to_jsonb(target.*)
FROM target
CROSS JOIN actor
WHERE NOT EXISTS (
  SELECT 1
  FROM change_log cl
  WHERE cl.table_name = 'list_types'
    AND cl.record_id = 'packing'
)
AND actor.user_id IS NOT NULL;
