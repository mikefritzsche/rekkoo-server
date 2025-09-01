-- SQL script to check user roles for debugging
-- Replace the IDs with your actual test values

-- Set variables
\set list_id '66184640-2290-4e78-9cdf-2c2c2343f195'
\set user_id '9f768190-b865-477d-9fd3-428b28e3ab7d'

-- Check if list exists and get owner
SELECT 'List Info:' as section;
SELECT id, title, owner_id, created_at 
FROM lists 
WHERE id = :'list_id';

-- Check direct user overrides
SELECT 'Direct User Overrides:' as section;
SELECT * 
FROM list_user_overrides 
WHERE list_id = :'list_id' 
  AND user_id = :'user_id' 
  AND deleted_at IS NULL;

-- Check group memberships for user
SELECT 'User Group Memberships:' as section;
SELECT 
    ls.list_id,
    ls.shared_with_group_id as group_id,
    cg.name as group_name,
    cgm.user_id,
    cgm.role as member_role
FROM list_sharing ls
JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
JOIN collaboration_groups cg ON cg.id = ls.shared_with_group_id
WHERE ls.list_id = :'list_id' 
  AND cgm.user_id = :'user_id'
  AND ls.deleted_at IS NULL
  AND cgm.deleted_at IS NULL;

-- Check group roles on the list
SELECT 'Group Roles on List:' as section;
SELECT 
    lgr.list_id,
    lgr.group_id,
    cg.name as group_name,
    lgr.role as group_role,
    lgr.permissions
FROM list_group_roles lgr
JOIN collaboration_groups cg ON cg.id = lgr.group_id
WHERE lgr.list_id = :'list_id'
  AND lgr.deleted_at IS NULL;

-- Check user-specific roles within groups on the list
SELECT 'User-Specific Group Roles:' as section;
SELECT 
    lgur.list_id,
    lgur.group_id,
    cg.name as group_name,
    lgur.user_id,
    lgur.role as user_role,
    lgur.permissions
FROM list_group_user_roles lgur
JOIN collaboration_groups cg ON cg.id = lgur.group_id
WHERE lgur.list_id = :'list_id'
  AND lgur.user_id = :'user_id'
  AND lgur.deleted_at IS NULL;

-- Effective role calculation (mimics the API logic)
SELECT 'Effective Role:' as section;
WITH role_hierarchy AS (
    SELECT 
        role,
        CASE role
            WHEN 'owner' THEN 0
            WHEN 'admin' THEN 1
            WHEN 'editor' THEN 2
            WHEN 'commenter' THEN 3
            WHEN 'reserver' THEN 4
            WHEN 'viewer' THEN 5
            ELSE 6
        END as priority
    FROM (
        -- Check if user is owner
        SELECT 'owner' as role
        FROM lists
        WHERE id = :'list_id' AND owner_id = :'user_id'
        
        UNION ALL
        
        -- Check direct user override
        SELECT role
        FROM list_user_overrides
        WHERE list_id = :'list_id' 
          AND user_id = :'user_id'
          AND deleted_at IS NULL
        
        UNION ALL
        
        -- Check user-specific group roles
        SELECT lgur.role
        FROM list_group_user_roles lgur
        JOIN list_sharing ls ON ls.list_id = lgur.list_id AND ls.shared_with_group_id = lgur.group_id
        JOIN collaboration_group_members cgm ON cgm.group_id = lgur.group_id
        WHERE lgur.list_id = :'list_id'
          AND lgur.user_id = :'user_id'
          AND lgur.deleted_at IS NULL
          AND ls.deleted_at IS NULL
          AND cgm.deleted_at IS NULL
        
        UNION ALL
        
        -- Check group roles
        SELECT COALESCE(lgr.role, 'viewer') as role
        FROM list_sharing ls
        JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
        LEFT JOIN list_group_roles lgr ON lgr.list_id = ls.list_id AND lgr.group_id = ls.shared_with_group_id AND lgr.deleted_at IS NULL
        WHERE ls.list_id = :'list_id'
          AND cgm.user_id = :'user_id'
          AND ls.deleted_at IS NULL
          AND cgm.deleted_at IS NULL
    ) all_roles
)
SELECT role as effective_role
FROM role_hierarchy
ORDER BY priority
LIMIT 1;