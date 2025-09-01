-- Test if user 9f768190-b865-477d-9fd3-428b28e3ab7d has access to list 66184640-2290-4e78-9cdf-2c2c2343f195
SELECT 
  'List Info:' as section,
  l.id, 
  l.title, 
  l.owner_id,
  l.is_public
FROM lists l
WHERE l.id = '66184640-2290-4e78-9cdf-2c2c2343f195'::uuid;

SELECT 
  'Groups with access to this list:' as section;
  
SELECT 
  lgr.group_id,
  ug.name as group_name,
  lgr.role,
  lgr.deleted_at
FROM list_group_roles lgr
JOIN user_groups ug ON lgr.group_id = ug.id
WHERE lgr.list_id = '66184640-2290-4e78-9cdf-2c2c2343f195'::uuid;

SELECT 
  'User memberships in groups:' as section;

SELECT 
  gm.group_id,
  ug.name as group_name,
  gm.user_id,
  u.username
FROM group_members gm
JOIN user_groups ug ON gm.group_id = ug.id
JOIN users u ON gm.user_id = u.id
WHERE gm.user_id = '9f768190-b865-477d-9fd3-428b28e3ab7d'::uuid
  AND gm.deleted_at IS NULL;

SELECT 
  'Does user have access via group?' as section;

SELECT COUNT(*) as has_access
FROM list_group_roles lgr
JOIN group_members gm ON lgr.group_id = gm.group_id
WHERE lgr.list_id = '66184640-2290-4e78-9cdf-2c2c2343f195'::uuid
  AND gm.user_id = '9f768190-b865-477d-9fd3-428b28e3ab7d'::uuid
  AND lgr.deleted_at IS NULL
  AND gm.deleted_at IS NULL;
