-- MIGRATION: 042_create_user_privacy_settings_table_safe.sql
-- Description: Creates the user_privacy_settings table (SAFE VERSION - can run multiple times)

-- Ensure the update_updated_at_column function exists
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the user_privacy_settings table (only if it doesn't exist)
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

-- Add CHECK constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_mode_check') THEN
        ALTER TABLE public.user_privacy_settings
            ADD CONSTRAINT privacy_mode_check
            CHECK (privacy_mode IN ('private', 'standard', 'public'));
    END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_privacy_settings_privacy_mode ON public.user_privacy_settings (privacy_mode);
CREATE INDEX IF NOT EXISTS idx_user_privacy_settings_searchable ON public.user_privacy_settings (searchable_by_username, searchable_by_email, searchable_by_name);

-- Drop and recreate unique index for connection_code
DROP INDEX IF EXISTS idx_user_privacy_settings_connection_code;
CREATE UNIQUE INDEX idx_user_privacy_settings_connection_code
    ON public.user_privacy_settings (connection_code)
    WHERE connection_code IS NOT NULL;

-- Function to generate unique connection code
CREATE OR REPLACE FUNCTION public.generate_connection_code()
RETURNS VARCHAR(20) AS $$
DECLARE
    code VARCHAR(20);
    code_exists BOOLEAN;
BEGIN
    LOOP
        -- Generate a random 4-digit code to append to username
        code := LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');

        -- Check if code already exists for this user
        SELECT EXISTS(
            SELECT 1 FROM public.user_privacy_settings
            WHERE connection_code = code
        ) INTO code_exists;

        EXIT WHEN NOT code_exists;
    END LOOP;

    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Trigger to set connection code for private mode users
CREATE OR REPLACE FUNCTION public.set_user_connection_code()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate connection code if user is in private mode and doesn't have one
    IF NEW.privacy_mode = 'private' AND NEW.connection_code IS NULL THEN
        NEW.connection_code := public.generate_connection_code();
    END IF;

    -- Update searchable settings based on privacy mode
    IF NEW.privacy_mode = 'private' THEN
        NEW.searchable_by_username := FALSE;
        NEW.searchable_by_email := FALSE;
        NEW.searchable_by_name := FALSE;
    ELSIF NEW.privacy_mode = 'public' THEN
        NEW.searchable_by_username := TRUE;
        NEW.searchable_by_name := TRUE;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate triggers
DROP TRIGGER IF EXISTS set_privacy_settings_defaults ON public.user_privacy_settings;
CREATE TRIGGER set_privacy_settings_defaults
    BEFORE INSERT OR UPDATE ON public.user_privacy_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_user_connection_code();

DROP TRIGGER IF EXISTS update_user_privacy_settings_updated_at ON public.user_privacy_settings;
CREATE TRIGGER update_user_privacy_settings_updated_at
    BEFORE UPDATE ON public.user_privacy_settings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS sync_log_trigger_user_privacy_settings ON public.user_privacy_settings;
CREATE TRIGGER sync_log_trigger_user_privacy_settings
    AFTER INSERT OR UPDATE OR DELETE ON public.user_privacy_settings
    FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

-- Insert default privacy settings for existing users (only for users who don't have settings yet)
INSERT INTO public.user_privacy_settings (user_id)
SELECT id FROM public.users
WHERE id NOT IN (SELECT user_id FROM public.user_privacy_settings)
ON CONFLICT (user_id) DO NOTHING;

-- Add comments
COMMENT ON TABLE public.user_privacy_settings IS 'User privacy preferences controlling visibility and connection settings';
COMMENT ON COLUMN public.user_privacy_settings.privacy_mode IS 'Privacy level: private (code only), standard (default), or public (discoverable)';
COMMENT ON COLUMN public.user_privacy_settings.connection_code IS 'Unique 4-digit code for private mode users (e.g., username#1234)';

-- Verify the table was created/exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_privacy_settings') THEN
        RAISE NOTICE 'Table public.user_privacy_settings is ready';
    ELSE
        RAISE EXCEPTION 'Failed to create table public.user_privacy_settings';
    END IF;
END $$;