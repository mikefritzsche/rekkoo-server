-- 031_patch_track_changes_for_list_sharing.sql
-- Ensure track_changes() can infer user_id for list_scoped tables like list_sharing

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'track_changes'
  ) THEN
    RAISE EXCEPTION 'track_changes() missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION track_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
  v_list_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT, (to_jsonb(NEW)->>'uuid'), (to_jsonb(NEW)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(NEW)->>'user_id')::uuid, (to_jsonb(NEW)->>'owner_id')::uuid, NULL);
    v_list_id := (to_jsonb(NEW)->>'list_id')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT, (to_jsonb(NEW)->>'uuid'), (to_jsonb(NEW)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(NEW)->>'user_id')::uuid, (to_jsonb(NEW)->>'owner_id')::uuid, NULL);
    v_list_id := (to_jsonb(NEW)->>'list_id')::uuid;
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    v_data := NULL;
    v_id := COALESCE(OLD.id::TEXT, (to_jsonb(OLD)->>'uuid'), (to_jsonb(OLD)->>'pk'), '-');
    v_user := COALESCE((to_jsonb(OLD)->>'user_id')::uuid, (to_jsonb(OLD)->>'owner_id')::uuid, NULL);
    v_list_id := (to_jsonb(OLD)->>'list_id')::uuid;
  END IF;

  -- For list_scoped tables, derive user_id from owning list when missing
  IF v_user IS NULL AND v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_user FROM public.lists WHERE id = v_list_id;
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;






