-- 036_fix_gift_reservations_track_changes.sql
-- Fix track_changes trigger to handle reserved_by field in gift_reservations table

-- Update the track_changes function to handle reserved_by field for gift_reservations
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

  -- Derive record ID based on various primary key patterns
  v_id := COALESCE(
    (j->>'id')::TEXT,
    (j->>'uuid')::TEXT,
    (j->>'pk')::TEXT,
    -- Composite keys for specific tables
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  -- Derive user_id from various fields, including reserved_by for gift_reservations
  v_user := COALESCE(
    (j->>'user_id')::uuid, 
    (j->>'owner_id')::uuid,
    -- Special handling for gift_reservations table
    CASE WHEN TG_TABLE_NAME = 'gift_reservations' THEN (j->>'reserved_by')::uuid ELSE NULL END,
    NULL
  );
  
  v_list_id := (j->>'list_id')::uuid;
  
  -- For list_scoped tables, derive user_id from owning list when missing
  IF v_user IS NULL AND v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_user FROM public.lists WHERE id = v_list_id;
  END IF;

  -- For gift_reservations, try to get user from item's list if still null
  IF v_user IS NULL AND TG_TABLE_NAME = 'gift_reservations' AND (j->>'item_id') IS NOT NULL THEN
    SELECT l.owner_id INTO v_user 
    FROM public.list_items li 
    JOIN public.lists l ON li.list_id = l.id 
    WHERE li.id = (j->>'item_id')::uuid;
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;