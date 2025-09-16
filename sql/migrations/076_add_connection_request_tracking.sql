-- Migration: Add Connection Request Tracking and Rate Limiting
-- Purpose: Track connection attempts, rejections, and implement anti-harassment features

BEGIN;

-- Add tracking columns to connection_invitations table
ALTER TABLE public.connection_invitations
ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS last_declined_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS decline_type VARCHAR(20) DEFAULT 'standard', -- 'standard', 'soft_block', 'permanent'
ADD COLUMN IF NOT EXISTS decline_message TEXT,
ADD COLUMN IF NOT EXISTS can_retry_after TIMESTAMPTZ;

-- Create a table to track connection request history between users
CREATE TABLE IF NOT EXISTS public.connection_request_history (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    total_attempts INTEGER DEFAULT 1,
    declined_count INTEGER DEFAULT 0,
    accepted_count INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_declined_at TIMESTAMPTZ,
    last_accepted_at TIMESTAMPTZ,
    is_soft_blocked BOOLEAN DEFAULT FALSE,
    soft_blocked_at TIMESTAMPTZ,
    soft_block_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sender_id, recipient_id)
);

-- Create index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_connection_request_history_lookup
ON public.connection_request_history(sender_id, recipient_id);

CREATE INDEX IF NOT EXISTS idx_connection_request_history_soft_block
ON public.connection_request_history(sender_id, recipient_id)
WHERE is_soft_blocked = TRUE;

-- Function to check if a user can send a connection request
CREATE OR REPLACE FUNCTION public.can_send_connection_request(
    p_sender_id UUID,
    p_recipient_id UUID
) RETURNS TABLE(
    can_send BOOLEAN,
    reason VARCHAR(100),
    retry_after TIMESTAMPTZ,
    attempt_count INTEGER,
    declined_count INTEGER
) AS $$
DECLARE
    v_history RECORD;
    v_last_invitation RECORD;
    v_is_blocked BOOLEAN;
    v_max_attempts INTEGER := 3; -- Maximum attempts allowed
    v_cooldown_days INTEGER := 30; -- Days to wait after rejection
    v_soft_block_days INTEGER := 90; -- Soft block duration
BEGIN
    -- Check if users are already connected
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE user_id = p_sender_id
        AND connection_id = p_recipient_id
        AND status IN ('accepted', 'following')
    ) INTO v_is_blocked;

    IF v_is_blocked THEN
        RETURN QUERY SELECT FALSE, 'Already connected'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check if the sender is blocked
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE user_id = p_recipient_id
        AND connection_id = p_sender_id
        AND status = 'blocked'
    ) INTO v_is_blocked;

    IF v_is_blocked THEN
        RETURN QUERY SELECT FALSE, 'User has blocked you'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check request history
    SELECT * INTO v_history
    FROM public.connection_request_history
    WHERE sender_id = p_sender_id AND recipient_id = p_recipient_id;

    -- If no history, allow the request
    IF v_history IS NULL THEN
        RETURN QUERY SELECT TRUE, 'Can send request'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check if soft blocked
    IF v_history.is_soft_blocked THEN
        IF v_history.soft_block_expires_at IS NULL OR v_history.soft_block_expires_at > CURRENT_TIMESTAMP THEN
            RETURN QUERY SELECT
                FALSE,
                'User has declined future requests'::VARCHAR(100),
                v_history.soft_block_expires_at,
                v_history.total_attempts,
                v_history.declined_count;
            RETURN;
        END IF;
    END IF;

    -- Check if exceeded max attempts
    IF v_history.total_attempts >= v_max_attempts THEN
        RETURN QUERY SELECT
            FALSE,
            'Maximum connection attempts reached'::VARCHAR(100),
            NULL::TIMESTAMPTZ,
            v_history.total_attempts,
            v_history.declined_count;
        RETURN;
    END IF;

    -- Check cooldown period after rejection
    IF v_history.last_declined_at IS NOT NULL THEN
        IF v_history.last_declined_at + INTERVAL '1 day' * v_cooldown_days > CURRENT_TIMESTAMP THEN
            RETURN QUERY SELECT
                FALSE,
                'Please wait before sending another request'::VARCHAR(100),
                v_history.last_declined_at + INTERVAL '1 day' * v_cooldown_days,
                v_history.total_attempts,
                v_history.declined_count;
            RETURN;
        END IF;
    END IF;

    -- Check for pending invitation
    SELECT * INTO v_last_invitation
    FROM public.connection_invitations
    WHERE sender_id = p_sender_id
    AND recipient_id = p_recipient_id
    AND status = 'pending';

    IF v_last_invitation IS NOT NULL THEN
        RETURN QUERY SELECT
            FALSE,
            'Request already pending'::VARCHAR(100),
            NULL::TIMESTAMPTZ,
            v_history.total_attempts,
            v_history.declined_count;
        RETURN;
    END IF;

    -- Allow the request
    RETURN QUERY SELECT
        TRUE,
        'Can send request'::VARCHAR(100),
        NULL::TIMESTAMPTZ,
        COALESCE(v_history.total_attempts, 0),
        COALESCE(v_history.declined_count, 0);
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to update request history when a new request is sent
CREATE OR REPLACE FUNCTION public.record_connection_request(
    p_sender_id UUID,
    p_recipient_id UUID
) RETURNS VOID AS $$
BEGIN
    INSERT INTO public.connection_request_history (
        sender_id,
        recipient_id,
        total_attempts,
        last_attempt_at
    ) VALUES (
        p_sender_id,
        p_recipient_id,
        1,
        CURRENT_TIMESTAMP
    )
    ON CONFLICT (sender_id, recipient_id) DO UPDATE SET
        total_attempts = connection_request_history.total_attempts + 1,
        last_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Function to record when a request is declined
CREATE OR REPLACE FUNCTION public.record_connection_decline(
    p_sender_id UUID,
    p_recipient_id UUID,
    p_decline_type VARCHAR(20) DEFAULT 'standard',
    p_soft_block_duration_days INTEGER DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_soft_block_expires TIMESTAMPTZ;
BEGIN
    -- Calculate soft block expiration if applicable
    IF p_decline_type = 'soft_block' AND p_soft_block_duration_days IS NOT NULL THEN
        v_soft_block_expires := CURRENT_TIMESTAMP + INTERVAL '1 day' * p_soft_block_duration_days;
    END IF;

    -- Update history
    INSERT INTO public.connection_request_history (
        sender_id,
        recipient_id,
        declined_count,
        last_declined_at,
        is_soft_blocked,
        soft_blocked_at,
        soft_block_expires_at
    ) VALUES (
        p_sender_id,
        p_recipient_id,
        1,
        CURRENT_TIMESTAMP,
        p_decline_type = 'soft_block',
        CASE WHEN p_decline_type = 'soft_block' THEN CURRENT_TIMESTAMP ELSE NULL END,
        v_soft_block_expires
    )
    ON CONFLICT (sender_id, recipient_id) DO UPDATE SET
        declined_count = connection_request_history.declined_count + 1,
        last_declined_at = CURRENT_TIMESTAMP,
        is_soft_blocked = p_decline_type = 'soft_block' OR connection_request_history.is_soft_blocked,
        soft_blocked_at = CASE
            WHEN p_decline_type = 'soft_block' THEN CURRENT_TIMESTAMP
            ELSE connection_request_history.soft_blocked_at
        END,
        soft_block_expires_at = CASE
            WHEN p_decline_type = 'soft_block' THEN v_soft_block_expires
            ELSE connection_request_history.soft_block_expires_at
        END,
        updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to record connection requests
CREATE OR REPLACE FUNCTION public.trigger_record_connection_request()
RETURNS TRIGGER AS $$
BEGIN
    -- Only record for new pending requests
    IF NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status != 'pending') THEN
        PERFORM public.record_connection_request(NEW.sender_id, NEW.recipient_id);
    END IF;

    -- Record declines
    IF NEW.status = 'declined' AND (TG_OP = 'UPDATE' AND OLD.status = 'pending') THEN
        PERFORM public.record_connection_decline(
            NEW.sender_id,
            NEW.recipient_id,
            COALESCE(NEW.decline_type, 'standard')
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on connection_invitations
DROP TRIGGER IF EXISTS trigger_connection_request_history ON public.connection_invitations;
CREATE TRIGGER trigger_connection_request_history
    AFTER INSERT OR UPDATE ON public.connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_record_connection_request();

-- Add privacy setting for connection request notifications
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'notify_on_request_declined', false,
    'show_declined_requests', false,
    'max_connection_attempts', 3
)
WHERE NOT (privacy_settings ? 'notify_on_request_declined');

-- Create a view for user-visible request history
CREATE OR REPLACE VIEW public.user_connection_requests AS
SELECT
    ci.id,
    ci.sender_id,
    ci.recipient_id,
    ci.status,
    ci.message,
    ci.created_at,
    ci.responded_at,
    ci.decline_type,
    ci.decline_message,
    crh.total_attempts,
    crh.declined_count,
    crh.is_soft_blocked,
    CASE
        WHEN ci.status = 'declined' AND us.privacy_settings->>'show_declined_requests' = 'true'
        THEN TRUE
        ELSE FALSE
    END as show_declined_status,
    CASE
        WHEN crh.last_declined_at IS NOT NULL
        THEN crh.last_declined_at + INTERVAL '30 days'
        ELSE NULL
    END as can_retry_after
FROM public.connection_invitations ci
LEFT JOIN public.connection_request_history crh
    ON ci.sender_id = crh.sender_id AND ci.recipient_id = crh.recipient_id
LEFT JOIN public.user_settings us
    ON us.user_id = ci.recipient_id
WHERE ci.status IN ('pending', 'declined', 'cancelled');

-- Add comment explaining the new features
COMMENT ON TABLE public.connection_request_history IS
'Tracks the history of connection requests between users to prevent harassment and implement rate limiting.
Includes soft blocking (temporary decline of future requests) and attempt tracking.';

COMMENT ON FUNCTION public.can_send_connection_request IS
'Checks if a user can send a connection request based on history, blocks, and rate limits.
Returns detailed information about why a request might be blocked and when it can be retried.';

-- Log the migration
DO $$
BEGIN
    RAISE NOTICE 'Connection request tracking and rate limiting has been implemented';
    RAISE NOTICE 'Features added:';
    RAISE NOTICE '  - Connection attempt tracking (max 3 attempts)';
    RAISE NOTICE '  - Cooldown period after rejection (30 days)';
    RAISE NOTICE '  - Soft blocking option (temporary decline)';
    RAISE NOTICE '  - Request history visibility controls';
    RAISE NOTICE '  - Automated rate limiting checks';
END $$;

COMMIT;