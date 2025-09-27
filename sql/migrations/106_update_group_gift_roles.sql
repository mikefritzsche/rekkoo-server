-- Migration: Update group roles for gift lists to include purchaser role
-- Description: Ensures group members can both reserve and purchase gifts
-- Date: 2025-09-26
BEGIN;

-- Update existing group roles for gift lists to include purchaser role
UPDATE list_group_roles
SET role = 'purchaser'
WHERE list_id IN (
  SELECT id FROM lists WHERE list_type = 'gifts'
)
AND role = 'reserver'
AND deleted_at IS NULL;

-- Also, ensure any future group roles for gift lists default to purchaser
-- This is handled by the application logic when creating new group roles

COMMIT;