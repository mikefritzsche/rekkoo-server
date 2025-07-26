-- 020_create_track_changes_function.sql
-- Creates change_log table and the generic track_changes() trigger function

-- 1. change_log table
CREATE TABLE IF NOT EXISTS change_log (
  id              BIGSERIAL PRIMARY KEY,
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('create','update','delete')),
  data            JSONB,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. track_changes() function
CREATE OR REPLACE FUNCTION track_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT,
                     (to_jsonb(NEW)->>'uuid'),
                     (to_jsonb(NEW)->>'pk'),
                     '-');
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    v_data := to_jsonb(NEW.*);
    v_id := COALESCE(NEW.id::TEXT,
                     (to_jsonb(NEW)->>'uuid'),
                     (to_jsonb(NEW)->>'pk'),
                     '-');
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    v_data := NULL;
    v_id := COALESCE(OLD.id::TEXT,
                     (to_jsonb(OLD)->>'uuid'),
                     (to_jsonb(OLD)->>'pk'),
                     '-');
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,data)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data);

  RETURN NULL; -- AFTER trigger doesn’t modify rows
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 