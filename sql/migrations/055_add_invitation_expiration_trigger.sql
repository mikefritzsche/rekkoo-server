-- Migration: Add automatic expiration trigger for invitations
-- Purpose: Automatically expire invitations after 30 days and send notifications

-- Create function to expire old invitations
CREATE OR REPLACE FUNCTION expire_old_invitations()
RETURNS void AS $$
BEGIN
    -- Expire group invitations older than 30 days
    UPDATE group_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;

    -- Expire list invitations older than 30 days
    UPDATE list_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;

    -- Expire connection invitations older than 30 days
    UPDATE connection_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Create function to send reminder notifications for expiring invitations
CREATE OR REPLACE FUNCTION send_invitation_reminders()
RETURNS TABLE (
    invitation_type TEXT,
    invitation_id UUID,
    inviter_id UUID,
    invitee_id UUID,
    days_until_expiry INTEGER,
    reminder_type TEXT
) AS $$
BEGIN
    -- 25-day reminders for group invitations
    RETURN QUERY
    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        gi.inviter_id,
        gi.invitee_id,
        EXTRACT(DAY FROM (gi.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        '25_day'::TEXT as reminder_type
    FROM group_invitations gi
    WHERE gi.status = 'pending'
    AND gi.reminder_sent_at IS NULL
    AND gi.expires_at > CURRENT_TIMESTAMP
    AND gi.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days')
    AND gi.expires_at >= (CURRENT_TIMESTAMP + INTERVAL '4 days');

    -- 28-day warnings for group invitations
    RETURN QUERY
    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        gi.inviter_id,
        gi.invitee_id,
        EXTRACT(DAY FROM (gi.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        '28_day'::TEXT as reminder_type
    FROM group_invitations gi
    WHERE gi.status = 'pending'
    AND gi.expiration_notified_at IS NULL
    AND gi.expires_at > CURRENT_TIMESTAMP
    AND gi.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days')
    AND gi.expires_at >= (CURRENT_TIMESTAMP + INTERVAL '1 day');

    -- Similar for list invitations
    RETURN QUERY
    SELECT
        'list'::TEXT as invitation_type,
        li.id as invitation_id,
        li.inviter_id,
        li.invitee_id,
        EXTRACT(DAY FROM (li.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        CASE
            WHEN li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days') THEN '25_day'::TEXT
            WHEN li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days') THEN '28_day'::TEXT
        END as reminder_type
    FROM list_invitations li
    WHERE li.status = 'pending'
    AND li.expires_at > CURRENT_TIMESTAMP
    AND li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days');

    -- Similar for connection invitations
    RETURN QUERY
    SELECT
        'connection'::TEXT as invitation_type,
        ci.id as invitation_id,
        ci.sender_id as inviter_id,
        ci.recipient_id as invitee_id,
        EXTRACT(DAY FROM (ci.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        CASE
            WHEN ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days') THEN '25_day'::TEXT
            WHEN ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days') THEN '28_day'::TEXT
        END as reminder_type
    FROM connection_invitations ci
    WHERE ci.status = 'pending'
    AND ci.expires_at > CURRENT_TIMESTAMP
    AND ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days');
END;
$$ LANGUAGE plpgsql;

-- Function to mark reminders as sent
CREATE OR REPLACE FUNCTION mark_reminder_sent(
    p_invitation_type TEXT,
    p_invitation_id UUID,
    p_reminder_type TEXT
)
RETURNS void AS $$
BEGIN
    IF p_invitation_type = 'group' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE group_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE group_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    ELSIF p_invitation_type = 'list' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE list_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE list_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    ELSIF p_invitation_type = 'connection' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE connection_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE connection_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Create a table to track cron jobs (if using pg_cron extension)
CREATE TABLE IF NOT EXISTS invitation_cron_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(50) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    records_processed INTEGER DEFAULT 0,
    errors TEXT,
    status VARCHAR(20) DEFAULT 'running'
);

-- Function to run the expiration job (can be called by pg_cron or external scheduler)
CREATE OR REPLACE FUNCTION run_invitation_expiration_job()
RETURNS TABLE (
    expired_count INTEGER,
    reminders_to_send INTEGER
) AS $$
DECLARE
    v_expired_count INTEGER;
    v_reminders_count INTEGER;
    v_job_id UUID;
BEGIN
    -- Log job start
    INSERT INTO invitation_cron_log (job_type, status)
    VALUES ('invitation_expiration', 'running')
    RETURNING id INTO v_job_id;

    -- Expire old invitations
    PERFORM expire_old_invitations();

    -- Count expired invitations
    SELECT COUNT(*) INTO v_expired_count
    FROM (
        SELECT id FROM group_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
        UNION ALL
        SELECT id FROM list_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
        UNION ALL
        SELECT id FROM connection_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
    ) AS expired;

    -- Count reminders to send
    SELECT COUNT(*) INTO v_reminders_count
    FROM send_invitation_reminders();

    -- Log job completion
    UPDATE invitation_cron_log
    SET completed_at = CURRENT_TIMESTAMP,
        records_processed = v_expired_count + v_reminders_count,
        status = 'completed'
    WHERE id = v_job_id;

    RETURN QUERY SELECT v_expired_count, v_reminders_count;
END;
$$ LANGUAGE plpgsql;

-- Add missing columns if they don't exist
DO $$
BEGIN
    -- Add reminder columns to list_invitations if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'list_invitations'
                   AND column_name = 'reminder_sent_at') THEN
        ALTER TABLE list_invitations ADD COLUMN reminder_sent_at TIMESTAMP WITH TIME ZONE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'list_invitations'
                   AND column_name = 'expiration_notified_at') THEN
        ALTER TABLE list_invitations ADD COLUMN expiration_notified_at TIMESTAMP WITH TIME ZONE;
    END IF;

    -- Add reminder columns to connection_invitations if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'connection_invitations'
                   AND column_name = 'reminder_sent_at') THEN
        ALTER TABLE connection_invitations ADD COLUMN reminder_sent_at TIMESTAMP WITH TIME ZONE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'connection_invitations'
                   AND column_name = 'expiration_notified_at') THEN
        ALTER TABLE connection_invitations ADD COLUMN expiration_notified_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- Create indexes for efficient expiration queries
CREATE INDEX IF NOT EXISTS idx_group_invitations_expiration
ON group_invitations(status, expires_at)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_list_invitations_expiration
ON list_invitations(status, expires_at)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_connection_invitations_expiration
ON connection_invitations(status, expires_at)
WHERE status = 'pending';

-- Comments for documentation
COMMENT ON FUNCTION expire_old_invitations() IS 'Automatically expires all pending invitations that have passed their expiration date';
COMMENT ON FUNCTION send_invitation_reminders() IS 'Returns list of invitations that need reminder notifications (25-day and 28-day warnings)';
COMMENT ON FUNCTION run_invitation_expiration_job() IS 'Main job function to expire invitations and generate reminder notifications';
COMMENT ON TABLE invitation_cron_log IS 'Tracks execution history of invitation expiration cron jobs';

-- Note: To schedule this as a cron job, you can either:
-- 1. Use pg_cron extension (if available):
--    SELECT cron.schedule('expire-invitations', '0 0 * * *', 'SELECT run_invitation_expiration_job();');
-- 2. Use an external scheduler to call: SELECT run_invitation_expiration_job();
-- 3. Create a backend service that calls this function periodically