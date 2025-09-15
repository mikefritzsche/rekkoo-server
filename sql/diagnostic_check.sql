-- Diagnostic script to check current database state
-- Run this to see what's actually in your database

-- Check what columns exist in collaboration_group_members
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'collaboration_group_members'
ORDER BY ordinal_position;

-- Check if group_members exists (as table or view)
SELECT
    table_name,
    table_type
FROM information_schema.tables
WHERE table_name = 'group_members';

-- Check existing groups and their owners
SELECT
    g.id,
    g.name,
    g.owner_id,
    CASE
        WHEN gm.user_id IS NOT NULL THEN 'YES'
        ELSE 'NO'
    END as owner_is_member
FROM collaboration_groups g
LEFT JOIN collaboration_group_members gm
    ON gm.group_id = g.id
    AND gm.user_id = g.owner_id
WHERE g.deleted_at IS NULL;