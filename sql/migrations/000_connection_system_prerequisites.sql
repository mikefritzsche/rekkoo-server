-- MIGRATION: 000_connection_system_prerequisites.sql
-- Description: Ensures all required functions exist before running connection system migrations
-- Run this BEFORE migrations 040-043

-- 1. Check and enable UUID support
DO $$
DECLARE
    uuid_support_exists BOOLEAN;
BEGIN
    -- Check if uuid_generate_v4 function already exists
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v4'
    ) INTO uuid_support_exists;

    IF NOT uuid_support_exists THEN
        RAISE NOTICE 'UUID function not found, attempting to create extension...';

        -- Try to create uuid-ossp extension
        BEGIN
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
            RAISE NOTICE 'uuid-ossp extension created successfully';
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Insufficient privileges to create uuid-ossp extension';
                -- Try pgcrypto as alternative
                BEGIN
                    CREATE EXTENSION IF NOT EXISTS pgcrypto;
                    RAISE NOTICE 'pgcrypto extension created as alternative';
                EXCEPTION
                    WHEN insufficient_privilege THEN
                        RAISE EXCEPTION 'Cannot create UUID extensions. Please ask your database administrator to run: CREATE EXTENSION "uuid-ossp";';
                END;
            WHEN OTHERS THEN
                RAISE NOTICE 'Could not create uuid-ossp, trying pgcrypto...';
                CREATE EXTENSION IF NOT EXISTS pgcrypto;
        END;
    ELSE
        RAISE NOTICE 'UUID support already exists';
    END IF;
END $$;

-- 1b. Create uuid_generate_v4 wrapper if needed (for pgcrypto compatibility)
DO $$
BEGIN
    -- Only create if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v4'
    ) THEN
        -- Check if we have pgcrypto's gen_random_uuid
        IF EXISTS (
            SELECT 1 FROM pg_proc
            WHERE proname = 'gen_random_uuid'
        ) THEN
            RAISE NOTICE 'Creating uuid_generate_v4 wrapper for pgcrypto';
            CREATE OR REPLACE FUNCTION public.uuid_generate_v4()
            RETURNS uuid AS 'SELECT gen_random_uuid()' LANGUAGE SQL;
        ELSE
            RAISE EXCEPTION 'No UUID generation function available. Please install uuid-ossp or pgcrypto extension.';
        END IF;
    END IF;
END $$;

-- 2. Ensure update_updated_at_column function exists
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Ensure log_table_changes function exists
-- This is a simplified version if it doesn't exist
-- The full version should handle different tables appropriately
CREATE OR REPLACE FUNCTION public.log_table_changes()
RETURNS TRIGGER AS $$
DECLARE
    affected_user_id UUID;
    change_op VARCHAR(20);
    record_id_text TEXT;
BEGIN
    -- Determine operation type
    IF TG_OP = 'DELETE' THEN
        change_op = 'delete';
    ELSIF TG_OP = 'INSERT' THEN
        change_op = 'create';
    ELSE
        change_op = 'update';
    END IF;

    -- For connections and connection-related tables
    IF TG_TABLE_NAME IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations') THEN
        -- Extract user_id based on table structure
        CASE TG_TABLE_NAME
            WHEN 'connections' THEN
                affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
                record_id_text = COALESCE(NEW.id::text, OLD.id::text);
            WHEN 'connection_invitations' THEN
                affected_user_id = COALESCE(NEW.sender_id, OLD.sender_id);
                record_id_text = COALESCE(NEW.id::text, OLD.id::text);
            WHEN 'user_privacy_settings' THEN
                affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
                record_id_text = COALESCE(NEW.user_id::text, OLD.user_id::text);
            WHEN 'group_invitations' THEN
                affected_user_id = COALESCE(NEW.inviter_id, OLD.inviter_id);
                record_id_text = COALESCE(NEW.id::text, OLD.id::text);
            ELSE
                affected_user_id = NULL;
                record_id_text = NULL;
        END CASE;

        -- Only log if we have a user_id and the change_log table exists
        IF affected_user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'change_log'
        ) THEN
            INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
            VALUES (
                affected_user_id,
                TG_TABLE_NAME,
                record_id_text,
                change_op,
                CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END
            );
        END IF;
    END IF;

    -- Return appropriate value
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- 4. Final verification
DO $$
DECLARE
    uuid_func_exists BOOLEAN;
    update_func_exists BOOLEAN;
    log_func_exists BOOLEAN;
BEGIN
    -- Check UUID function
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v4'
    ) INTO uuid_func_exists;

    -- Check update function
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) INTO update_func_exists;

    -- Check log function
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'log_table_changes'
    ) INTO log_func_exists;

    RAISE NOTICE '';
    RAISE NOTICE 'Prerequisites check:';

    IF uuid_func_exists THEN
        RAISE NOTICE '✓ UUID function (uuid_generate_v4) ready';
    ELSE
        RAISE EXCEPTION '✗ UUID function missing - cannot proceed';
    END IF;

    IF update_func_exists THEN
        RAISE NOTICE '✓ update_updated_at_column function ready';
    ELSE
        RAISE WARNING '✗ update_updated_at_column function missing';
    END IF;

    IF log_func_exists THEN
        RAISE NOTICE '✓ log_table_changes function ready';
    ELSE
        RAISE WARNING '✗ log_table_changes function missing';
    END IF;

    RAISE NOTICE '';
    RAISE NOTICE 'You can now run migrations 040-043.';
END $$;