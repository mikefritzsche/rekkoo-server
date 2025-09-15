-- Migration 057: Comprehensive fix for group ownership and table naming issues
--
-- Problems being fixed:
-- 1. Group owners were not being added to collaboration_group_members table
-- 2. Some code expects 'group_members' table but actual table is 'collaboration_group_members'
--
-- Run this entire script to fix all group-related issues

-- ============================================
-- STEP 1: Create view for backward compatibility
-- ============================================
-- This allows code expecting 'group_members' to work
-- First drop any existing view or table with this name
DROP VIEW IF EXISTS group_members CASCADE;
DROP TABLE IF EXISTS group_members CASCADE;

-- Create simple view with only the columns that actually exist
CREATE VIEW group_members AS
SELECT
    group_id,
    user_id,
    role
FROM collaboration_group_members;

-- ============================================
-- STEP 2: Add all group owners as members
-- ============================================
-- This ensures every group owner is also a member with 'owner' role
INSERT INTO collaboration_group_members (group_id, user_id, role)
SELECT g.id, g.owner_id, 'owner'
FROM collaboration_groups g
WHERE NOT EXISTS (
    SELECT 1 FROM collaboration_group_members gm
    WHERE gm.group_id = g.id
    AND gm.user_id = g.owner_id
)
AND g.deleted_at IS NULL;

-- ============================================
-- STEP 3: Verify the fixes
-- ============================================
-- Show results
SELECT 'Groups fixed:' as status, COUNT(*) as count
FROM collaboration_groups g
WHERE EXISTS (
    SELECT 1 FROM collaboration_group_members gm
    WHERE gm.group_id = g.id
    AND gm.user_id = g.owner_id
)
AND g.deleted_at IS NULL;

-- Show any remaining issues (should be 0)
SELECT 'Groups still without owner as member:' as status, COUNT(*) as count
FROM collaboration_groups g
WHERE NOT EXISTS (
    SELECT 1 FROM collaboration_group_members gm
    WHERE gm.group_id = g.id
    AND gm.user_id = g.owner_id
)
AND g.deleted_at IS NULL;

-- ============================================
-- DONE! Your groups should now work properly
-- ============================================