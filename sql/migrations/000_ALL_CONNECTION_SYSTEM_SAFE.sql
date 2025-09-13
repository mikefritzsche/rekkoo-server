-- COMPLETE CONNECTION SYSTEM MIGRATION - SAFE VERSION
-- This file combines all connection system migrations in the correct order
-- Safe to run multiple times - uses IF NOT EXISTS throughout

-- ================================================================
-- PART 1: PREREQUISITES
-- ================================================================

-- Check and enable UUID support
DO $$
DECLARE
    uuid_support_exists BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v4'
    ) INTO uuid_support_exists;

    IF NOT uuid_support_exists THEN
        RAISE NOTICE 'Setting up UUID support...';
        BEGIN
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        EXCEPTION WHEN OTHERS THEN
            CREATE EXTENSION IF NOT EXISTS pgcrypto;
        END;
    END IF;
END $$;

-- Ensure core functions exist
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.log_table_changes()
RETURNS TRIGGER AS $$
DECLARE
    affected_user_id UUID;
    change_op VARCHAR(20);
    record_id_text TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        change_op = 'delete';
    ELSIF TG_OP = 'INSERT' THEN
        change_op = 'create';
    ELSE
        change_op = 'update';
    END IF;

    IF TG_TABLE_NAME IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations') THEN
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

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ================================================================
-- PART 2: CONNECTIONS TABLE
-- ================================================================

CREATE TABLE IF NOT EXISTS public.connections (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    initiated_by UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_user_id') THEN
        ALTER TABLE public.connections ADD CONSTRAINT fk_connections_user_id
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_connection_id') THEN
        ALTER TABLE public.connections ADD CONSTRAINT fk_connections_connection_id
            FOREIGN KEY (connection_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_initiated_by') THEN
        ALTER TABLE public.connections ADD CONSTRAINT fk_connections_initiated_by
            FOREIGN KEY (initiated_by) REFERENCES public.users(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_connection') THEN
        ALTER TABLE public.connections ADD CONSTRAINT unique_connection
            UNIQUE (user_id, connection_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_self_connection') THEN
        ALTER TABLE public.connections ADD CONSTRAINT no_self_connection
            CHECK (user_id != connection_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_status') THEN
        ALTER TABLE public.connections ADD CONSTRAINT valid_status
            CHECK (status IN ('pending', 'accepted', 'blocked', 'removed'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON public.connections (user_id);
CREATE INDEX IF NOT EXISTS idx_connections_connection_id ON public.connections (connection_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON public.connections (status);

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
    BEFORE UPDATE ON public.connections
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS sync_log_trigger_connections ON public.connections;
CREATE TRIGGER sync_log_trigger_connections
    AFTER INSERT OR UPDATE OR DELETE ON public.connections
    FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

-- ================================================================
-- PART 3: CONNECTION INVITATIONS TABLE
-- ================================================================

CREATE TABLE IF NOT EXISTS public.connection_invitations (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_email VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invitation_code VARCHAR(100) UNIQUE NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    reminder_sent_at TIMESTAMPTZ,
    expiration_notified_at TIMESTAMPTZ
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_check') THEN
        ALTER TABLE public.connection_invitations ADD CONSTRAINT recipient_check CHECK (
            (recipient_id IS NOT NULL AND recipient_email IS NULL) OR
            (recipient_id IS NULL AND recipient_email IS NOT NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_invitation_status_check') THEN
        ALTER TABLE public.connection_invitations ADD CONSTRAINT connection_invitation_status_check
            CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.generate_invitation_code()
RETURNS VARCHAR(100) AS $$
DECLARE
    code VARCHAR(100);
    code_exists BOOLEAN;
BEGIN
    LOOP
        code := 'INV-' || UPPER(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT)::TEXT);
        code := SUBSTRING(code, 1, 12);
        SELECT EXISTS(
            SELECT 1 FROM public.connection_invitations WHERE invitation_code = code
        ) INTO code_exists;
        EXIT WHEN NOT code_exists;
    END LOOP;
    RETURN code;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.set_invitation_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invitation_code IS NULL THEN
        NEW.invitation_code := public.generate_invitation_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_connection_invitation_code ON public.connection_invitations;
CREATE TRIGGER set_connection_invitation_code
    BEFORE INSERT ON public.connection_invitations
    FOR EACH ROW EXECUTE FUNCTION public.set_invitation_code();

-- ================================================================
-- PART 4: USER PRIVACY SETTINGS TABLE
-- ================================================================

CREATE TABLE IF NOT EXISTS public.user_privacy_settings (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    privacy_mode VARCHAR(20) NOT NULL DEFAULT 'standard',
    show_email_to_connections BOOLEAN DEFAULT FALSE,
    allow_connection_requests BOOLEAN DEFAULT TRUE,
    allow_group_invites_from_connections BOOLEAN DEFAULT TRUE,
    searchable_by_username BOOLEAN DEFAULT TRUE,
    searchable_by_email BOOLEAN DEFAULT FALSE,
    searchable_by_name BOOLEAN DEFAULT FALSE,
    show_mutual_connections BOOLEAN DEFAULT TRUE,
    connection_code VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_mode_check') THEN
        ALTER TABLE public.user_privacy_settings ADD CONSTRAINT privacy_mode_check
            CHECK (privacy_mode IN ('private', 'standard', 'public'));
    END IF;
END $$;

INSERT INTO public.user_privacy_settings (user_id)
SELECT id FROM public.users
WHERE id NOT IN (SELECT user_id FROM public.user_privacy_settings)
ON CONFLICT (user_id) DO NOTHING;

-- ================================================================
-- PART 5: GROUP INVITATIONS TABLE
-- ================================================================

CREATE TABLE IF NOT EXISTS public.group_invitations (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invitation_code VARCHAR(100) UNIQUE NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days')
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_owner_invitation') THEN
        ALTER TABLE public.group_invitations ADD CONSTRAINT no_owner_invitation
            CHECK (invitee_id != inviter_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_invitation_status_check') THEN
        ALTER TABLE public.group_invitations ADD CONSTRAINT group_invitation_status_check
            CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.check_connection_before_group_invite()
RETURNS TRIGGER AS $$
DECLARE
    are_connected BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE ((user_id = NEW.inviter_id AND connection_id = NEW.invitee_id)
            OR (user_id = NEW.invitee_id AND connection_id = NEW.inviter_id))
        AND status = 'accepted'
    ) INTO are_connected;
    IF NOT are_connected THEN
        RAISE EXCEPTION 'Cannot invite user to group: users must be connected first';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_connection_before_group_invite ON public.group_invitations;
CREATE TRIGGER enforce_connection_before_group_invite
    BEFORE INSERT ON public.group_invitations
    FOR EACH ROW EXECUTE FUNCTION public.check_connection_before_group_invite();

-- ================================================================
-- FINAL VERIFICATION
-- ================================================================

DO $$
DECLARE
    tables_created INTEGER;
BEGIN
    SELECT COUNT(*) INTO tables_created
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations');

    RAISE NOTICE '';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Connection System Migration Complete';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Tables created: % of 4', tables_created;

    IF tables_created = 4 THEN
        RAISE NOTICE 'Status: ✓ All tables successfully created';
    ELSE
        RAISE WARNING 'Status: Some tables may be missing';
    END IF;
    RAISE NOTICE '========================================';
END $$;