-- Migration: Add Auto-Accept Connections Privacy Setting
-- This allows users to automatically accept all connection requests

BEGIN;

-- Update the privacy settings update trigger to handle auto-accept connections
CREATE OR REPLACE FUNCTION public.update_user_privacy_settings()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate connection code if user is in ghost or private mode and doesn't have one
    IF NEW.privacy_settings->>'privacy_mode' IN ('private', 'ghost')
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object('connection_code', public.generate_user_connection_code());
    END IF;

    -- Update searchable settings based on privacy mode
    IF NEW.privacy_settings->>'privacy_mode' = 'ghost' THEN
        -- Ghost users are never searchable
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false,
                'show_in_suggestions', false,
                'show_in_group_members', false,
                'anonymous_in_groups', true,
                'auto_accept_connections', false
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'private' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false,
                'show_in_suggestions', false
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'public' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'searchable_by_email', true,
                'searchable_by_name', true,
                'show_in_suggestions', true
            );
        -- Public mode users might want auto-accept enabled by default
        IF NOT (NEW.privacy_settings ? 'auto_accept_connections') THEN
            NEW.privacy_settings = NEW.privacy_settings ||
                jsonb_build_object('auto_accept_connections', false);
        END IF;
    END IF;

    -- Set updated_at
    NEW.updated_at = CURRENT_TIMESTAMP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a function to check if a user has auto-accept enabled
CREATE OR REPLACE FUNCTION public.user_auto_accepts_connections(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(
        (SELECT (privacy_settings->>'auto_accept_connections')::boolean
         FROM public.user_settings
         WHERE user_id = p_user_id),
        FALSE
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- Create a trigger function to auto-accept connections when requested
CREATE OR REPLACE FUNCTION public.auto_accept_connection_if_enabled()
RETURNS TRIGGER AS $$
DECLARE
    v_auto_accept BOOLEAN;
    v_connection_id UUID;
BEGIN
    -- Only process new pending connection invitations
    IF NEW.status != 'pending' THEN
        RETURN NEW;
    END IF;

    -- Check if recipient has auto-accept enabled
    v_auto_accept := public.user_auto_accepts_connections(NEW.recipient_id);

    IF v_auto_accept THEN
        -- Auto-accept the invitation
        NEW.status = 'accepted';
        NEW.responded_at = CURRENT_TIMESTAMP;

        -- Create the bidirectional connection
        -- First direction: sender -> recipient
        INSERT INTO public.connections (
            user_id,
            connection_id,
            status,
            connection_type,
            auto_accepted,
            initiated_by,
            created_at,
            accepted_at
        ) VALUES (
            NEW.sender_id,
            NEW.recipient_id,
            'accepted',
            'mutual',
            TRUE,
            NEW.sender_id,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (user_id, connection_id) DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP,
            auto_accepted = TRUE;

        -- Second direction: recipient -> sender
        INSERT INTO public.connections (
            user_id,
            connection_id,
            status,
            connection_type,
            auto_accepted,
            initiated_by,
            created_at,
            accepted_at
        ) VALUES (
            NEW.recipient_id,
            NEW.sender_id,
            'accepted',
            'mutual',
            TRUE,
            NEW.sender_id,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (user_id, connection_id) DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP,
            auto_accepted = TRUE;

        -- Log the auto-acceptance
        RAISE NOTICE 'Auto-accepted connection request from % to %', NEW.sender_id, NEW.recipient_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-accepting connections
DROP TRIGGER IF EXISTS auto_accept_connection_trigger ON public.connection_invitations;
CREATE TRIGGER auto_accept_connection_trigger
    BEFORE INSERT OR UPDATE ON public.connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.auto_accept_connection_if_enabled();

-- Update existing user settings to include the auto_accept_connections field
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object('auto_accept_connections', false)
WHERE NOT (privacy_settings ? 'auto_accept_connections');

-- Add a comment explaining the new setting
COMMENT ON FUNCTION public.user_auto_accepts_connections IS
'Checks if a user has enabled auto-accept for all connection requests.
Public users might want this enabled to build their network quickly.
Private users will typically have this disabled for privacy.';

-- Create an index for quick lookup of auto-accept settings
CREATE INDEX IF NOT EXISTS idx_user_settings_auto_accept
ON public.user_settings((privacy_settings->>'auto_accept_connections'))
WHERE (privacy_settings->>'auto_accept_connections')::boolean = true;

-- Log the migration
DO $$
BEGIN
    RAISE NOTICE 'Auto-accept connections feature has been added successfully';
    RAISE NOTICE 'Users can now enable auto-accept in their privacy settings';
    RAISE NOTICE 'When enabled, all incoming connection requests will be automatically accepted';
    RAISE NOTICE 'This is useful for public profiles who want to grow their network quickly';
END $$;

COMMIT;