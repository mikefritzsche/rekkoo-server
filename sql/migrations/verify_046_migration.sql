-- Verification Script: Check migration 046 (role column in group_invitations)

-- 1. Check if role column exists
SELECT 'Role Column Check' as verification;
SELECT
    column_name,
    data_type,
    column_default,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
    AND table_name = 'group_invitations'
    AND column_name = 'role';

-- 2. Check the constraint
SELECT 'Role Constraint Check' as verification;
SELECT
    conname as constraint_name,
    pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'group_invitations'::regclass
    AND conname = 'valid_invitation_role';

-- 3. Check if index was created
SELECT 'Role Index Check' as verification;
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'group_invitations'
    AND indexname = 'idx_group_invitations_role';

-- 4. Sample data check - show any existing invitations with roles
SELECT 'Sample Invitations with Roles' as verification;
SELECT
    gi.id,
    gi.status,
    gi.role,
    g.name as group_name,
    u1.username as inviter,
    u2.username as invitee,
    gi.created_at
FROM group_invitations gi
JOIN collaboration_groups g ON gi.group_id = g.id
JOIN users u1 ON gi.inviter_id = u1.id
JOIN users u2 ON gi.invitee_id = u2.id
ORDER BY gi.created_at DESC
LIMIT 5;

-- 5. Final status
SELECT 'Migration Status' as verification;
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'group_invitations'
            AND column_name = 'role'
        )
        THEN '✅ Migration 046 successful - role column exists'
        ELSE '❌ Migration 046 failed - role column not found'
    END as status;