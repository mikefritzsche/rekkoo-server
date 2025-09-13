-- MIGRATION: 043_create_group_invitations_table_safe.sql
-- Description: Creates the group_invitations table (SAFE VERSION - can run multiple times)

-- Create the group_invitations table (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS public.group_invitations (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invitation_code VARCHAR(100) UNIQUE NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days')
);

-- Add CHECK constraints if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_owner_invitation') THEN
        ALTER TABLE public.group_invitations
            ADD CONSTRAINT no_owner_invitation
            CHECK (invitee_id != inviter_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_invitation_status_check') THEN
        ALTER TABLE public.group_invitations
            ADD CONSTRAINT group_invitation_status_check
            CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled'));
    END IF;
END $$;

-- Create partial unique index to prevent duplicate pending invitations (drop and recreate)
DROP INDEX IF EXISTS unique_pending_group_invitation;
CREATE UNIQUE INDEX unique_pending_group_invitation
    ON public.group_invitations (group_id, invitee_id, status)
    WHERE status = 'pending';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_group_invitations_group_id ON public.group_invitations (group_id);
CREATE INDEX IF NOT EXISTS idx_group_invitations_inviter_id ON public.group_invitations (inviter_id);
CREATE INDEX IF NOT EXISTS idx_group_invitations_invitee_id ON public.group_invitations (invitee_id);
CREATE INDEX IF NOT EXISTS idx_group_invitations_status ON public.group_invitations (status);
CREATE INDEX IF NOT EXISTS idx_group_invitations_invitation_code ON public.group_invitations (invitation_code);
CREATE INDEX IF NOT EXISTS idx_group_invitations_expires_at ON public.group_invitations (expires_at)
    WHERE status = 'pending';

-- Ensure set_invitation_code function exists (might be created in 041)
CREATE OR REPLACE FUNCTION public.set_invitation_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invitation_code IS NULL THEN
        -- Try to use generate_invitation_code if it exists
        BEGIN
            NEW.invitation_code := public.generate_invitation_code();
        EXCEPTION
            WHEN OTHERS THEN
                -- Fallback to simple generation
                NEW.invitation_code := 'GRP-' || UPPER(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT)::TEXT);
                NEW.invitation_code := SUBSTRING(NEW.invitation_code, 1, 12);
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate trigger for invitation code
DROP TRIGGER IF EXISTS set_group_invitation_code ON public.group_invitations;
CREATE TRIGGER set_group_invitation_code
    BEFORE INSERT ON public.group_invitations
    FOR EACH ROW EXECUTE FUNCTION public.set_invitation_code();

-- Function to check if users are connected before group invitation
CREATE OR REPLACE FUNCTION public.check_connection_before_group_invite()
RETURNS TRIGGER AS $$
DECLARE
    are_connected BOOLEAN;
BEGIN
    -- Check if inviter and invitee are connected (both have accepted status)
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE ((user_id = NEW.inviter_id AND connection_id = NEW.invitee_id)
            OR (user_id = NEW.invitee_id AND connection_id = NEW.inviter_id))
        AND status = 'accepted'
    ) INTO are_connected;

    IF NOT are_connected THEN
        RAISE EXCEPTION 'Cannot invite user to group: users must be connected first';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate trigger to enforce connection requirement
DROP TRIGGER IF EXISTS enforce_connection_before_group_invite ON public.group_invitations;
CREATE TRIGGER enforce_connection_before_group_invite
    BEFORE INSERT ON public.group_invitations
    FOR EACH ROW EXECUTE FUNCTION public.check_connection_before_group_invite();

-- Function to add user to group when invitation is accepted
CREATE OR REPLACE FUNCTION public.accept_group_invitation()
RETURNS TRIGGER AS $$
BEGIN
    -- Only process when status changes to 'accepted'
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Add user to group members
        INSERT INTO public.collaboration_group_members (group_id, user_id, role, joined_at)
        VALUES (NEW.group_id, NEW.invitee_id, 'member', CURRENT_TIMESTAMP)
        ON CONFLICT (group_id, user_id) DO NOTHING;

        -- Set responded_at timestamp
        NEW.responded_at := CURRENT_TIMESTAMP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate trigger for group acceptance
DROP TRIGGER IF EXISTS process_group_invitation_acceptance ON public.group_invitations;
CREATE TRIGGER process_group_invitation_acceptance
    BEFORE UPDATE ON public.group_invitations
    FOR EACH ROW EXECUTE FUNCTION public.accept_group_invitation();

-- Drop and recreate trigger for change log tracking
DROP TRIGGER IF EXISTS sync_log_trigger_group_invitations ON public.group_invitations;
CREATE TRIGGER sync_log_trigger_group_invitations
    AFTER INSERT OR UPDATE OR DELETE ON public.group_invitations
    FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

-- Add comments
COMMENT ON TABLE public.group_invitations IS 'Manages group membership invitations with connection requirement and 30-day expiration';
COMMENT ON COLUMN public.group_invitations.invitation_code IS 'Unique code for invitation links';
COMMENT ON COLUMN public.group_invitations.message IS 'Optional personalized message from inviter';

-- Verify the table was created/exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'group_invitations') THEN
        RAISE NOTICE 'Table public.group_invitations is ready';
    ELSE
        RAISE EXCEPTION 'Failed to create table public.group_invitations';
    END IF;
END $$;