-- 027_add_list_sharing_triggers.sql
-- Ensure list_sharing and gift_reservations changes are tracked for sync

-- Safeguard: ensure track_changes() exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

-- Drop existing triggers to avoid duplicates
DROP TRIGGER IF EXISTS trg_list_sharing_changes ON public.list_sharing;
DROP TRIGGER IF EXISTS trg_gift_reservations_changes ON public.gift_reservations;

-- Create triggers to log changes for sync
CREATE TRIGGER trg_list_sharing_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_sharing
FOR EACH ROW EXECUTE FUNCTION track_changes();

CREATE TRIGGER trg_gift_reservations_changes
AFTER INSERT OR UPDATE OR DELETE ON public.gift_reservations
FOR EACH ROW EXECUTE FUNCTION track_changes();




