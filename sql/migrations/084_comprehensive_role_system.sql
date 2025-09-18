-- Migration 084: Comprehensive Role System with List-Type Awareness
-- This migration creates a flexible, granular permission system for different list types

-- Create list_type enum if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'list_type_enum') THEN
        CREATE TYPE list_type_enum AS ENUM (
            'standard',
            'gift',
            'shopping',
            'grocery',
            'task',
            'project',
            'wishlist',
            'registry',
            'checklist',
            'inventory'
        );
    END IF;
END $$;

-- Create comprehensive role enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'list_role_enum') THEN
        CREATE TYPE list_role_enum AS ENUM (
            'owner',
            'co-owner',
            'admin',
            'moderator',
            'editor',
            'contributor',
            'commenter',
            'viewer',
            'blocked',
            'reserver',
            'purchaser',
            'secret_santa',
            'gift_viewer',
            'shopper',
            'planner',
            'budget_manager',
            'assignee',
            'task_manager',
            'reviewer',
            'time_tracker',
            'stakeholder',
            'team_member',
            'project_lead'
        );
    END IF;
END $$;

-- Create table for list-type specific role mappings
CREATE TABLE IF NOT EXISTS list_type_roles (
    id SERIAL PRIMARY KEY,
    list_type list_type_enum NOT NULL,
    role list_role_enum NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 100,
    is_available BOOLEAN DEFAULT true,
    permissions JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(list_type, role)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_list_type_roles_type ON list_type_roles(list_type);
CREATE INDEX IF NOT EXISTS idx_list_type_roles_available ON list_type_roles(is_available);

-- Create table for custom permissions per list
CREATE TABLE IF NOT EXISTS list_custom_permissions (
    id SERIAL PRIMARY KEY,
    list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    custom_permissions JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(list_id, role)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_list_custom_permissions_list ON list_custom_permissions(list_id);

-- Create permissions definition table
CREATE TABLE IF NOT EXISTS permission_definitions (
    id SERIAL PRIMARY KEY,
    permission_key VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert core permissions
INSERT INTO permission_definitions (permission_key, display_name, description, category) VALUES
('list.delete', 'Delete List', 'Permanently delete the entire list', 'list_management'),
('list.archive', 'Archive List', 'Archive or unarchive the list', 'list_management'),
('list.settings.edit', 'Edit List Settings', 'Change list name, description, and basic settings', 'list_management'),
('list.privacy.edit', 'Edit Privacy Settings', 'Change list visibility and sharing settings', 'list_management'),
('list.export', 'Export List', 'Export list data', 'list_management'),
('members.invite', 'Invite Members', 'Invite new members to the list', 'member_management'),
('members.remove', 'Remove Members', 'Remove members from the list', 'member_management'),
('members.roles.edit', 'Change Member Roles', 'Modify roles and permissions of other members', 'member_management'),
('items.add', 'Add Items', 'Add new items to the list', 'item_operations'),
('items.edit.all', 'Edit All Items', 'Edit any item in the list', 'item_operations'),
('items.edit.own', 'Edit Own Items', 'Edit only items you created', 'item_operations'),
('items.delete', 'Delete Items', 'Remove items from the list', 'item_operations'),
('items.reorder', 'Reorder Items', 'Change the order of items', 'item_operations'),
('items.reserve', 'Reserve Items', 'Reserve items for purchase (gift lists)', 'gift_operations'),
('items.purchase', 'Mark as Purchased', 'Mark items as purchased (gift lists)', 'gift_operations'),
('items.hide_from_owner', 'Hide from Owner', 'Hide reservation/purchase status from list owner', 'gift_operations'),
('items.check_off', 'Check Off Items', 'Mark items as completed/purchased', 'shopping_operations'),
('items.set_price', 'Set Prices', 'Add or edit item prices', 'shopping_operations'),
('list.budget.view', 'View Budget', 'View budget and spending information', 'shopping_operations'),
('list.budget.edit', 'Edit Budget', 'Set and modify budget limits', 'shopping_operations'),
('tasks.assign', 'Assign Tasks', 'Assign tasks to members', 'task_operations'),
('tasks.complete', 'Complete Tasks', 'Mark tasks as complete', 'task_operations'),
('tasks.approve', 'Approve Completion', 'Approve or reject task completion', 'task_operations'),
('tasks.log_time', 'Log Time', 'Track time spent on tasks', 'task_operations'),
('comments.add', 'Add Comments', 'Post comments on list and items', 'collaboration'),
('comments.edit.own', 'Edit Own Comments', 'Edit your own comments', 'collaboration'),
('comments.delete.all', 'Delete Any Comment', 'Delete any comment', 'collaboration'),
('activity.view', 'View Activity', 'See list activity and history', 'collaboration')
ON CONFLICT (permission_key) DO NOTHING;

-- Populate list_type_roles with default mappings
-- Standard list roles
INSERT INTO list_type_roles (list_type, role, display_name, description, display_order, permissions) VALUES
('standard', 'owner', 'Owner', 'Full control of the list', 1, '["list.*", "members.*", "items.*", "comments.*", "activity.*"]'::jsonb),
('standard', 'admin', 'Admin', 'Can manage list settings and members', 2, '["list.archive", "list.settings.edit", "list.export", "members.*", "items.*", "comments.*", "activity.view"]'::jsonb),
('standard', 'editor', 'Editor', 'Can add, edit, and remove items', 3, '["items.*", "comments.add", "comments.edit.own", "activity.view"]'::jsonb),
('standard', 'contributor', 'Contributor', 'Can add items and edit own items', 4, '["items.add", "items.edit.own", "comments.add", "comments.edit.own", "activity.view"]'::jsonb),
('standard', 'commenter', 'Commenter', 'Can view and comment', 5, '["comments.add", "comments.edit.own", "activity.view"]'::jsonb),
('standard', 'viewer', 'Viewer', 'Read-only access', 6, '["activity.view"]'::jsonb),
('gift', 'owner', 'Owner', 'Full control of the gift list', 1, '["list.*", "members.*", "items.*", "comments.*", "activity.*"]'::jsonb),
('gift', 'admin', 'Admin', 'Can manage list and see all reservations', 2, '["list.archive", "list.settings.edit", "list.export", "members.*", "items.*", "comments.*", "activity.view"]'::jsonb),
('gift', 'editor', 'Editor', 'Can manage items', 3, '["items.add", "items.edit.all", "items.delete", "items.reorder", "comments.add", "activity.view"]'::jsonb),
('gift', 'reserver', 'Gift Giver', 'Can reserve and purchase items', 4, '["items.reserve", "items.purchase", "items.hide_from_owner", "comments.add", "activity.view"]'::jsonb),
('gift', 'gift_viewer', 'Gift Viewer', 'Can see items but not reservations', 5, '["activity.view"]'::jsonb),
('gift', 'secret_santa', 'Secret Santa', 'Special role for gift exchanges', 6, '["items.reserve", "items.hide_from_owner", "activity.view"]'::jsonb),
('shopping', 'owner', 'Owner', 'Full control of the shopping list', 1, '["list.*", "members.*", "items.*", "comments.*", "activity.*"]'::jsonb),
('shopping', 'planner', 'Planner', 'Can plan and organize the list', 2, '["items.*", "list.budget.edit", "items.set_price", "comments.add", "activity.view"]'::jsonb),
('shopping', 'shopper', 'Shopper', 'Can shop and check off items', 3, '["items.check_off", "items.add", "comments.add", "activity.view"]'::jsonb),
('shopping', 'budget_manager', 'Budget Manager', 'Can manage budget and prices', 4, '["list.budget.*", "items.set_price", "activity.view"]'::jsonb),
('grocery', 'owner', 'Owner', 'Full control of the grocery list', 1, '["list.*", "members.*", "items.*", "comments.*", "activity.*"]'::jsonb),
('grocery', 'planner', 'Meal Planner', 'Can plan meals and add items', 2, '["items.*", "comments.add", "activity.view"]'::jsonb),
('grocery', 'shopper', 'Shopper', 'Can shop and check off items', 3, '["items.check_off", "items.add", "comments.add", "activity.view"]'::jsonb),
('task', 'owner', 'Owner', 'Full control of the task list', 1, '["list.*", "members.*", "items.*", "tasks.*", "comments.*", "activity.*"]'::jsonb),
('task', 'task_manager', 'Task Manager', 'Can manage and assign tasks', 2, '["items.*", "tasks.assign", "tasks.approve", "comments.*", "activity.view"]'::jsonb),
('task', 'assignee', 'Assignee', 'Can be assigned and complete tasks', 3, '["items.edit.own", "tasks.complete", "tasks.log_time", "comments.add", "activity.view"]'::jsonb),
('task', 'reviewer', 'Reviewer', 'Can review and approve task completion', 4, '["tasks.approve", "comments.add", "activity.view"]'::jsonb),
('project', 'owner', 'Project Owner', 'Full control of the project', 1, '["list.*", "members.*", "items.*", "tasks.*", "comments.*", "activity.*"]'::jsonb),
('project', 'project_lead', 'Project Lead', 'Can manage project and team', 2, '["list.settings.edit", "members.*", "items.*", "tasks.*", "comments.*", "activity.view"]'::jsonb),
('project', 'team_member', 'Team Member', 'Can contribute to the project', 3, '["items.*", "tasks.complete", "tasks.log_time", "comments.add", "activity.view"]'::jsonb),
('project', 'stakeholder', 'Stakeholder', 'Can view progress and provide feedback', 4, '["comments.add", "activity.view"]'::jsonb)
ON CONFLICT (list_type, role) DO NOTHING;

-- Add function to get available roles for a list type
CREATE OR REPLACE FUNCTION get_available_roles_for_list_type(p_list_type VARCHAR)
RETURNS TABLE(
    role VARCHAR,
    display_name VARCHAR,
    description TEXT,
    display_order INTEGER,
    permissions JSONB
) AS $$
BEGIN
    IF p_list_type IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = p_list_type
        AND enumtypid = 'list_type_enum'::regtype
    ) THEN
        RETURN QUERY
        SELECT
            ltr.role::VARCHAR,
            ltr.display_name::VARCHAR,
            ltr.description,
            ltr.display_order,
            ltr.permissions
        FROM list_type_roles ltr
        WHERE ltr.list_type = p_list_type::list_type_enum
        AND ltr.is_available = true
        ORDER BY ltr.display_order;
    ELSE
        RETURN QUERY
        SELECT
            ltr.role::VARCHAR,
            ltr.display_name::VARCHAR,
            ltr.description,
            ltr.display_order,
            ltr.permissions
        FROM list_type_roles ltr
        WHERE ltr.list_type = 'standard'
        AND ltr.is_available = true
        ORDER BY ltr.display_order;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Add function to check if user has permission
CREATE OR REPLACE FUNCTION user_has_permission(
    p_user_id UUID,
    p_list_id UUID,
    p_permission VARCHAR
) RETURNS BOOLEAN AS $$
DECLARE
    v_role VARCHAR;
    v_permissions JSONB;
    v_custom_permissions JSONB;
BEGIN
    IF EXISTS (SELECT 1 FROM lists WHERE id = p_list_id AND owner_id = p_user_id) THEN
        RETURN TRUE;
    END IF;

    SELECT role INTO v_role
    FROM list_user_overrides
    WHERE list_id = p_list_id
    AND user_id = p_user_id
    AND deleted_at IS NULL;

    IF v_role IS NULL THEN
        SELECT lgr.role INTO v_role
        FROM list_sharing ls
        JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
        JOIN list_group_roles lgr ON lgr.list_id = ls.list_id AND lgr.group_id = ls.shared_with_group_id
        WHERE ls.list_id = p_list_id
        AND cgm.user_id = p_user_id
        AND ls.deleted_at IS NULL
        AND cgm.deleted_at IS NULL
        AND lgr.deleted_at IS NULL
        LIMIT 1;
    END IF;

    IF v_role IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT permissions INTO v_permissions
    FROM list_type_roles ltr
    JOIN lists l ON l.list_type = ltr.list_type::VARCHAR
    WHERE l.id = p_list_id
    AND ltr.role::VARCHAR = v_role;

    IF v_permissions ? p_permission OR
       v_permissions ? replace(split_part(p_permission, '.', 1) || '.*', '.*', '.*') THEN
        RETURN TRUE;
    END IF;

    SELECT custom_permissions INTO v_custom_permissions
    FROM list_custom_permissions
    WHERE list_id = p_list_id
    AND role = v_role;

    IF v_custom_permissions ? p_permission THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to update updated_at for list_custom_permissions
CREATE OR REPLACE FUNCTION update_list_custom_permissions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_list_custom_permissions_updated_at
    BEFORE UPDATE ON list_custom_permissions
    FOR EACH ROW
    EXECUTE FUNCTION update_list_custom_permissions_updated_at();

-- Add comment explaining the new system
COMMENT ON TABLE list_type_roles IS 'Defines available roles and their permissions for each list type';
COMMENT ON TABLE list_custom_permissions IS 'Allows per-list customization of role permissions';
COMMENT ON TABLE permission_definitions IS 'Master list of all available permissions in the system';

-- Create a view for easy permission checking
CREATE OR REPLACE VIEW user_list_permissions AS
SELECT
    l.id as list_id,
    l.list_type,
    COALESCE(luo.user_id, cgm.user_id) as user_id,
    CASE
        WHEN l.owner_id = COALESCE(luo.user_id, cgm.user_id) THEN 'owner'
        WHEN luo.role IS NOT NULL THEN luo.role
        ELSE lgr.role
    END as role,
    CASE
        WHEN l.owner_id = COALESCE(luo.user_id, cgm.user_id) THEN '["*"]'::jsonb
        ELSE COALESCE(ltr.permissions, '[]'::jsonb)
    END as permissions
FROM lists l
LEFT JOIN list_user_overrides luo ON luo.list_id = l.id AND luo.deleted_at IS NULL
LEFT JOIN list_sharing ls ON ls.list_id = l.id AND ls.deleted_at IS NULL
LEFT JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id AND cgm.deleted_at IS NULL
LEFT JOIN list_group_roles lgr ON lgr.list_id = l.id AND lgr.group_id = ls.shared_with_group_id AND lgr.deleted_at IS NULL
LEFT JOIN list_type_roles ltr ON ltr.list_type = l.list_type::list_type_enum
    AND ltr.role::VARCHAR = COALESCE(luo.role, lgr.role)
WHERE l.deleted_at IS NULL;