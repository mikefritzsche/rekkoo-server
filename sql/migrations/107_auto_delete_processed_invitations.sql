-- Auto-delete processed group invitations when user joins the group
-- This prevents stale processed invitations from showing as pending in the UI

CREATE OR REPLACE FUNCTION delete_processed_group_invitations()
RETURNS TRIGGER AS $$
BEGIN
  -- Delete any processed invitations for this user and group
  -- since they're now officially a member
  DELETE FROM pending_group_invitations
  WHERE invitee_id = NEW.user_id
    AND group_id = NEW.group_id
    AND status = 'processed';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically clean up when a user joins a group
DROP TRIGGER IF EXISTS auto_delete_processed_invitations ON collaboration_group_members;
CREATE TRIGGER auto_delete_processed_invitations
  AFTER INSERT ON collaboration_group_members
  FOR EACH ROW
  EXECUTE FUNCTION delete_processed_group_invitations();

-- Also clean up any existing processed invitations where user is already in group
-- This is a one-time cleanup for existing data
INSERT INTO schema_migrations (version, name) VALUES (107, 'Auto-delete processed group invitations') ON CONFLICT (version) DO NOTHING;