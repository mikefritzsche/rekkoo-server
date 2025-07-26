-- 023_alter_change_log_add_data_column.sql
-- Ensures change_log table has a data JSONB column used by track_changes()

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'change_log' AND column_name = 'data'
  ) THEN
    ALTER TABLE change_log ADD COLUMN data JSONB;
  END IF;
END $$; 