-- Migration 119: Add voting-focused roles and permissions for standard lists

COMMIT;

-- Extend the comprehensive role enum with new organizer role types
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'list_role_enum') THEN
        -- Add host role if missing
        BEGIN
            ALTER TYPE list_role_enum ADD VALUE 'host';
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;

        -- Add curator role if missing
        BEGIN
            ALTER TYPE list_role_enum ADD VALUE 'curator';
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;
    END IF;
END $$;

BEGIN;

-- Insert decision/voting specific permission definitions (idempotent)
INSERT INTO permission_definitions (permission_key, display_name, description, category) VALUES
    ('decisions.create', 'Create Decisions', 'Create polls or decision rounds for the group', 'collaboration'),
    ('decisions.close', 'Close Decisions', 'End a decision round and publish the result', 'collaboration'),
    ('votes.cast', 'Cast Votes', 'Vote on shared decisions', 'collaboration')
ON CONFLICT (permission_key) DO NOTHING;

DO $$
BEGIN
    IF to_regclass('public.list_type_roles') IS NULL THEN
        RAISE NOTICE 'Skipping list_type_roles updates; table not present in this schema.';
        RETURN;
    END IF;

    -- Update existing commenter label to Voter for standard lists
    UPDATE list_type_roles
    SET display_name = 'Voter',
        description = 'Can view, react, and cast votes'
    WHERE list_type = 'standard'
      AND role = 'commenter';

    -- Add curator role for standard lists (idempotent)
    INSERT INTO list_type_roles (
        list_type,
        role,
        display_name,
        description,
        display_order,
        permissions
    ) VALUES (
        'standard',
        'curator',
        'Curator',
        'Prepares options and moderates before voting',
        3,
        '[
            "items.add",
            "items.edit.all",
            "items.delete",
            "items.reorder",
            "decisions.create",
            "comments.add",
            "comments.edit.own",
            "activity.view"
        ]'::jsonb
    )
    ON CONFLICT (list_type, role) DO NOTHING;

    -- Add host role for standard lists (idempotent)
    INSERT INTO list_type_roles (
        list_type,
        role,
        display_name,
        description,
        display_order,
        permissions
    ) VALUES (
        'standard',
        'host',
        'Host',
        'Runs decision rounds, resolves ties, and manages outcomes',
        2,
        '[
            "list.settings.edit",
            "members.roles.edit",
            "members.invite",
            "decisions.create",
            "decisions.close",
            "votes.cast",
            "items.add",
            "items.edit.all",
            "items.delete",
            "comments.add",
            "activity.view"
        ]'::jsonb
    )
    ON CONFLICT (list_type, role) DO NOTHING;

    -- Ensure admin role gains decision creation permission
    UPDATE list_type_roles
    SET permissions = permissions || '["decisions.create","decisions.close"]'::jsonb
    WHERE list_type = 'standard'
      AND role = 'admin'
      AND NOT permissions ?| ARRAY['decisions.create', 'decisions.close'];

    -- Update role priority ordering to account for new roles
    UPDATE list_type_roles
    SET display_order = 1
    WHERE list_type = 'standard'
      AND role = 'co-owner';

    UPDATE list_type_roles
    SET display_order = 2
    WHERE list_type = 'standard'
      AND role = 'host';

    UPDATE list_type_roles
    SET display_order = 3
    WHERE list_type = 'standard'
      AND role = 'admin';

    UPDATE list_type_roles
    SET display_order = 4
    WHERE list_type = 'standard'
      AND role = 'curator';

    UPDATE list_type_roles
    SET display_order = 5
    WHERE list_type = 'standard'
      AND role = 'editor';

    UPDATE list_type_roles
    SET display_order = 6
    WHERE list_type = 'standard'
      AND role = 'contributor';

    UPDATE list_type_roles
    SET display_order = 7
    WHERE list_type = 'standard'
      AND role = 'commenter';

    UPDATE list_type_roles
    SET display_order = 8
    WHERE list_type = 'standard'
      AND role = 'viewer';
END $$;

-- Refresh role validation constraints to include new values where applicable
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'list_group_roles_role_check'
          AND table_name = 'list_group_roles'
    ) THEN
        ALTER TABLE list_group_roles DROP CONSTRAINT list_group_roles_role_check;
        ALTER TABLE list_group_roles
            ADD CONSTRAINT list_group_roles_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver'));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'list_group_user_roles_role_check'
          AND table_name = 'list_group_user_roles'
    ) THEN
        ALTER TABLE list_group_user_roles DROP CONSTRAINT list_group_user_roles_role_check;
        ALTER TABLE list_group_user_roles
            ADD CONSTRAINT list_group_user_roles_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver'));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'list_invitations_role_check'
          AND table_name = 'list_invitations'
    ) THEN
        ALTER TABLE list_invitations DROP CONSTRAINT list_invitations_role_check;
        ALTER TABLE list_invitations
            ADD CONSTRAINT list_invitations_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver'));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'list_shares_role_check'
          AND table_name = 'list_shares'
    ) THEN
        ALTER TABLE list_shares DROP CONSTRAINT list_shares_role_check;
        ALTER TABLE list_shares
            ADD CONSTRAINT list_shares_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver'));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'list_user_overrides_role_check'
          AND table_name = 'list_user_overrides'
    ) THEN
        ALTER TABLE list_user_overrides DROP CONSTRAINT list_user_overrides_role_check;
        ALTER TABLE list_user_overrides
            ADD CONSTRAINT list_user_overrides_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver','inherit'));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.constraint_table_usage
        WHERE constraint_name = 'pending_list_invitations_role_check'
          AND table_name = 'pending_list_invitations'
    ) THEN
        ALTER TABLE pending_list_invitations DROP CONSTRAINT pending_list_invitations_role_check;
        ALTER TABLE pending_list_invitations
            ADD CONSTRAINT pending_list_invitations_role_check
            CHECK (role IN ('viewer','commenter','contributor','editor','curator','admin','host','co-owner','reserver'));
    END IF;
END $$;

COMMIT;
