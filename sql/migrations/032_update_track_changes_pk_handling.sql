-- 032_update_track_changes_pk_handling.sql
-- Make track_changes() robust for tables without an `id` column by deriving a composite key when needed

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
  j JSONB;
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
  v_list_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    j := to_jsonb(OLD.*);
    v_data := NULL;
  END IF;

  -- Derive record identifier
  v_id := COALESCE(
    j->>'id',
    j->>'uuid',
    j->>'pk',
    CASE WHEN (j ? 'list_id') AND (j ? 'group_id') THEN (j->>'list_id') || ':' || (j->>'group_id') ELSE NULL END,
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  -- Derive user and list ownership
  v_user := COALESCE((j->>'user_id')::uuid, (j->>'owner_id')::uuid, NULL);
  v_list_id := (j->>'list_id')::uuid;
  IF v_user IS NULL AND v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_user FROM public.lists WHERE id = v_list_id;
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;





