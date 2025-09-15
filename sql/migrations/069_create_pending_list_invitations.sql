-- Migration: Create pending_list_invitations table for individual list sharing with non-connected users
-- This table stores pending list invitations that require connection or user acceptance

BEGIN;

-- Create enum for invitation context
DO $$ BEGIN
  CREATE TYPE invitation_context_type AS ENUM ('direct_share', 'connection_required');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create pending_list_invitations table
CREATE TABLE IF NOT EXISTS pending_list_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'commenter', 'editor', 'admin', 'reserver')),
  permissions JSONB DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  invitation_code VARCHAR(255) UNIQUE NOT NULL DEFAULT LOWER(CONCAT('LI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
  message TEXT,
  invitation_context invitation_context_type NOT NULL DEFAULT 'direct_share',
  connection_invitation_id UUID REFERENCES connection_invitations(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
  reminder_sent_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT unique_pending_list_invitation UNIQUE(list_id, invitee_id),
  CONSTRAINT no_self_invitation CHECK (inviter_id != invitee_id)
);

-- Create indexes for efficient queries
CREATE INDEX idx_pending_list_invitations_invitee ON pending_list_invitations(invitee_id, status) WHERE status = 'pending';
CREATE INDEX idx_pending_list_invitations_inviter ON pending_list_invitations(inviter_id, status);
CREATE INDEX idx_pending_list_invitations_list ON pending_list_invitations(list_id, status);
CREATE INDEX idx_pending_list_invitations_connection ON pending_list_invitations(connection_invitation_id) WHERE connection_invitation_id IS NOT NULL;
CREATE INDEX idx_pending_list_invitations_expires ON pending_list_invitations(expires_at, status) WHERE status = 'pending';
CREATE INDEX idx_pending_list_invitations_code ON pending_list_invitations(invitation_code);

-- Function to auto-expire old invitations
CREATE OR REPLACE FUNCTION expire_pending_list_invitations()
RETURNS void AS $$
BEGIN
  UPDATE pending_list_invitations
  SET status = 'expired',
      responded_at = CURRENT_TIMESTAMP
  WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Function to check and create pending invitation if needed
CREATE OR REPLACE FUNCTION create_or_update_pending_list_invitation(
  p_list_id UUID,
  p_inviter_id UUID,
  p_invitee_id UUID,
  p_role VARCHAR(20),
  p_permissions JSONB DEFAULT NULL,
  p_message TEXT DEFAULT NULL,
  p_connection_invitation_id UUID DEFAULT NULL
)
RETURNS TABLE (
  invitation_id UUID,
  invitation_status VARCHAR(50),
  requires_connection BOOLEAN
) AS $$
DECLARE
  v_invitation_id UUID;
  v_status VARCHAR(50);
  v_requires_connection BOOLEAN := FALSE;
  v_are_connected BOOLEAN;
  v_privacy_mode VARCHAR(20);
BEGIN
  -- Check if users are connected
  SELECT EXISTS (
    SELECT 1
    FROM connections c1
    WHERE c1.user_id = p_inviter_id
      AND c1.connection_id = p_invitee_id
      AND c1.status = 'accepted'
      AND EXISTS (
        SELECT 1
        FROM connections c2
        WHERE c2.user_id = p_invitee_id
          AND c2.connection_id = p_inviter_id
          AND c2.status = 'accepted'
      )
  ) INTO v_are_connected;

  -- Get invitee's privacy mode
  SELECT COALESCE(
    (privacy_settings->>'privacy_mode')::VARCHAR,
    'standard'
  ) INTO v_privacy_mode
  FROM user_settings
  WHERE user_id = p_invitee_id;

  -- If not connected and user is private, require connection
  IF NOT v_are_connected AND v_privacy_mode = 'private' THEN
    v_requires_connection := TRUE;
  END IF;

  -- Check for existing invitation
  SELECT id, status
  INTO v_invitation_id, v_status
  FROM pending_list_invitations
  WHERE list_id = p_list_id
    AND invitee_id = p_invitee_id
    AND status IN ('pending', 'accepted');

  IF v_invitation_id IS NOT NULL THEN
    -- Update existing invitation if pending
    IF v_status = 'pending' THEN
      UPDATE pending_list_invitations
      SET role = p_role,
          permissions = COALESCE(p_permissions, permissions),
          message = COALESCE(p_message, message),
          connection_invitation_id = COALESCE(p_connection_invitation_id, connection_invitation_id),
          expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
      WHERE id = v_invitation_id;
    END IF;
  ELSE
    -- Create new invitation
    INSERT INTO pending_list_invitations (
      list_id,
      inviter_id,
      invitee_id,
      role,
      permissions,
      message,
      invitation_context,
      connection_invitation_id
    ) VALUES (
      p_list_id,
      p_inviter_id,
      p_invitee_id,
      p_role,
      p_permissions,
      p_message,
      CASE WHEN v_requires_connection THEN 'connection_required'::invitation_context_type ELSE 'direct_share'::invitation_context_type END,
      p_connection_invitation_id
    )
    RETURNING id INTO v_invitation_id;

    v_status := 'created';
  END IF;

  RETURN QUERY SELECT v_invitation_id, v_status, v_requires_connection;
END;
$$ LANGUAGE plpgsql;

-- Function to auto-apply pending list invitations when connection is accepted
CREATE OR REPLACE FUNCTION apply_pending_list_invitations_on_connection()
RETURNS TRIGGER AS $$
DECLARE
  v_pending_share RECORD;
BEGIN
  -- Only proceed if the connection was just accepted
  IF NEW.status = 'accepted' AND (OLD.status IS NULL OR OLD.status != 'accepted') THEN
    -- Find any pending list invitations linked to this connection invitation
    FOR v_pending_share IN
      SELECT pli.*
      FROM pending_list_invitations pli
      WHERE pli.connection_invitation_id = NEW.id
        AND pli.status = 'pending'
    LOOP
      -- Apply the list share
      INSERT INTO list_user_overrides (
        list_id,
        user_id,
        role,
        permissions,
        created_at,
        updated_at
      ) VALUES (
        v_pending_share.list_id,
        v_pending_share.invitee_id,
        v_pending_share.role,
        v_pending_share.permissions,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (list_id, user_id) DO UPDATE
      SET role = EXCLUDED.role,
          permissions = EXCLUDED.permissions,
          updated_at = CURRENT_TIMESTAMP;

      -- Mark invitation as accepted
      UPDATE pending_list_invitations
      SET status = 'accepted',
          responded_at = CURRENT_TIMESTAMP
      WHERE id = v_pending_share.id;

      -- Create notification for both parties
      INSERT INTO notifications (
        user_id,
        notification_type,
        title,
        body,
        data,
        is_read,
        created_at
      ) VALUES (
        v_pending_share.inviter_id,
        'list_share_accepted',
        'List share accepted',
        (SELECT username FROM users WHERE id = v_pending_share.invitee_id) || ' accepted your list share invitation',
        jsonb_build_object(
          'list_id', v_pending_share.list_id,
          'invitee_id', v_pending_share.invitee_id,
          'role', v_pending_share.role
        ),
        FALSE,
        CURRENT_TIMESTAMP
      );

      INSERT INTO notifications (
        user_id,
        notification_type,
        title,
        body,
        data,
        is_read,
        created_at
      ) VALUES (
        v_pending_share.invitee_id,
        'list_access_granted',
        'List access granted',
        'You now have access to the shared list',
        jsonb_build_object(
          'list_id', v_pending_share.list_id,
          'inviter_id', v_pending_share.inviter_id,
          'role', v_pending_share.role
        ),
        FALSE,
        CURRENT_TIMESTAMP
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to apply pending list invitations when connection is accepted
CREATE TRIGGER apply_list_invitations_on_connection_accept
  AFTER UPDATE OF status ON connection_invitations
  FOR EACH ROW
  EXECUTE FUNCTION apply_pending_list_invitations_on_connection();

-- Function to get pending invitations for a user with full details
CREATE OR REPLACE FUNCTION get_pending_list_invitations_for_user(p_user_id UUID)
RETURNS TABLE (
  invitation_id UUID,
  list_id UUID,
  list_name VARCHAR(255),
  list_type VARCHAR(50),
  inviter_id UUID,
  inviter_username VARCHAR(255),
  inviter_full_name VARCHAR(255),
  role VARCHAR(20),
  permissions JSONB,
  message TEXT,
  invitation_context invitation_context_type,
  requires_connection BOOLEAN,
  connection_invitation_id UUID,
  created_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  days_until_expiry INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pli.id AS invitation_id,
    pli.list_id,
    l.name AS list_name,
    l.list_type,
    pli.inviter_id,
    u.username AS inviter_username,
    u.full_name AS inviter_full_name,
    pli.role,
    pli.permissions,
    pli.message,
    pli.invitation_context,
    pli.invitation_context = 'connection_required' AS requires_connection,
    pli.connection_invitation_id,
    pli.created_at,
    pli.expires_at,
    EXTRACT(DAY FROM (pli.expires_at - CURRENT_TIMESTAMP))::INTEGER AS days_until_expiry
  FROM pending_list_invitations pli
  JOIN lists l ON l.id = pli.list_id
  JOIN users u ON u.id = pli.inviter_id
  WHERE pli.invitee_id = p_user_id
    AND pli.status = 'pending'
    AND pli.expires_at > CURRENT_TIMESTAMP
  ORDER BY pli.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Add comment to the table
COMMENT ON TABLE pending_list_invitations IS 'Stores pending list invitations for individual users, including those requiring connection establishment first';

COMMIT;