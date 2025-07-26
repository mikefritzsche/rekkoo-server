-- 021_add_collaboration_groups_triggers.sql
-- Adds triggers so that INSERT/UPDATE/DELETE on collaboration_groups are logged in change_log via track_changes()

-- Ensure the change tracking function exists (it should be created by initial migrations)
-- If not, raise an error so the deploy fails visibly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

-- Drop existing triggers if they exist to avoid duplicates when re-running migration
DROP TRIGGER IF EXISTS trg_collab_groups_changes ON collaboration_groups;

-- Create a single trigger that fires on INSERT, UPDATE, DELETE
CREATE TRIGGER trg_collab_groups_changes
AFTER INSERT OR UPDATE OR DELETE ON collaboration_groups
FOR EACH ROW EXECUTE FUNCTION track_changes(); 