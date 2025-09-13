-- ROLLBACK SCRIPT: Removes connection system migrations (040-043)
-- Description: Safely removes all connection-related tables and functions
-- Run this script to rollback migrations 040-043

-- Drop triggers first
DROP TRIGGER IF EXISTS process_group_invitation_acceptance ON public.group_invitations;
DROP TRIGGER IF EXISTS enforce_connection_before_group_invite ON public.group_invitations;
DROP TRIGGER IF EXISTS set_group_invitation_code ON public.group_invitations;
DROP TRIGGER IF EXISTS sync_log_trigger_group_invitations ON public.group_invitations;

DROP TRIGGER IF EXISTS set_privacy_settings_defaults ON public.user_privacy_settings;
DROP TRIGGER IF EXISTS update_user_privacy_settings_updated_at ON public.user_privacy_settings;
DROP TRIGGER IF EXISTS sync_log_trigger_user_privacy_settings ON public.user_privacy_settings;

DROP TRIGGER IF EXISTS set_connection_invitation_code ON public.connection_invitations;
DROP TRIGGER IF EXISTS sync_log_trigger_connection_invitations ON public.connection_invitations;

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
DROP TRIGGER IF EXISTS sync_log_trigger_connections ON public.connections;

-- Drop functions
DROP FUNCTION IF EXISTS public.check_connection_before_group_invite();
DROP FUNCTION IF EXISTS public.accept_group_invitation();
DROP FUNCTION IF EXISTS public.set_user_connection_code();
DROP FUNCTION IF EXISTS public.generate_connection_code();
DROP FUNCTION IF EXISTS public.set_invitation_code();
DROP FUNCTION IF EXISTS public.generate_invitation_code();

-- Drop tables (in reverse order of dependencies)
DROP TABLE IF EXISTS public.group_invitations;
DROP TABLE IF EXISTS public.user_privacy_settings;
DROP TABLE IF EXISTS public.connection_invitations;
DROP TABLE IF EXISTS public.connections;

-- Verification query to ensure clean removal
DO $$
BEGIN
    RAISE NOTICE 'Connection system tables and functions have been removed.';
    RAISE NOTICE 'Run the following query to verify:';
    RAISE NOTICE 'SELECT tablename FROM pg_tables WHERE schemaname = ''public'' AND tablename IN (''connections'', ''connection_invitations'', ''user_privacy_settings'', ''group_invitations'');';
END $$;