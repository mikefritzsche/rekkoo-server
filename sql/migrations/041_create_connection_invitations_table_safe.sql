-- MIGRATION: 041_create_connection_invitations_table_safe.sql
-- Description: Creates the connection_invitations table (SAFE VERSION - can run multiple times)

-- Create the connection_invitations table (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS public.connection_invitations (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_email VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invitation_code VARCHAR(100) UNIQUE NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    reminder_sent_at TIMESTAMPTZ,
    expiration_notified_at TIMESTAMPTZ
);

-- Add CHECK constraints if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_check') THEN
        ALTER TABLE public.connection_invitations
            ADD CONSTRAINT recipient_check CHECK (
                (recipient_id IS NOT NULL AND recipient_email IS NULL) OR
                (recipient_id IS NULL AND recipient_email IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_invitation_status_check') THEN
        ALTER TABLE public.connection_invitations
            ADD CONSTRAINT connection_invitation_status_check
            CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled'));
    END IF;
END $$;

-- Create partial unique index to prevent duplicate pending invitations (drop and recreate to ensure consistency)
DROP INDEX IF EXISTS unique_pending_invitation;
CREATE UNIQUE INDEX unique_pending_invitation
    ON public.connection_invitations (sender_id, recipient_id, status)
    WHERE status = 'pending';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_connection_invitations_sender_id ON public.connection_invitations (sender_id);
CREATE INDEX IF NOT EXISTS idx_connection_invitations_recipient_id ON public.connection_invitations (recipient_id);
CREATE INDEX IF NOT EXISTS idx_connection_invitations_status ON public.connection_invitations (status);
CREATE INDEX IF NOT EXISTS idx_connection_invitations_invitation_code ON public.connection_invitations (invitation_code);
CREATE INDEX IF NOT EXISTS idx_connection_invitations_expires_at ON public.connection_invitations (expires_at);
CREATE INDEX IF NOT EXISTS idx_connection_invitations_pending_expiry ON public.connection_invitations (expires_at)
    WHERE status = 'pending';

-- Function to generate unique invitation code
CREATE OR REPLACE FUNCTION public.generate_invitation_code()
RETURNS VARCHAR(100) AS $$
DECLARE
    code VARCHAR(100);
    code_exists BOOLEAN;
BEGIN
    LOOP
        -- Generate a random code (e.g., INV-XXXXXXXX)
        code := 'INV-' || UPPER(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT)::TEXT);
        code := SUBSTRING(code, 1, 12);

        -- Check if code already exists
        SELECT EXISTS(
            SELECT 1 FROM public.connection_invitations
            WHERE invitation_code = code
        ) INTO code_exists;

        EXIT WHEN NOT code_exists;
    END LOOP;

    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate invitation code
CREATE OR REPLACE FUNCTION public.set_invitation_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invitation_code IS NULL THEN
        NEW.invitation_code := public.generate_invitation_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate triggers
DROP TRIGGER IF EXISTS set_connection_invitation_code ON public.connection_invitations;
CREATE TRIGGER set_connection_invitation_code
    BEFORE INSERT ON public.connection_invitations
    FOR EACH ROW EXECUTE FUNCTION public.set_invitation_code();

DROP TRIGGER IF EXISTS sync_log_trigger_connection_invitations ON public.connection_invitations;
CREATE TRIGGER sync_log_trigger_connection_invitations
    AFTER INSERT OR UPDATE OR DELETE ON public.connection_invitations
    FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

-- Add comments
COMMENT ON TABLE public.connection_invitations IS 'Manages connection invitations with 30-day expiration and notification tracking';
COMMENT ON COLUMN public.connection_invitations.invitation_code IS 'Unique code for invitation links';
COMMENT ON COLUMN public.connection_invitations.reminder_sent_at IS 'Timestamp when 25-day reminder was sent';
COMMENT ON COLUMN public.connection_invitations.expiration_notified_at IS 'Timestamp when 28-day expiration warning was sent';

-- Verify the table was created/exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'connection_invitations') THEN
        RAISE NOTICE 'Table public.connection_invitations is ready';
    ELSE
        RAISE EXCEPTION 'Failed to create table public.connection_invitations';
    END IF;
END $$;