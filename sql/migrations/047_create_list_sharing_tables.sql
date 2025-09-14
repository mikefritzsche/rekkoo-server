-- 047_create_list_sharing_tables.sql
-- Phase 3: List Sharing with Groups
-- Creates tables for list invitations and sharing management
-- Requires: connections system (044-046) and existing list tables

BEGIN;

-- 1. Safeguard: ensure required functions exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    RAISE EXCEPTION 'update_updated_at_column() function is missing. Run core migrations first.';
  END IF;
END $$;

-- 2. Create list_invitations table for inviting users to collaborate on lists
CREATE TABLE IF NOT EXISTS public.list_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Role the invitee will have if they accept
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'admin', 'reserver')),

  -- Optional message from inviter
  message TEXT,

  -- Unique invitation code for tracking
  invitation_code TEXT UNIQUE NOT NULL,

  -- Invitation status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),

  -- Expiration (30 days by default)
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,

  -- Prevent duplicate invitations to same user for same list
  UNIQUE(list_id, invitee_id)
);

-- Create indexes for performance
CREATE INDEX idx_list_invitations_list_id ON public.list_invitations(list_id);
CREATE INDEX idx_list_invitations_inviter_id ON public.list_invitations(inviter_id);
CREATE INDEX idx_list_invitations_invitee_id ON public.list_invitations(invitee_id);
CREATE INDEX idx_list_invitations_status ON public.list_invitations(status);
CREATE INDEX idx_list_invitations_expires_at ON public.list_invitations(expires_at);
CREATE INDEX idx_list_invitations_code ON public.list_invitations(invitation_code);

-- 3. Create list_shares table for tracking active shares (audit trail)
CREATE TABLE IF NOT EXISTS public.list_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  shared_by UUID NOT NULL REFERENCES public.users(id),

  -- Who/what the list is shared with
  shared_with_type TEXT NOT NULL CHECK (shared_with_type IN ('user', 'group')),
  shared_with_id UUID NOT NULL, -- user_id or group_id depending on type

  -- Permission level
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'admin', 'reserver')),

  -- Share metadata
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES public.users(id),

  -- Prevent duplicate shares
  UNIQUE(list_id, shared_with_type, shared_with_id)
);

-- Create indexes for performance
CREATE INDEX idx_list_shares_list_id ON public.list_shares(list_id);
CREATE INDEX idx_list_shares_shared_by ON public.list_shares(shared_by);
CREATE INDEX idx_list_shares_shared_with ON public.list_shares(shared_with_type, shared_with_id);
CREATE INDEX idx_list_shares_revoked_at ON public.list_shares(revoked_at);

-- 4. Function to generate unique invitation codes
CREATE OR REPLACE FUNCTION generate_list_invitation_code()
RETURNS TEXT AS $$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
BEGIN
  LOOP
    -- Generate a code like 'LST-XXXXX' where X is alphanumeric
    code := 'LST-' || UPPER(
      SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FOR 5)
    );

    -- Check if this code already exists
    SELECT EXISTS(
      SELECT 1 FROM public.list_invitations WHERE invitation_code = code
    ) INTO exists_check;

    -- If unique, return it
    IF NOT exists_check THEN
      RETURN code;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 5. Trigger to auto-generate invitation codes
CREATE OR REPLACE FUNCTION set_list_invitation_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.invitation_code IS NULL THEN
    NEW.invitation_code := generate_list_invitation_code();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_list_invitation_code
BEFORE INSERT ON public.list_invitations
FOR EACH ROW
EXECUTE FUNCTION set_list_invitation_code();

-- 6. Function to check if user can invite to list (must be owner or admin)
CREATE OR REPLACE FUNCTION can_invite_to_list(
  p_user_id UUID,
  p_list_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  is_owner BOOLEAN;
  has_admin_role BOOLEAN;
BEGIN
  -- Check if user is the list owner
  SELECT EXISTS(
    SELECT 1 FROM public.lists
    WHERE id = p_list_id AND owner_id = p_user_id
  ) INTO is_owner;

  IF is_owner THEN
    RETURN TRUE;
  END IF;

  -- Check if user has admin role via group
  SELECT EXISTS(
    SELECT 1 FROM public.list_group_roles lgr
    JOIN public.group_members gm ON gm.group_id = lgr.group_id
    WHERE lgr.list_id = p_list_id
    AND gm.user_id = p_user_id
    AND lgr.role = 'admin'
  ) INTO has_admin_role;

  IF has_admin_role THEN
    RETURN TRUE;
  END IF;

  -- Check if user has admin role via user override
  SELECT EXISTS(
    SELECT 1 FROM public.list_user_overrides
    WHERE list_id = p_list_id
    AND user_id = p_user_id
    AND role = 'admin'
  ) INTO has_admin_role;

  RETURN has_admin_role;
END;
$$ LANGUAGE plpgsql;

-- 7. Function to check if users are connected (for invitation validation)
CREATE OR REPLACE FUNCTION are_users_connected(
  p_user1_id UUID,
  p_user2_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM public.connections
    WHERE user_id = p_user1_id
    AND connection_id = p_user2_id
    AND (
      (status = 'accepted' AND connection_type = 'mutual')
      OR (status = 'following' AND connection_type = 'following')
    )
  );
END;
$$ LANGUAGE plpgsql;

-- 8. Function to accept list invitation and create appropriate permission record
CREATE OR REPLACE FUNCTION accept_list_invitation(
  p_invitation_id UUID,
  p_user_id UUID
) RETURNS VOID AS $$
DECLARE
  v_invitation RECORD;
BEGIN
  -- Get invitation details
  SELECT * INTO v_invitation
  FROM public.list_invitations
  WHERE id = p_invitation_id
  AND invitee_id = p_user_id
  AND status = 'pending'
  AND expires_at > CURRENT_TIMESTAMP;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invitation';
  END IF;

  -- Update invitation status
  UPDATE public.list_invitations
  SET status = 'accepted',
      accepted_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_invitation_id;

  -- Create user override with the specified role
  INSERT INTO public.list_user_overrides (list_id, user_id, role)
  VALUES (v_invitation.list_id, v_invitation.invitee_id, v_invitation.role)
  ON CONFLICT (list_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP;

  -- Record the share
  INSERT INTO public.list_shares (list_id, shared_by, shared_with_type, shared_with_id, role)
  VALUES (v_invitation.list_id, v_invitation.inviter_id, 'user', v_invitation.invitee_id, v_invitation.role)
  ON CONFLICT (list_id, shared_with_type, shared_with_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- 9. Function to expire old invitations (to be called periodically)
CREATE OR REPLACE FUNCTION expire_old_list_invitations()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE public.list_invitations
  SET status = 'expired',
      updated_at = CURRENT_TIMESTAMP
  WHERE status = 'pending'
  AND expires_at < CURRENT_TIMESTAMP;

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- 10. Add triggers for sync
DROP TRIGGER IF EXISTS trg_list_invitations_changes ON public.list_invitations;
CREATE TRIGGER trg_list_invitations_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_invitations
FOR EACH ROW EXECUTE FUNCTION track_changes();

DROP TRIGGER IF EXISTS trg_list_shares_changes ON public.list_shares;
CREATE TRIGGER trg_list_shares_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_shares
FOR EACH ROW EXECUTE FUNCTION track_changes();

-- 11. Add updated_at triggers
DROP TRIGGER IF EXISTS update_list_invitations_updated_at ON public.list_invitations;
CREATE TRIGGER update_list_invitations_updated_at
BEFORE UPDATE ON public.list_invitations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_list_shares_updated_at ON public.list_shares;
CREATE TRIGGER update_list_shares_updated_at
BEFORE UPDATE ON public.list_shares
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 12. Comments for documentation
COMMENT ON TABLE public.list_invitations IS 'Manages invitations for users to collaborate on lists';
COMMENT ON TABLE public.list_shares IS 'Tracks active list shares with users and groups';
COMMENT ON FUNCTION can_invite_to_list IS 'Checks if a user has permission to invite others to a list';
COMMENT ON FUNCTION are_users_connected IS 'Verifies if two users have an active connection';
COMMENT ON FUNCTION accept_list_invitation IS 'Accepts a list invitation and creates appropriate permissions';
COMMENT ON FUNCTION expire_old_list_invitations IS 'Marks expired invitations - should be called periodically';

COMMIT;

-- Migration verification
DO $$
BEGIN
  RAISE NOTICE 'Migration 047_create_list_sharing_tables completed successfully';
  RAISE NOTICE 'Created tables: list_invitations, list_shares';
  RAISE NOTICE 'Created functions: generate_list_invitation_code, can_invite_to_list, are_users_connected, accept_list_invitation';
  RAISE NOTICE 'List sharing infrastructure is ready';
END $$;