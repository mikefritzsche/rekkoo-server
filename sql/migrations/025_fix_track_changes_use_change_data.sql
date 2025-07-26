-- 025_fix_track_changes_use_change_data.sql
-- Ensures track_changes() populates change_data column (legacy) instead of data.
-- Also migrates any rows that used the newer 'data' column into change_data and drops 'data'.

-- 1. Add change_data column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'change_log' AND column_name = 'change_data'
  ) THEN
    ALTER TABLE change_log ADD COLUMN change_data JSONB;
  END IF;
END $$;

-- 2. Migrate old 'data' rows
UPDATE change_log
SET change_data = COALESCE(change_data, "data")
WHERE "data" IS NOT NULL;

-- 3. Drop obsolete column 'data' (safe now)
ALTER TABLE change_log DROP COLUMN IF EXISTS "data";

-- 4. Replace function to insert into change_data
CREATE OR REPLACE FUNCTION track_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT, (to_jsonb(NEW)->>'uuid'), (to_jsonb(NEW)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(NEW)->>'user_id')::uuid, (to_jsonb(NEW)->>'owner_id')::uuid, NULL);
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT, (to_jsonb(NEW)->>'uuid'), (to_jsonb(NEW)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(NEW)->>'user_id')::uuid, (to_jsonb(NEW)->>'owner_id')::uuid, NULL);
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    v_data := NULL;
    v_id := COALESCE(OLD.id::TEXT, (to_jsonb(OLD)->>'uuid'), (to_jsonb(OLD)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(OLD)->>'user_id')::uuid, (to_jsonb(OLD)->>'owner_id')::uuid, NULL);
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 