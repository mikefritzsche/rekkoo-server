-- Simple queries to check group membership status
-- Run these queries directly in your database client

-- 1. Check if User B is in collaboration_group_members
-- Replace 'UserB_Username' with the actual username
SELECT
    cgm.group_id,
    cgm.user_id,
    cgm.role,
    cgm.joined_at,
    u.username,
    cg.name as group_name
FROM collaboration_group_members cgm
JOIN users u ON u.id = cgm.user_id
JOIN collaboration_groups cg ON cg.id = cgm.group_id
WHERE u.username = 'mf65';  -- REPLACE with actual username

-- 2. Check processed pending invitations
SELECT
    pgi.group_id,
    pgi.invitee_id,
    pgi.status,
    pgi.processed_at,
    u.username
FROM pending_group_invitations pgi
JOIN users u ON u.id = pgi.invitee_id
WHERE pgi.status = 'processed'
ORDER BY pgi.processed_at DESC
LIMIT 10;

-- 3. Check group invitations status
SELECT
    gi.group_id,
    gi.invitee_id,
    gi.status,
    gi.responded_at,
    u.username
FROM group_invitations gi
JOIN users u ON u.id = gi.invitee_id
WHERE gi.status = 'accepted'
ORDER BY gi.responded_at DESC
LIMIT 10;

-- 4. Count members per group
SELECT
    cg.id,
    cg.name,
    COUNT(cgm.user_id) as member_count
FROM collaboration_groups cg
LEFT JOIN collaboration_group_members cgm ON cgm.group_id = cg.id
GROUP BY cg.id, cg.name
ORDER BY cg.name;

-- 5. Find any mismatches (accepted invitations without membership)
SELECT
    gi.group_id,
    gi.invitee_id,
    gi.status as invitation_status,
    u.username,
    CASE
        WHEN cgm.user_id IS NULL THEN 'NOT A MEMBER'
        ELSE 'IS MEMBER'
    END as membership_status
FROM group_invitations gi
JOIN users u ON u.id = gi.invitee_id
LEFT JOIN collaboration_group_members cgm ON
    cgm.group_id = gi.group_id AND
    cgm.user_id = gi.invitee_id
WHERE gi.status = 'accepted'
AND cgm.user_id IS NULL;  -- Only show accepted invitations without membership