-- 028_add_collaboration_groups_to_sync.sql
-- Ensure collaboration tables are tracked for sync

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_collaboration_groups_changes ON public.collaboration_groups;
CREATE TRIGGER trg_collaboration_groups_changes
AFTER INSERT OR UPDATE OR DELETE ON public.collaboration_groups
FOR EACH ROW EXECUTE FUNCTION track_changes();

DROP TRIGGER IF EXISTS trg_collaboration_group_members_changes ON public.collaboration_group_members;
CREATE TRIGGER trg_collaboration_group_members_changes
AFTER INSERT OR UPDATE OR DELETE ON public.collaboration_group_members
FOR EACH ROW EXECUTE FUNCTION track_changes();





