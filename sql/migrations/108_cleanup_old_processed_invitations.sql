-- Create a function to clean up old processed invitations
-- This can be run periodically to clean up any missed processed invitations

CREATE OR REPLACE FUNCTION cleanup_old_processed_invitations()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete processed invitations where the user is already a group member
  -- This catches any that might have been missed by the trigger
  DELETE FROM pending_group_invitations
  WHERE id IN (
    SELECT pgi.id
    FROM pending_group_invitations pgi
    JOIN collaboration_group_members cgm ON
      cgm.group_id = pgi.group_id AND
      cgm.user_id = pgi.invitee_id AND
      cgm.deleted_at IS NULL
    WHERE pgi.status = 'processed'
  );

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Also delete processed invitations older than 7 days
  -- This cleans up any orphaned processed invitations
  DELETE FROM pending_group_invitations
  WHERE status = 'processed'
    AND created_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create a convenience function to run the cleanup
CREATE OR REPLACE FUNCTION run_cleanup_processed_invitations()
RETURNS TABLE(deleted_count INTEGER) AS $$
BEGIN
  RETURN QUERY SELECT cleanup_old_processed_invitations() as deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Insert migration record
INSERT INTO schema_migrations (version, name) VALUES (108, 'Cleanup old processed group invitations') ON CONFLICT (version) DO NOTHING;