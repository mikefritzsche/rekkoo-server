-- 034_update_track_changes_prefer_list_owner.sql
-- Prefer list owner for change_log.user_id when list_id is present (e.g., list_user_overrides)

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
  v_owner UUID;
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

  -- Derive record identifier (supports composite keys)
  v_id := COALESCE(
    j->>'id',
    j->>'uuid',
    j->>'pk',
    CASE WHEN (j ? 'list_id') AND (j ? 'group_id') THEN (j->>'list_id') || ':' || (j->>'group_id') ELSE NULL END,
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  -- Prefer list owner if list_id is present
  v_list_id := NULLIF(j->>'list_id', '')::uuid;
  IF v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_owner FROM public.lists WHERE id = v_list_id;
  END IF;

  v_user := COALESCE(v_owner, NULLIF(j->>'user_id','')::uuid, NULLIF(j->>'owner_id','')::uuid);

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


