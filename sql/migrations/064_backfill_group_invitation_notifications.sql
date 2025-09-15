-- Backfill notifications for existing pending group invitations
-- This ensures users who already have pending invitations will see them

-- First check if reference_id column exists, if not add it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifications'
        AND column_name = 'reference_id'
    ) THEN
        ALTER TABLE notifications ADD COLUMN reference_id UUID;
        RAISE NOTICE 'Added reference_id column to notifications table';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifications'
        AND column_name = 'reference_type'
    ) THEN
        ALTER TABLE notifications ADD COLUMN reference_type VARCHAR(50);
        RAISE NOTICE 'Added reference_type column to notifications table';
    END IF;
END $$;

-- Now create notifications for all existing pending group invitations that don't have notifications yet
-- Using 'body' column (the actual column name in notifications table)
INSERT INTO notifications (
    user_id,
    notification_type,
    title,
    body,
    reference_id,
    reference_type,
    is_read,
    created_at
)
SELECT
    gi.invitee_id as user_id,
    'group_invitation' as notification_type,
    'Group Invitation' as title,
    CONCAT(
        COALESCE(u.username, 'Someone'),
        ' invited you to join the group "',
        COALESCE(g.name, 'Unknown Group'),
        '"'
    ) as body,
    gi.id as reference_id,
    'group_invitation' as reference_type,
    FALSE as is_read,
    gi.created_at as created_at
FROM group_invitations gi
JOIN collaboration_groups g ON g.id = gi.group_id
JOIN users u ON u.id = gi.inviter_id
LEFT JOIN notifications n ON n.reference_id = gi.id
    AND n.reference_type = 'group_invitation'
    AND n.user_id = gi.invitee_id
WHERE gi.status = 'pending'
    AND gi.expires_at > CURRENT_TIMESTAMP
    AND n.id IS NULL  -- Only create notifications that don't exist yet
ON CONFLICT DO NOTHING;  -- Avoid duplicate key errors

-- Add comment to track this migration
COMMENT ON TABLE notifications IS 'Stores all user notifications including group invitations. Backfilled in migration 064 for existing invitations.';