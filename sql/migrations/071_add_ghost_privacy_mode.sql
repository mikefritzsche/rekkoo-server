-- Migration: Add Ghost Privacy Mode for Complete User Invisibility
-- This migration adds support for users who want to be completely hidden from all discovery

BEGIN;

-- Update the privacy_mode enum to include 'ghost' mode
-- Ghost mode makes users completely invisible except through explicit connection codes
DO $$
BEGIN
    -- First, update the existing privacy_settings JSONB to support ghost mode
    -- We don't need to alter an enum since we're using JSONB

    -- Add a comment explaining the privacy modes
    COMMENT ON COLUMN public.user_settings.privacy_settings IS
    'User privacy preferences. Privacy modes:
    - ghost: Completely invisible, only discoverable via connection code
    - private: Only visible to connections (default)
    - standard: Limited public visibility with controls
    - public: Fully discoverable and visible';
END $$;

-- Create a function to check if a user is in ghost mode
CREATE OR REPLACE FUNCTION public.is_user_ghost(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.user_settings
        WHERE user_id = p_user_id
        AND privacy_settings->>'privacy_mode' = 'ghost'
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- Create a function to check if users can see each other based on privacy
CREATE OR REPLACE FUNCTION public.can_view_user(
    viewer_id UUID,
    target_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_target_privacy_mode TEXT;
    v_are_connected BOOLEAN;
BEGIN
    -- User can always view themselves
    IF viewer_id = target_id THEN
        RETURN TRUE;
    END IF;

    -- Get target user's privacy mode
    SELECT privacy_settings->>'privacy_mode' INTO v_target_privacy_mode
    FROM public.user_settings
    WHERE user_id = target_id;

    -- Default to private if not set
    v_target_privacy_mode := COALESCE(v_target_privacy_mode, 'private');

    -- Ghost users are invisible to everyone except connections
    IF v_target_privacy_mode = 'ghost' THEN
        -- Check if they are connected
        SELECT EXISTS (
            SELECT 1 FROM public.connections c1
            WHERE c1.user_id = viewer_id
            AND c1.connection_id = target_id
            AND c1.status = 'accepted'
            AND EXISTS (
                SELECT 1 FROM public.connections c2
                WHERE c2.user_id = target_id
                AND c2.connection_id = viewer_id
                AND c2.status = 'accepted'
            )
        ) INTO v_are_connected;

        RETURN v_are_connected;
    END IF;

    -- For other privacy modes, return true (let other logic handle visibility)
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

-- Update the privacy settings trigger to handle ghost mode
CREATE OR REPLACE FUNCTION public.set_user_privacy_defaults()
RETURNS TRIGGER AS $$
BEGIN
    -- If privacy_settings is null or doesn't have privacy_mode, set to private
    IF NEW.privacy_settings IS NULL OR NOT (NEW.privacy_settings ? 'privacy_mode') THEN
        NEW.privacy_settings = jsonb_build_object(
            'privacy_mode', 'private',
            'show_email_to_connections', false,
            'allow_connection_requests', true,
            'allow_group_invites_from_connections', true,
            'searchable_by_username', false,
            'searchable_by_email', false,
            'searchable_by_name', false,
            'show_mutual_connections', false,
            'connection_code', public.generate_user_connection_code()
        );
    ELSIF NEW.privacy_settings->>'privacy_mode' IS NULL THEN
        -- If privacy_mode is null, set it to private
        NEW.privacy_settings = NEW.privacy_settings || jsonb_build_object(
            'privacy_mode', 'private',
            'connection_code', public.generate_user_connection_code()
        );
    END IF;

    -- Ensure ghost and private mode users have a connection code
    IF NEW.privacy_settings->>'privacy_mode' IN ('private', 'ghost')
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = jsonb_set(
            NEW.privacy_settings,
            '{connection_code}',
            to_jsonb(public.generate_user_connection_code())
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update the privacy settings update trigger
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
                'anonymous_in_groups', true
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
    END IF;

    -- Set updated_at
    NEW.updated_at = CURRENT_TIMESTAMP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create indexes for ghost mode queries
CREATE INDEX IF NOT EXISTS idx_user_settings_ghost_mode
ON public.user_settings((privacy_settings->>'privacy_mode'))
WHERE privacy_settings->>'privacy_mode' = 'ghost';

CREATE INDEX IF NOT EXISTS idx_user_settings_show_in_suggestions
ON public.user_settings((privacy_settings->>'show_in_suggestions'));

CREATE INDEX IF NOT EXISTS idx_user_settings_anonymous_in_groups
ON public.user_settings((privacy_settings->>'anonymous_in_groups'));

-- Add validation for privacy mode values
ALTER TABLE public.user_settings
ADD CONSTRAINT valid_privacy_mode CHECK (
    privacy_settings->>'privacy_mode' IS NULL OR
    privacy_settings->>'privacy_mode' IN ('ghost', 'private', 'standard', 'public')
);

-- Update existing private users to have the new settings
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'show_in_suggestions', false,
    'show_in_group_members', true,
    'anonymous_in_groups', false
)
WHERE privacy_settings->>'privacy_mode' = 'private'
  AND NOT (privacy_settings ? 'show_in_suggestions');

-- Create a view for safely displaying users (respects ghost mode)
CREATE OR REPLACE VIEW public.safe_user_profiles AS
SELECT
    u.id,
    CASE
        WHEN us.privacy_settings->>'privacy_mode' = 'ghost' THEN 'Ghost User'
        ELSE u.username
    END as username,
    CASE
        WHEN us.privacy_settings->>'privacy_mode' = 'ghost' THEN NULL
        WHEN us.privacy_settings->>'privacy_mode' = 'private' THEN NULL
        ELSE u.full_name
    END as full_name,
    CASE
        WHEN us.privacy_settings->>'privacy_mode' IN ('ghost', 'private') THEN NULL
        ELSE u.email
    END as email,
    CASE
        WHEN us.privacy_settings->>'privacy_mode' = 'ghost' THEN NULL
        ELSE u.profile_image_url
    END as profile_image_url,
    us.privacy_settings->>'privacy_mode' as privacy_mode
FROM public.users u
LEFT JOIN public.user_settings us ON u.id = us.user_id
WHERE u.deleted_at IS NULL;

COMMENT ON VIEW public.safe_user_profiles IS
'Safe view of user profiles that respects privacy settings. Ghost users show minimal information.';

-- Log the migration
DO $$
BEGIN
    RAISE NOTICE 'Ghost privacy mode has been added successfully';
    RAISE NOTICE 'Ghost users will be:';
    RAISE NOTICE '  - Completely invisible in search';
    RAISE NOTICE '  - Hidden from user suggestions';
    RAISE NOTICE '  - Anonymous in group member lists (optional)';
    RAISE NOTICE '  - Only discoverable via connection code';
    RAISE NOTICE '  - Invisible on direct profile access (except to connections)';
END $$;

COMMIT;