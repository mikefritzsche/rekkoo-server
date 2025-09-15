-- Migration: Create group_invitations table for connection-based group invitation system
-- Purpose: Allow users to invite their connections to groups with explicit consent

CREATE TABLE IF NOT EXISTS group_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
    invitation_code VARCHAR(20) UNIQUE NOT NULL DEFAULT substring(md5(random()::text), 1, 20),
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    reminder_sent_at TIMESTAMP WITH TIME ZONE,
    expiration_notified_at TIMESTAMP WITH TIME ZONE,


    CONSTRAINT inviter_must_be_member CHECK (
        EXISTS (
            SELECT 1 FROM group_members gm
            WHERE gm.group_id = group_invitations.group_id
            AND gm.user_id = group_invitations.inviter_id
        )
    ),

    
    CONSTRAINT unique_pending_invitation UNIQUE (group_id, invitee_id, status)
        DEFERRABLE INITIALLY DEFERRED
);

-- Create indexes for efficient queries
CREATE INDEX idx_group_invitations_invitee_status ON group_invitations(invitee_id, status) WHERE status = 'pending';
CREATE INDEX idx_group_invitations_group_status ON group_invitations(group_id, status) WHERE status = 'pending';
CREATE INDEX idx_group_invitations_inviter ON group_invitations(inviter_id);
CREATE INDEX idx_group_invitations_expires_at ON group_invitations(expires_at) WHERE status = 'pending';
CREATE INDEX idx_group_invitations_code ON group_invitations(invitation_code) WHERE status = 'pending';

-- Add reference to group_members for tracking invitation source
ALTER TABLE group_members
ADD COLUMN IF NOT EXISTS invitation_id UUID REFERENCES group_invitations(id),
ADD COLUMN IF NOT EXISTS joined_via VARCHAR(20) DEFAULT 'direct' CHECK (joined_via IN ('direct', 'invitation', 'owner'));

-- Function to automatically expire old invitations
CREATE OR REPLACE FUNCTION expire_old_group_invitations()
RETURNS void AS $$
BEGIN
    UPDATE group_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Function to check if users are connected before allowing invitation
CREATE OR REPLACE FUNCTION check_connection_before_group_invitation()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if inviter and invitee are connected
    IF NOT EXISTS (
        SELECT 1 FROM connections c1
        WHERE c1.user_id = NEW.inviter_id
        AND c1.connection_id = NEW.invitee_id
        AND c1.status = 'accepted'
        AND c1.removed_at IS NULL
    ) AND NOT EXISTS (
        SELECT 1 FROM connections c2
        WHERE c2.user_id = NEW.invitee_id
        AND c2.connection_id = NEW.inviter_id
        AND c2.status = 'accepted'
        AND c2.removed_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Cannot invite user to group: users must be connected first';
    END IF;

    -- Check if invitee is already a member
    IF EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = NEW.group_id
        AND user_id = NEW.invitee_id
    ) THEN
        RAISE EXCEPTION 'User is already a member of this group';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to enforce connection requirement
CREATE TRIGGER enforce_connection_for_group_invitation
    BEFORE INSERT ON group_invitations
    FOR EACH ROW
    EXECUTE FUNCTION check_connection_before_group_invitation();

-- Function to handle invitation acceptance
CREATE OR REPLACE FUNCTION accept_group_invitation(
    p_invitation_id UUID,
    p_user_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    message TEXT,
    group_id UUID
) AS $$
DECLARE
    v_group_id UUID;
    v_invitee_id UUID;
    v_status VARCHAR(20);
BEGIN
    -- Get invitation details
    SELECT gi.group_id, gi.invitee_id, gi.status
    INTO v_group_id, v_invitee_id, v_status
    FROM group_invitations gi
    WHERE gi.id = p_invitation_id;

    -- Verify the accepting user is the invitee
    IF v_invitee_id != p_user_id THEN
        RETURN QUERY SELECT FALSE, 'You are not authorized to accept this invitation', NULL::UUID;
        RETURN;
    END IF;

    -- Check invitation status
    IF v_status != 'pending' THEN
        RETURN QUERY SELECT FALSE, 'This invitation is no longer pending', v_group_id;
        RETURN;
    END IF;

    -- Check if invitation has expired
    IF EXISTS (
        SELECT 1 FROM group_invitations
        WHERE id = p_invitation_id
        AND expires_at < CURRENT_TIMESTAMP
    ) THEN
        -- Mark as expired
        UPDATE group_invitations
        SET status = 'expired',
            responded_at = CURRENT_TIMESTAMP
        WHERE id = p_invitation_id;

        RETURN QUERY SELECT FALSE, 'This invitation has expired', v_group_id;
        RETURN;
    END IF;

    -- Accept the invitation
    UPDATE group_invitations
    SET status = 'accepted',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    -- Add user to group
    INSERT INTO group_members (group_id, user_id, role, invitation_id, joined_via)
    VALUES (v_group_id, p_user_id, 'member', p_invitation_id, 'invitation')
    ON CONFLICT (group_id, user_id) DO NOTHING;

    RETURN QUERY SELECT TRUE, 'Successfully joined the group', v_group_id;
END;
$$ LANGUAGE plpgsql;

-- Function to handle invitation decline
CREATE OR REPLACE FUNCTION decline_group_invitation(
    p_invitation_id UUID,
    p_user_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    message TEXT
) AS $$
DECLARE
    v_invitee_id UUID;
    v_status VARCHAR(20);
BEGIN
    -- Get invitation details
    SELECT invitee_id, status
    INTO v_invitee_id, v_status
    FROM group_invitations
    WHERE id = p_invitation_id;

    -- Verify the declining user is the invitee
    IF v_invitee_id != p_user_id THEN
        RETURN QUERY SELECT FALSE, 'You are not authorized to decline this invitation';
        RETURN;
    END IF;

    -- Check invitation status
    IF v_status != 'pending' THEN
        RETURN QUERY SELECT FALSE, 'This invitation is no longer pending';
        RETURN;
    END IF;

    -- Decline the invitation
    UPDATE group_invitations
    SET status = 'declined',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT TRUE, 'Invitation declined';
END;
$$ LANGUAGE plpgsql;

-- Function to cancel an invitation (by inviter or group admin)
CREATE OR REPLACE FUNCTION cancel_group_invitation(
    p_invitation_id UUID,
    p_user_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    message TEXT
) AS $$
DECLARE
    v_inviter_id UUID;
    v_group_id UUID;
    v_status VARCHAR(20);
BEGIN
    -- Get invitation details
    SELECT inviter_id, group_id, status
    INTO v_inviter_id, v_group_id, v_status
    FROM group_invitations
    WHERE id = p_invitation_id;

    -- Check if user can cancel (must be inviter or group admin)
    IF v_inviter_id != p_user_id AND NOT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = v_group_id
        AND user_id = p_user_id
        AND role IN ('admin', 'owner')
    ) THEN
        RETURN QUERY SELECT FALSE, 'You are not authorized to cancel this invitation';
        RETURN;
    END IF;

    -- Check invitation status
    IF v_status != 'pending' THEN
        RETURN QUERY SELECT FALSE, 'This invitation is no longer pending';
        RETURN;
    END IF;

    -- Cancel the invitation
    UPDATE group_invitations
    SET status = 'cancelled',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT TRUE, 'Invitation cancelled';
END;
$$ LANGUAGE plpgsql;

-- Add comment for documentation
COMMENT ON TABLE group_invitations IS 'Stores group invitations that require explicit acceptance from connected users';
COMMENT ON COLUMN group_invitations.invitation_code IS 'Unique code for invitation links/deep linking';
COMMENT ON COLUMN group_invitations.expires_at IS 'Invitations expire after 30 days by default';