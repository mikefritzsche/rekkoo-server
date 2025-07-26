-- 024_add_user_id_to_change_log.sql
-- Adds user_id column to change_log and updates track_changes() to populate it.

-- 1. Add column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'change_log' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE change_log ADD COLUMN user_id UUID;
  END IF;
END $$;

-- 2. Update function
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
    v_user := COALESCE(
        (to_jsonb(NEW)->>'user_id')::uuid,
        (to_jsonb(NEW)->>'owner_id')::uuid,
        (CASE WHEN NEW.owner_id IS NOT NULL THEN NEW.owner_id::uuid ELSE NULL END)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT, (to_jsonb(NEW)->>'uuid'), (to_jsonb(NEW)->>'pk'), '-');
    v_user := COALESCE(
        (to_jsonb(NEW)->>'user_id')::uuid,
        (to_jsonb(NEW)->>'owner_id')::uuid,
        (CASE WHEN NEW.owner_id IS NOT NULL THEN NEW.owner_id::uuid ELSE NULL END)
    );
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    v_data := NULL;
    v_id := COALESCE(OLD.id::TEXT, (to_jsonb(OLD)->>'uuid'), (to_jsonb(OLD)->>'pk'), '-');
    v_user := COALESCE(
        (to_jsonb(OLD)->>'user_id')::uuid,
        (to_jsonb(OLD)->>'owner_id')::uuid,
        (CASE WHEN OLD.owner_id IS NOT NULL THEN OLD.owner_id::uuid ELSE NULL END)
    );
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 