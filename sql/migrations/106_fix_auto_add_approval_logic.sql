-- Migration: Fix auto-add approval logic to respect user preferences
-- Description: Fixes the auto-add functions to respect user's explicit preferences
-- rather than globally blocking auto-add for users who require approval
-- Date: 2025-09-26
commit;
BEGIN;

-- Fix the user_allows_automatic_group_additions function
DROP FUNCTION IF EXISTS user_allows_automatic_group_additions(uuid) CASCADE;

CREATE OR REPLACE FUNCTION user_allows_automatic_group_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
    v_explicit_preference boolean;
BEGIN
    -- Get user's auto-add preferences first
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    -- Check if user has explicitly set the preference
    v_explicit_preference := (v_auto_add_preferences->>'allowAutomaticGroupAdditions')::boolean;

    -- If user has explicitly enabled auto-add, respect that choice
    IF v_explicit_preference IS NOT NULL THEN
        RETURN v_explicit_preference;
    END IF;

    -- If no explicit preference, check if user requires approval
    -- Only use approval check as a fallback, not an override
    IF user_requires_approval_for_additions(p_user_id) THEN
        RETURN false;
    END IF;

    -- Default to false if no preference and doesn't require approval
    RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Fix the user_allows_automatic_list_additions function similarly
DROP FUNCTION IF EXISTS user_allows_automatic_list_additions(uuid) CASCADE;

CREATE OR REPLACE FUNCTION user_allows_automatic_list_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
    v_explicit_preference boolean;
BEGIN
    -- Get user's auto-add preferences first
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    -- Check if user has explicitly set the preference
    v_explicit_preference := (v_auto_add_preferences->>'allowAutomaticListAdditions')::boolean;

    -- If user has explicitly enabled auto-add, respect that choice
    IF v_explicit_preference IS NOT NULL THEN
        RETURN v_explicit_preference;
    END IF;

    -- If no explicit preference, check if user requires approval
    -- Only use approval check as a fallback, not an override
    IF user_requires_approval_for_additions(p_user_id) THEN
        RETURN false;
    END IF;

    -- Default to false if no preference and doesn't require approval
    RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Add a comment explaining the fix
COMMENT ON FUNCTION user_allows_automatic_group_additions(uuid) IS
'Returns true if user allows automatic group additions. Respects explicit user preferences over approval requirements.';

COMMENT ON FUNCTION user_allows_automatic_list_additions(uuid) IS
'Returns true if user allows automatic list additions. Respects explicit user preferences over approval requirements.';

COMMIT;