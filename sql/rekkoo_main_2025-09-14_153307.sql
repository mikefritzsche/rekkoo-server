--
-- PostgreSQL database dump
--

-- Dumped from database version 16.8 (Debian 16.8-1.pgdg120+1)
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: accept_group_invitation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.accept_group_invitation(p_invitation_id uuid, p_user_id uuid) RETURNS TABLE(success boolean, message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_invitation RECORD;
BEGIN
    -- Get and validate the invitation
    SELECT *
    FROM collaboration_group_invitations gi
    WHERE gi.id = p_invitation_id
    AND gi.invitee_id = p_user_id
    AND gi.status = 'pending'
    AND gi.expires_at > CURRENT_TIMESTAMP
    INTO v_invitation;

    IF v_invitation IS NULL THEN
        RETURN QUERY SELECT
            FALSE,
            'Invalid or expired invitation';
        RETURN;
    END IF;

    -- Add user to group members
    INSERT INTO collaboration_group_members (
        group_id,
        user_id,
        role,
        joined_at
    ) VALUES (
        v_invitation.group_id,
        p_user_id,
        'member',
        CURRENT_TIMESTAMP
    )
    ON CONFLICT (group_id, user_id) DO NOTHING;

    -- Update invitation status
    UPDATE collaboration_group_invitations
    SET status = 'accepted',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT
        TRUE,
        'Successfully joined the group';
END;
$$;


ALTER FUNCTION public.accept_group_invitation(p_invitation_id uuid, p_user_id uuid) OWNER TO admin;

--
-- Name: accept_list_invitation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.accept_list_invitation(p_invitation_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_invitation RECORD;
BEGIN
  -- Get invitation details
  SELECT * INTO v_invitation
  FROM list_invitations
  WHERE id = p_invitation_id
  AND invitee_id = p_user_id
  AND status = 'pending'
  AND expires_at > CURRENT_TIMESTAMP;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invitation';
  END IF;

  -- Update invitation status
  UPDATE list_invitations
  SET status = 'accepted',
      accepted_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_invitation_id;

  -- Create user override with the specified role
  INSERT INTO list_user_overrides (list_id, user_id, role)
  VALUES (v_invitation.list_id, v_invitation.invitee_id, v_invitation.role)
  ON CONFLICT (list_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP;

  -- Record the share
  INSERT INTO list_shares (list_id, shared_by, shared_with_type, shared_with_id, role)
  VALUES (v_invitation.list_id, v_invitation.inviter_id, 'user', v_invitation.invitee_id, v_invitation.role)
  ON CONFLICT (list_id, shared_with_type, shared_with_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP;
END;
$$;


ALTER FUNCTION public.accept_list_invitation(p_invitation_id uuid, p_user_id uuid) OWNER TO admin;

--
-- Name: FUNCTION accept_list_invitation(p_invitation_id uuid, p_user_id uuid); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.accept_list_invitation(p_invitation_id uuid, p_user_id uuid) IS 'Accepts a list invitation and creates appropriate permissions';


--
-- Name: are_users_connected(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.are_users_connected(p_user1_id uuid, p_user2_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM connections
    WHERE user_id = p_user1_id
    AND connection_id = p_user2_id
    AND (
      (status = 'accepted' AND connection_type = 'mutual')
      OR (status = 'following' AND connection_type = 'following')
    )
  );
END;
$$;


ALTER FUNCTION public.are_users_connected(p_user1_id uuid, p_user2_id uuid) OWNER TO admin;

--
-- Name: FUNCTION are_users_connected(p_user1_id uuid, p_user2_id uuid); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.are_users_connected(p_user1_id uuid, p_user2_id uuid) IS 'Verifies if two users have an active connection';


--
-- Name: can_invite_to_list(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.can_invite_to_list(p_user_id uuid, p_list_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
  is_owner BOOLEAN;
  has_admin_role BOOLEAN;
BEGIN
  -- Check if user is the list owner
  SELECT EXISTS(
    SELECT 1 FROM lists
    WHERE id = p_list_id AND owner_id = p_user_id
  ) INTO is_owner;

  IF is_owner THEN
    RETURN TRUE;
  END IF;

  -- Check if user has admin role via group
  SELECT EXISTS(
    SELECT 1 FROM list_group_roles lgr
    JOIN group_members gm ON gm.group_id = lgr.group_id
    WHERE lgr.list_id = p_list_id
    AND gm.user_id = p_user_id
    AND lgr.role = 'admin'
  ) INTO has_admin_role;

  IF has_admin_role THEN
    RETURN TRUE;
  END IF;

  -- Check if user has admin role via user override
  SELECT EXISTS(
    SELECT 1 FROM list_user_overrides
    WHERE list_id = p_list_id
    AND user_id = p_user_id
    AND role = 'admin'
  ) INTO has_admin_role;

  RETURN has_admin_role;
END;
$$;


ALTER FUNCTION public.can_invite_to_list(p_user_id uuid, p_list_id uuid) OWNER TO admin;

--
-- Name: FUNCTION can_invite_to_list(p_user_id uuid, p_list_id uuid); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.can_invite_to_list(p_user_id uuid, p_list_id uuid) IS 'Checks if a user has permission to invite others to a list';


--
-- Name: cancel_group_invitation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.cancel_group_invitation(p_invitation_id uuid, p_user_id uuid) RETURNS TABLE(success boolean, message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_inviter_id UUID;
    v_group_id UUID;
    v_status VARCHAR(20);
BEGIN
    -- Get invitation details
    SELECT inviter_id, group_id, status
    INTO v_inviter_id, v_group_id, v_status
    FROM group_invitations
    WHERE id = p_invitation_id;

    -- Check if user can cancel (must be inviter or group admin)
    IF v_inviter_id != p_user_id AND NOT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = v_group_id
        AND user_id = p_user_id
        AND role IN ('admin', 'owner')
    ) THEN
        RETURN QUERY SELECT FALSE, 'You are not authorized to cancel this invitation';
        RETURN;
    END IF;

    -- Check invitation status
    IF v_status != 'pending' THEN
        RETURN QUERY SELECT FALSE, 'This invitation is no longer pending';
        RETURN;
    END IF;

    -- Cancel the invitation
    UPDATE group_invitations
    SET status = 'cancelled',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT TRUE, 'Invitation cancelled';
END;
$$;


ALTER FUNCTION public.cancel_group_invitation(p_invitation_id uuid, p_user_id uuid) OWNER TO admin;

--
-- Name: cascade_connection_removal(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.cascade_connection_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_removed_user_id UUID;
    v_removing_user_id UUID;
BEGIN
    -- Determine which user is being disconnected based on who initiated the removal
    IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
        -- Connection is being removed
        v_removing_user_id := NEW.user_id;
        v_removed_user_id := NEW.connection_id;

        -- Remove the removed user from all groups owned/administered by the removing user
        DELETE FROM group_members
        WHERE user_id = v_removed_user_id
        AND group_id IN (
            SELECT group_id FROM group_members
            WHERE user_id = v_removing_user_id
            AND role IN ('owner', 'admin')
        );

        -- Remove the removing user from all groups owned/administered by the removed user
        DELETE FROM group_members
        WHERE user_id = v_removing_user_id
        AND group_id IN (
            SELECT group_id FROM group_members
            WHERE user_id = v_removed_user_id
            AND role IN ('owner', 'admin')
        );

        -- Cancel all pending group invitations between these users
        UPDATE group_invitations
        SET status = 'cancelled',
            responded_at = CURRENT_TIMESTAMP
        WHERE status = 'pending'
        AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
          OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));

        -- Revoke list sharing permissions where one user shared with the other
        DELETE FROM list_collaborators
        WHERE (owner_id = v_removing_user_id AND user_id = v_removed_user_id)
           OR (owner_id = v_removed_user_id AND user_id = v_removing_user_id);

        -- Cancel pending list invitations between these users
        UPDATE list_invitations
        SET status = 'cancelled',
            responded_at = CURRENT_TIMESTAMP
        WHERE status = 'pending'
        AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
          OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));

        -- Log the cascade action for audit
        INSERT INTO audit_logs (
            action_type,
            table_name,
            record_id,
            user_id,
            details,
            created_at
        ) VALUES (
            'cascade_delete',
            'connections',
            NEW.id,
            v_removing_user_id,
            jsonb_build_object(
                'removed_user_id', v_removed_user_id,
                'cascade_type', 'connection_removal',
                'affected_tables', ARRAY['group_members', 'group_invitations', 'list_collaborators', 'list_invitations']
            ),
            CURRENT_TIMESTAMP
        );
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.cascade_connection_removal() OWNER TO admin;

--
-- Name: FUNCTION cascade_connection_removal(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.cascade_connection_removal() IS 'Handles cascade deletion when a connection is removed, revoking all group memberships, list access, and pending invitations';


--
-- Name: check_connection_before_group_invitation(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.check_connection_before_group_invitation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Check if inviter and invitee are connected
    IF NOT EXISTS (
        SELECT 1 FROM connections c1
        WHERE c1.user_id = NEW.inviter_id
        AND c1.connection_id = NEW.invitee_id
        AND c1.status = 'accepted'
        AND c1.removed_at IS NULL
    ) AND NOT EXISTS (
        SELECT 1 FROM connections c2
        WHERE c2.user_id = NEW.invitee_id
        AND c2.connection_id = NEW.inviter_id
        AND c2.status = 'accepted'
        AND c2.removed_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Cannot invite user to group: users must be connected first';
    END IF;

    -- Check if invitee is already a member
    IF EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = NEW.group_id
        AND user_id = NEW.invitee_id
    ) THEN
        RAISE EXCEPTION 'User is already a member of this group';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.check_connection_before_group_invitation() OWNER TO admin;

--
-- Name: check_connection_before_group_invite(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.check_connection_before_group_invite() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.check_connection_before_group_invite() OWNER TO admin;

--
-- Name: cleanup_old_change_logs(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.cleanup_old_change_logs() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Delete change logs older than 30 days
    DELETE FROM public.change_log 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
END;
$$;


ALTER FUNCTION public.cleanup_old_change_logs() OWNER TO admin;

--
-- Name: decline_group_invitation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.decline_group_invitation(p_invitation_id uuid, p_user_id uuid) RETURNS TABLE(success boolean, message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_invitee_id UUID;
    v_status VARCHAR(20);
BEGIN
    -- Get invitation details
    SELECT invitee_id, status
    INTO v_invitee_id, v_status
    FROM group_invitations
    WHERE id = p_invitation_id;

    -- Verify the declining user is the invitee
    IF v_invitee_id != p_user_id THEN
        RETURN QUERY SELECT FALSE, 'You are not authorized to decline this invitation';
        RETURN;
    END IF;

    -- Check invitation status
    IF v_status != 'pending' THEN
        RETURN QUERY SELECT FALSE, 'This invitation is no longer pending';
        RETURN;
    END IF;

    -- Decline the invitation
    UPDATE group_invitations
    SET status = 'declined',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT TRUE, 'Invitation declined';
END;
$$;


ALTER FUNCTION public.decline_group_invitation(p_invitation_id uuid, p_user_id uuid) OWNER TO admin;

--
-- Name: ensure_bidirectional_connection(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.ensure_bidirectional_connection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only for mutual connections that are accepted
    IF NEW.connection_type = 'mutual' AND NEW.status = 'accepted' THEN
        -- Check if the reciprocal connection exists
        IF NOT EXISTS (
            SELECT 1 FROM public.connections
            WHERE user_id = NEW.connection_id
            AND connection_id = NEW.user_id
        ) THEN
            -- Create the reciprocal connection
            INSERT INTO public.connections (
                user_id,
                connection_id,
                status,
                connection_type,
                initiated_by,
                accepted_at,
                visibility_level
            ) VALUES (
                NEW.connection_id,
                NEW.user_id,
                'accepted',
                'mutual',
                NEW.initiated_by,
                NEW.accepted_at,
                NEW.visibility_level
            );
        ELSE
            -- Update the reciprocal connection to accepted
            UPDATE public.connections
            SET status = 'accepted',
                accepted_at = NEW.accepted_at,
                connection_type = 'mutual'
            WHERE user_id = NEW.connection_id
            AND connection_id = NEW.user_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.ensure_bidirectional_connection() OWNER TO admin;

--
-- Name: ensure_private_mode_defaults(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.ensure_private_mode_defaults() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

    -- Ensure private mode users have a connection code
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = jsonb_set(
            NEW.privacy_settings,
            '{connection_code}',
            to_jsonb(public.generate_user_connection_code())
        );
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.ensure_private_mode_defaults() OWNER TO admin;

--
-- Name: expire_old_group_invitations(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.expire_old_group_invitations() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE group_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;
END;
$$;


ALTER FUNCTION public.expire_old_group_invitations() OWNER TO admin;

--
-- Name: expire_old_invitations(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.expire_old_invitations() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Expire group invitations older than 30 days
    UPDATE group_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;

    -- Expire list invitations older than 30 days
    UPDATE list_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;

    -- Expire connection invitations older than 30 days
    UPDATE connection_invitations
    SET status = 'expired',
        responded_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
    AND expires_at < CURRENT_TIMESTAMP;
END;
$$;


ALTER FUNCTION public.expire_old_invitations() OWNER TO admin;

--
-- Name: FUNCTION expire_old_invitations(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.expire_old_invitations() IS 'Automatically expires all pending invitations that have passed their expiration date';


--
-- Name: expire_old_list_invitations(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.expire_old_list_invitations() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE list_invitations
  SET status = 'expired',
      updated_at = CURRENT_TIMESTAMP
  WHERE status = 'pending'
  AND expires_at < CURRENT_TIMESTAMP;

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;


ALTER FUNCTION public.expire_old_list_invitations() OWNER TO admin;

--
-- Name: FUNCTION expire_old_list_invitations(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.expire_old_list_invitations() IS 'Marks expired invitations - should be called periodically';


--
-- Name: generate_invitation_code(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.generate_invitation_code() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.generate_invitation_code() OWNER TO admin;

--
-- Name: generate_list_invitation_code(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.generate_list_invitation_code() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
BEGIN
  LOOP
    -- Generate a code like 'LST-XXXXX' where X is alphanumeric
    code := 'LST-' || UPPER(
      SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FOR 5)
    );

    -- Check if this code already exists
    SELECT EXISTS(
      SELECT 1 FROM list_invitations WHERE invitation_code = code
    ) INTO exists_check;

    -- If unique, return it
    IF NOT exists_check THEN
      RETURN code;
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION public.generate_list_invitation_code() OWNER TO admin;

--
-- Name: generate_user_connection_code(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.generate_user_connection_code() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    code VARCHAR(20);
    code_exists BOOLEAN;
BEGIN
    LOOP
        -- Generate a random 4-digit code
        code := LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');

        -- Check if code already exists in user_settings
        SELECT EXISTS(
            SELECT 1 FROM public.user_settings
            WHERE privacy_settings->>'connection_code' = code
        ) INTO code_exists;

        EXIT WHEN NOT code_exists;
    END LOOP;

    RETURN code;
END;
$$;


ALTER FUNCTION public.generate_user_connection_code() OWNER TO admin;

--
-- Name: get_connection_removal_impact(uuid, uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.get_connection_removal_impact(p_user_id uuid, p_connection_id uuid) RETURNS TABLE(impact_type text, item_count integer, details jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Groups where removed user will lose membership
    RETURN QUERY
    SELECT
        'groups_membership_loss'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'group_id', gm.group_id,
            'group_name', g.name,
            'user_role', gm.role
        )) as details
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = p_connection_id
    AND gm.group_id IN (
        SELECT group_id FROM group_members
        WHERE user_id = p_user_id
        AND role IN ('owner', 'admin')
    );

    -- Pending group invitations that will be cancelled
    RETURN QUERY
    SELECT
        'group_invitations_cancelled'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'invitation_id', gi.id,
            'group_name', g.name,
            'direction', CASE
                WHEN gi.inviter_id = p_user_id THEN 'sent'
                ELSE 'received'
            END
        )) as details
    FROM group_invitations gi
    JOIN groups g ON g.id = gi.group_id
    WHERE gi.status = 'pending'
    AND ((gi.inviter_id = p_user_id AND gi.invitee_id = p_connection_id)
      OR (gi.inviter_id = p_connection_id AND gi.invitee_id = p_user_id));

    -- List collaborations that will be revoked
    RETURN QUERY
    SELECT
        'list_access_revoked'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'list_id', lc.list_id,
            'list_name', l.title,
            'permission', lc.permission
        )) as details
    FROM list_collaborators lc
    JOIN lists l ON l.id = lc.list_id
    WHERE (lc.owner_id = p_user_id AND lc.user_id = p_connection_id)
       OR (lc.owner_id = p_connection_id AND lc.user_id = p_user_id);

    -- Pending list invitations that will be cancelled
    RETURN QUERY
    SELECT
        'list_invitations_cancelled'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'invitation_id', li.id,
            'list_name', l.title,
            'direction', CASE
                WHEN li.inviter_id = p_user_id THEN 'sent'
                ELSE 'received'
            END
        )) as details
    FROM list_invitations li
    JOIN lists l ON l.id = li.list_id
    WHERE li.status = 'pending'
    AND ((li.inviter_id = p_user_id AND li.invitee_id = p_connection_id)
      OR (li.inviter_id = p_connection_id AND li.invitee_id = p_user_id));
END;
$$;


ALTER FUNCTION public.get_connection_removal_impact(p_user_id uuid, p_connection_id uuid) OWNER TO admin;

--
-- Name: FUNCTION get_connection_removal_impact(p_user_id uuid, p_connection_id uuid); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.get_connection_removal_impact(p_user_id uuid, p_connection_id uuid) IS 'Returns a summary of what will be affected when a connection is removed, useful for showing confirmation dialogs';


--
-- Name: get_user_pending_invitations(uuid); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.get_user_pending_invitations(p_user_id uuid) RETURNS TABLE(invitation_type text, invitation_id uuid, sender_name text, group_name text, message text, created_at timestamp with time zone, has_pending_group boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        'connection'::TEXT as invitation_type,
        ci.id as invitation_id,
        u.display_name as sender_name,
        CASE
            WHEN ci.invitation_context = 'group_invitation'
            THEN (ci.metadata->>'group_name')::TEXT
            ELSE NULL::TEXT
        END as group_name,
        ci.message,
        ci.created_at,
        EXISTS(
            SELECT 1 FROM pending_group_invitations pgi
            WHERE pgi.connection_invitation_id = ci.id
            AND pgi.status = 'waiting'
        ) as has_pending_group
    FROM connection_invitations ci
    JOIN users u ON u.id = ci.sender_id
    WHERE ci.recipient_id = p_user_id
    AND ci.status = 'pending'

    UNION ALL

    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        u.display_name as sender_name,
        g.name as group_name,
        gi.message,
        gi.created_at,
        FALSE as has_pending_group
    FROM group_invitations gi
    JOIN users u ON u.id = gi.inviter_id
    JOIN collaboration_groups g ON g.id = gi.group_id
    WHERE gi.invitee_id = p_user_id
    AND gi.status = 'pending'

    ORDER BY created_at DESC;
END;
$$;


ALTER FUNCTION public.get_user_pending_invitations(p_user_id uuid) OWNER TO admin;

--
-- Name: handle_following_auto_accept(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.handle_following_auto_accept() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- If it's a following connection type, automatically set to accepted and mark auto_accepted
    IF NEW.connection_type = 'following' THEN
        NEW.status = 'following';
        NEW.auto_accepted = TRUE;
        NEW.accepted_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.handle_following_auto_accept() OWNER TO admin;

--
-- Name: invite_user_to_group_cascade(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.invite_user_to_group_cascade(p_group_id uuid, p_inviter_id uuid, p_invitee_id uuid, p_message text DEFAULT NULL::text) RETURNS TABLE(success boolean, message text, invitation_type text, invitation_id uuid)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_is_connected BOOLEAN;
    v_pending_connection BOOLEAN;
    v_existing_invitation UUID;
    v_invitation_id UUID;
    v_is_member BOOLEAN;
BEGIN
    -- Check if users are connected
    -- Note: connections table uses 'connection_id' not 'connected_user_id'
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'accepted'
        AND (
            (user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id)
        )
    ) INTO v_is_connected;

    -- Check for pending connection
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'pending'
        AND (
            (user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id)
        )
    ) INTO v_pending_connection;

    -- If users are connected, send group invitation directly
    IF v_is_connected THEN
        -- Check if already invited
        SELECT id INTO v_existing_invitation
        FROM collaboration_group_invitations
        WHERE group_id = p_group_id
        AND invitee_id = p_invitee_id
        AND status = 'pending';

        IF v_existing_invitation IS NOT NULL THEN
            RETURN QUERY SELECT
                FALSE,
                'User has already been invited to this group',
                'group_invitation'::TEXT,
                v_existing_invitation;
            RETURN;
        END IF;

        -- Check if already a member
        SELECT EXISTS(
            SELECT 1 FROM collaboration_group_members
            WHERE group_id = p_group_id
            AND user_id = p_invitee_id
        ) INTO v_is_member;

        IF v_is_member THEN
            RETURN QUERY SELECT
                FALSE,
                'User is already a member of this group',
                NULL::TEXT,
                NULL::UUID;
            RETURN;
        END IF;

        -- Create group invitation
        INSERT INTO collaboration_group_invitations (
            id,
            group_id,
            inviter_id,
            invitee_id,
            message,
            status,
            created_at,
            expires_at
        ) VALUES (
            gen_random_uuid(),
            p_group_id,
            p_inviter_id,
            p_invitee_id,
            p_message,
            'pending',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '30 days'
        ) RETURNING id INTO v_invitation_id;

        RETURN QUERY SELECT
            TRUE,
            'Group invitation sent successfully',
            'group_invitation'::TEXT,
            v_invitation_id;
    ELSE
        -- Users are not connected
        IF v_pending_connection THEN
            -- There's already a pending connection
            -- Store the pending group invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at;

            RETURN QUERY SELECT
                TRUE,
                'Connection request already pending. Group invitation will be sent once connected',
                'pending_connection'::TEXT,
                NULL::UUID;
        ELSE
            -- Send connection request and store pending invitation
            INSERT INTO connections (
                id,
                user_id,
                connection_id,
                status,
                initiated_by,
                created_at
            ) VALUES (
                gen_random_uuid(),
                p_inviter_id,
                p_invitee_id,
                'pending',
                p_inviter_id,
                CURRENT_TIMESTAMP
            ) RETURNING id INTO v_invitation_id;

            -- Store the pending group invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at;

            RETURN QUERY SELECT
                TRUE,
                'Connection request sent. User will be invited to the group once they accept',
                'connection_request'::TEXT,
                v_invitation_id;
        END IF;
    END IF;
END;
$$;


ALTER FUNCTION public.invite_user_to_group_cascade(p_group_id uuid, p_inviter_id uuid, p_invitee_id uuid, p_message text) OWNER TO admin;

--
-- Name: FUNCTION invite_user_to_group_cascade(p_group_id uuid, p_inviter_id uuid, p_invitee_id uuid, p_message text); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.invite_user_to_group_cascade(p_group_id uuid, p_inviter_id uuid, p_invitee_id uuid, p_message text) IS 'Updated in migration 059 to use correct connections column names (connection_id not connected_user_id)';


--
-- Name: log_table_changes(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.log_table_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.log_table_changes() OWNER TO admin;

--
-- Name: mark_reminder_sent(text, uuid, text); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.mark_reminder_sent(p_invitation_type text, p_invitation_id uuid, p_reminder_type text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF p_invitation_type = 'group' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE group_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE group_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    ELSIF p_invitation_type = 'list' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE list_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE list_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    ELSIF p_invitation_type = 'connection' THEN
        IF p_reminder_type = '25_day' THEN
            UPDATE connection_invitations
            SET reminder_sent_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        ELSIF p_reminder_type = '28_day' THEN
            UPDATE connection_invitations
            SET expiration_notified_at = CURRENT_TIMESTAMP
            WHERE id = p_invitation_id;
        END IF;
    END IF;
END;
$$;


ALTER FUNCTION public.mark_reminder_sent(p_invitation_type text, p_invitation_id uuid, p_reminder_type text) OWNER TO admin;

--
-- Name: process_pending_group_invitations(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.process_pending_group_invitations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    pending_invite RECORD;
    v_invitation_id UUID;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Process pending invitations where NEW.user_id invited NEW.connection_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.user_id
            AND invitee_id = NEW.connection_id
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create the group invitation
                INSERT INTO collaboration_group_invitations (
                    id,
                    group_id,
                    inviter_id,
                    invitee_id,
                    message,
                    status,
                    created_at,
                    expires_at
                ) VALUES (
                    gen_random_uuid(),
                    pending_invite.group_id,
                    pending_invite.inviter_id,
                    pending_invite.invitee_id,
                    pending_invite.message,
                    'pending',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                );
            END IF;

            -- Remove the pending invitation
            DELETE FROM pending_group_invitations
            WHERE group_id = pending_invite.group_id
            AND invitee_id = pending_invite.invitee_id;
        END LOOP;

        -- Process pending invitations where NEW.connection_id invited NEW.user_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.connection_id
            AND invitee_id = NEW.user_id
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create the group invitation
                INSERT INTO collaboration_group_invitations (
                    id,
                    group_id,
                    inviter_id,
                    invitee_id,
                    message,
                    status,
                    created_at,
                    expires_at
                ) VALUES (
                    gen_random_uuid(),
                    pending_invite.group_id,
                    pending_invite.inviter_id,
                    pending_invite.invitee_id,
                    pending_invite.message,
                    'pending',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                );
            END IF;

            -- Remove the pending invitation
            DELETE FROM pending_group_invitations
            WHERE group_id = pending_invite.group_id
            AND invitee_id = pending_invite.invitee_id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.process_pending_group_invitations() OWNER TO admin;

--
-- Name: process_pending_group_invitations_on_connection(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.process_pending_group_invitations_on_connection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_pending_invitation RECORD;
    v_group_invitation_id UUID;
BEGIN
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        FOR v_pending_invitation IN
            SELECT pgi.*, g.name as group_name
            FROM pending_group_invitations pgi
            JOIN collaboration_groups g ON g.id = pgi.group_id
            WHERE pgi.connection_invitation_id = NEW.id
            AND pgi.status = 'waiting'
        LOOP
            INSERT INTO group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                status,
                created_at
            ) VALUES (
                v_pending_invitation.group_id,
                v_pending_invitation.inviter_id,
                v_pending_invitation.invitee_id,
                COALESCE(
                    v_pending_invitation.message,
                    'You''ve been invited to join ' || v_pending_invitation.group_name || ' now that we''re connected!'
                ),
                'pending',
                CURRENT_TIMESTAMP
            )
            RETURNING id INTO v_group_invitation_id;

            UPDATE pending_group_invitations
            SET status = 'sent',
                processed_at = CURRENT_TIMESTAMP
            WHERE id = v_pending_invitation.id;

            INSERT INTO audit_logs (
                action_type,
                table_name,
                record_id,
                user_id,
                details,
                created_at
            ) VALUES (
                'cascade_group_invitation',
                'group_invitations',
                v_group_invitation_id,
                v_pending_invitation.inviter_id,
                jsonb_build_object(
                    'trigger', 'connection_accepted',
                    'connection_invitation_id', NEW.id,
                    'group_id', v_pending_invitation.group_id,
                    'invitee_id', v_pending_invitation.invitee_id
                ),
                CURRENT_TIMESTAMP
            );
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.process_pending_group_invitations_on_connection() OWNER TO admin;

--
-- Name: FUNCTION process_pending_group_invitations_on_connection(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.process_pending_group_invitations_on_connection() IS 'Automatically sends group invitations when connections are accepted';


--
-- Name: run_invitation_expiration_job(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.run_invitation_expiration_job() RETURNS TABLE(expired_count integer, reminders_to_send integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_expired_count INTEGER;
    v_reminders_count INTEGER;
    v_job_id UUID;
BEGIN
    -- Log job start
    INSERT INTO invitation_cron_log (job_type, status)
    VALUES ('invitation_expiration', 'running')
    RETURNING id INTO v_job_id;

    -- Expire old invitations
    PERFORM expire_old_invitations();

    -- Count expired invitations
    SELECT COUNT(*) INTO v_expired_count
    FROM (
        SELECT id FROM group_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
        UNION ALL
        SELECT id FROM list_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
        UNION ALL
        SELECT id FROM connection_invitations WHERE status = 'expired' AND responded_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'
    ) AS expired;

    -- Count reminders to send
    SELECT COUNT(*) INTO v_reminders_count
    FROM send_invitation_reminders();

    -- Log job completion
    UPDATE invitation_cron_log
    SET completed_at = CURRENT_TIMESTAMP,
        records_processed = v_expired_count + v_reminders_count,
        status = 'completed'
    WHERE id = v_job_id;

    RETURN QUERY SELECT v_expired_count, v_reminders_count;
END;
$$;


ALTER FUNCTION public.run_invitation_expiration_job() OWNER TO admin;

--
-- Name: FUNCTION run_invitation_expiration_job(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.run_invitation_expiration_job() IS 'Main job function to expire invitations and generate reminder notifications';


--
-- Name: send_invitation_reminders(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.send_invitation_reminders() RETURNS TABLE(invitation_type text, invitation_id uuid, inviter_id uuid, invitee_id uuid, days_until_expiry integer, reminder_type text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 25-day reminders for group invitations
    RETURN QUERY
    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        gi.inviter_id,
        gi.invitee_id,
        EXTRACT(DAY FROM (gi.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        '25_day'::TEXT as reminder_type
    FROM group_invitations gi
    WHERE gi.status = 'pending'
    AND gi.reminder_sent_at IS NULL
    AND gi.expires_at > CURRENT_TIMESTAMP
    AND gi.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days')
    AND gi.expires_at >= (CURRENT_TIMESTAMP + INTERVAL '4 days');

    -- 28-day warnings for group invitations
    RETURN QUERY
    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        gi.inviter_id,
        gi.invitee_id,
        EXTRACT(DAY FROM (gi.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        '28_day'::TEXT as reminder_type
    FROM group_invitations gi
    WHERE gi.status = 'pending'
    AND gi.expiration_notified_at IS NULL
    AND gi.expires_at > CURRENT_TIMESTAMP
    AND gi.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days')
    AND gi.expires_at >= (CURRENT_TIMESTAMP + INTERVAL '1 day');

    -- Similar for list invitations
    RETURN QUERY
    SELECT
        'list'::TEXT as invitation_type,
        li.id as invitation_id,
        li.inviter_id,
        li.invitee_id,
        EXTRACT(DAY FROM (li.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        CASE
            WHEN li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days') THEN '25_day'::TEXT
            WHEN li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days') THEN '28_day'::TEXT
        END as reminder_type
    FROM list_invitations li
    WHERE li.status = 'pending'
    AND li.expires_at > CURRENT_TIMESTAMP
    AND li.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days');

    -- Similar for connection invitations
    RETURN QUERY
    SELECT
        'connection'::TEXT as invitation_type,
        ci.id as invitation_id,
        ci.sender_id as inviter_id,
        ci.recipient_id as invitee_id,
        EXTRACT(DAY FROM (ci.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry,
        CASE
            WHEN ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days') THEN '25_day'::TEXT
            WHEN ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '2 days') THEN '28_day'::TEXT
        END as reminder_type
    FROM connection_invitations ci
    WHERE ci.status = 'pending'
    AND ci.expires_at > CURRENT_TIMESTAMP
    AND ci.expires_at <= (CURRENT_TIMESTAMP + INTERVAL '5 days');
END;
$$;


ALTER FUNCTION public.send_invitation_reminders() OWNER TO admin;

--
-- Name: FUNCTION send_invitation_reminders(); Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON FUNCTION public.send_invitation_reminders() IS 'Returns list of invitations that need reminder notifications (25-day and 28-day warnings)';


--
-- Name: set_invitation_code(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.set_invitation_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.invitation_code IS NULL THEN
        NEW.invitation_code := public.generate_invitation_code();
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_invitation_code() OWNER TO admin;

--
-- Name: set_list_invitation_code(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.set_list_invitation_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.invitation_code IS NULL THEN
    NEW.invitation_code := generate_list_invitation_code();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_list_invitation_code() OWNER TO admin;

--
-- Name: touch_spotify_item_details(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.touch_spotify_item_details() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.touch_spotify_item_details() OWNER TO admin;

--
-- Name: track_changes(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.track_changes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  j JSONB;
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
  v_list_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'DELETE' THEN
    v_operation := 'delete';
    j := to_jsonb(OLD.*);
    v_data := NULL;
  END IF;

  -- Derive record ID based on various primary key patterns
  v_id := COALESCE(
    (j->>'id')::TEXT,
    (j->>'uuid')::TEXT,
    (j->>'pk')::TEXT,
    -- Composite keys for specific tables
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  -- Derive user_id from various fields, including reserved_by for gift_reservations
  v_user := COALESCE(
    (j->>'user_id')::uuid, 
    (j->>'owner_id')::uuid,
    -- Special handling for gift_reservations table
    CASE WHEN TG_TABLE_NAME = 'gift_reservations' THEN (j->>'reserved_by')::uuid ELSE NULL END,
    NULL
  );
  
  v_list_id := (j->>'list_id')::uuid;
  
  -- For list_scoped tables, derive user_id from owning list when missing
  IF v_user IS NULL AND v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_user FROM public.lists WHERE id = v_list_id;
  END IF;

  -- For gift_reservations, try to get user from item's list if still null
  IF v_user IS NULL AND TG_TABLE_NAME = 'gift_reservations' AND (j->>'item_id') IS NOT NULL THEN
    SELECT l.owner_id INTO v_user 
    FROM public.list_items li 
    JOIN public.lists l ON li.list_id = l.id 
    WHERE li.id = (j->>'item_id')::uuid;
  END IF;

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$;


ALTER FUNCTION public.track_changes() OWNER TO admin;

--
-- Name: update_gift_details_updated_at(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.update_gift_details_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_gift_details_updated_at() OWNER TO admin;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO admin;

--
-- Name: update_user_privacy_settings(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.update_user_privacy_settings() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Generate connection code if user is in private mode and doesn't have one
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object('connection_code', public.generate_user_connection_code());
    END IF;

    -- Update searchable settings based on privacy mode
    IF NEW.privacy_settings->>'privacy_mode' = 'private' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'public' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'searchable_by_name', true
            );
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_user_privacy_settings() OWNER TO admin;

--
-- Name: update_user_settings_social_networks_updated_at(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.update_user_settings_social_networks_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_user_settings_social_networks_updated_at() OWNER TO admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action_type character varying(50) NOT NULL,
    table_name character varying(100) NOT NULL,
    record_id uuid,
    user_id uuid,
    details jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.audit_logs OWNER TO admin;

--
-- Name: auth_logs; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.auth_logs (
    event_type character varying(50) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    details jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid
);


ALTER TABLE public.auth_logs OWNER TO admin;

--
-- Name: book_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.book_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    google_book_id character varying(255),
    authors text[],
    publisher character varying(255),
    published_date character varying(20),
    page_count integer,
    isbn_13 character varying(20),
    isbn_10 character varying(20),
    categories text[],
    average_rating_google numeric(3,2),
    ratings_count_google integer,
    language character varying(10),
    info_link text,
    canonical_volume_link text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.book_details OWNER TO admin;

--
-- Name: change_log; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.change_log (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    table_name character varying(100) NOT NULL,
    record_id character varying(255) NOT NULL,
    operation character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    change_data jsonb,
    CONSTRAINT change_log_operation_check CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying])::text[])))
);


ALTER TABLE public.change_log OWNER TO admin;

--
-- Name: change_log_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.change_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.change_log_id_seq OWNER TO admin;

--
-- Name: change_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.change_log_id_seq OWNED BY public.change_log.id;


--
-- Name: collaboration_group_list_types; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.collaboration_group_list_types (
    group_id uuid NOT NULL,
    list_type_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.collaboration_group_list_types OWNER TO admin;

--
-- Name: collaboration_group_members; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.collaboration_group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone
);


ALTER TABLE public.collaboration_group_members OWNER TO admin;

--
-- Name: collaboration_groups; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.collaboration_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.collaboration_groups OWNER TO admin;

--
-- Name: collaborative_group_members; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.collaborative_group_members AS
 SELECT group_id,
    user_id,
    role,
    joined_at,
    NULL::timestamp with time zone AS deleted_at
   FROM public.collaboration_group_members;


ALTER VIEW public.collaborative_group_members OWNER TO admin;

--
-- Name: connection_invitations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.connection_invitations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid,
    recipient_email character varying(255),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    invitation_code character varying(100) NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    responded_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '30 days'::interval) NOT NULL,
    reminder_sent_at timestamp with time zone,
    expiration_notified_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    invitation_context character varying(50),
    context_id uuid,
    CONSTRAINT connection_invitation_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'declined'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT recipient_check CHECK ((((recipient_id IS NOT NULL) AND (recipient_email IS NULL)) OR ((recipient_id IS NULL) AND (recipient_email IS NOT NULL))))
);


ALTER TABLE public.connection_invitations OWNER TO admin;

--
-- Name: connections; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.connections (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    initiated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    accepted_at timestamp with time zone,
    removed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    connection_type character varying(20) DEFAULT 'mutual'::character varying,
    auto_accepted boolean DEFAULT false,
    visibility_level character varying(20) DEFAULT 'public'::character varying,
    CONSTRAINT no_self_connection CHECK ((user_id <> connection_id)),
    CONSTRAINT valid_connection_type CHECK (((connection_type)::text = ANY ((ARRAY['mutual'::character varying, 'following'::character varying])::text[]))),
    CONSTRAINT valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'blocked'::character varying, 'removed'::character varying, 'following'::character varying])::text[]))),
    CONSTRAINT valid_visibility_level CHECK (((visibility_level)::text = ANY ((ARRAY['public'::character varying, 'friends'::character varying, 'private'::character varying])::text[])))
);


ALTER TABLE public.connections OWNER TO admin;

--
-- Name: TABLE connections; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.connections IS 'Stores bidirectional user connections';


--
-- Name: COLUMN connections.status; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.connections.status IS 'Connection status values';


--
-- Name: COLUMN connections.initiated_by; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.connections.initiated_by IS 'User who sent the initial connection request';


--
-- Name: COLUMN connections.connection_type; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.connections.connection_type IS 'Type of connection: mutual (bidirectional friend) or following (unidirectional)';


--
-- Name: COLUMN connections.auto_accepted; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.connections.auto_accepted IS 'Whether the connection was automatically accepted (for following relationships)';


--
-- Name: COLUMN connections.visibility_level; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.connections.visibility_level IS 'Privacy level for the connection: public, friends, or private';


--
-- Name: embedding_queue; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.embedding_queue (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entity_id uuid NOT NULL,
    entity_type character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    priority integer DEFAULT 0,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    last_attempt timestamp with time zone,
    next_attempt timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    processed_at timestamp with time zone,
    metadata jsonb,
    CONSTRAINT valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);


ALTER TABLE public.embedding_queue OWNER TO admin;

--
-- Name: embeddings; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.embeddings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    related_entity_id uuid NOT NULL,
    entity_type character varying(50) NOT NULL,
    embedding public.vector(384) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    weight real DEFAULT 1.0
);


ALTER TABLE public.embeddings OWNER TO admin;

--
-- Name: favorite_categories; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.favorite_categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(50),
    icon character varying(50),
    description text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.favorite_categories OWNER TO admin;

--
-- Name: favorite_notification_preferences; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.favorite_notification_preferences (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    favorite_id uuid NOT NULL,
    notify_on_update boolean DEFAULT true,
    notify_on_comment boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.favorite_notification_preferences OWNER TO admin;

--
-- Name: favorite_sharing; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.favorite_sharing (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    favorite_id uuid NOT NULL,
    shared_by_user_id uuid NOT NULL,
    shared_with_user_id uuid,
    shared_with_group_id uuid,
    permissions character varying(20) DEFAULT 'view'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT favorite_sharing_user_or_group CHECK ((((shared_with_user_id IS NOT NULL) AND (shared_with_group_id IS NULL)) OR ((shared_with_user_id IS NULL) AND (shared_with_group_id IS NOT NULL))))
);


ALTER TABLE public.favorite_sharing OWNER TO admin;

--
-- Name: favorites; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.favorites (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    category_id uuid,
    is_public boolean DEFAULT false,
    sort_order integer DEFAULT 0,
    notes text,
    custom_fields jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    CONSTRAINT favorites_valid_type CHECK ((target_type = ANY (ARRAY['list'::text, 'item'::text, 'user'::text])))
);


ALTER TABLE public.favorites OWNER TO admin;

--
-- Name: followers; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.followers (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    follower_id uuid,
    followed_id uuid,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.followers OWNER TO admin;

--
-- Name: TABLE followers; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.followers IS 'DEPRECATED: Migrated to connections table with connection_type=following on 2025-09-14 13:16:50.538168+00.
 Original table had duplicates which were deduplicated during migration.
 Retain for rollback purposes only.';


--
-- Name: gift_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.gift_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    quantity integer,
    where_to_buy text,
    amazon_url text,
    web_link text,
    rating integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.gift_details OWNER TO admin;

--
-- Name: TABLE gift_details; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.gift_details IS 'Stores gift-specific metadata for list items';


--
-- Name: COLUMN gift_details.quantity; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.gift_details.quantity IS 'Desired quantity of the gift item';


--
-- Name: COLUMN gift_details.where_to_buy; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.gift_details.where_to_buy IS 'Store or location where the gift can be purchased';


--
-- Name: COLUMN gift_details.amazon_url; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.gift_details.amazon_url IS 'Direct Amazon link for the gift';


--
-- Name: COLUMN gift_details.web_link; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.gift_details.web_link IS 'General web link for the gift';


--
-- Name: COLUMN gift_details.rating; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.gift_details.rating IS 'User rating for the gift (1-5)';


--
-- Name: gift_reservations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.gift_reservations (
    reservation_message text,
    is_purchased boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    item_id uuid,
    reserved_by uuid,
    reserved_for uuid
);


ALTER TABLE public.gift_reservations OWNER TO admin;

--
-- Name: group_invitations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.group_invitations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    group_id uuid NOT NULL,
    inviter_id uuid NOT NULL,
    invitee_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    invitation_code character varying(100) NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    responded_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '30 days'::interval) NOT NULL,
    role character varying(20) DEFAULT 'member'::character varying,
    CONSTRAINT group_invitation_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'declined'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT no_owner_invitation CHECK ((invitee_id <> inviter_id)),
    CONSTRAINT valid_invitation_role CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'member'::character varying, 'viewer'::character varying])::text[])))
);


ALTER TABLE public.group_invitations OWNER TO admin;

--
-- Name: TABLE group_invitations; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.group_invitations IS 'Stores group invitations that require explicit acceptance from connected users';


--
-- Name: COLUMN group_invitations.invitation_code; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.group_invitations.invitation_code IS 'Unique code for invitation links/deep linking';


--
-- Name: COLUMN group_invitations.expires_at; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.group_invitations.expires_at IS 'Invitations expire after 30 days by default';


--
-- Name: COLUMN group_invitations.role; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.group_invitations.role IS 'The role the invitee will have when they accept the invitation';


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.group_members (
    role character varying(20) DEFAULT 'member'::character varying,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    group_id uuid,
    user_id uuid,
    invitation_id uuid,
    joined_via character varying(20) DEFAULT 'direct'::character varying,
    CONSTRAINT group_members_joined_via_check CHECK (((joined_via)::text = ANY ((ARRAY['direct'::character varying, 'invitation'::character varying, 'owner'::character varying])::text[])))
);


ALTER TABLE public.group_members OWNER TO admin;

--
-- Name: invitation_cron_log; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.invitation_cron_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type character varying(50) NOT NULL,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp with time zone,
    records_processed integer DEFAULT 0,
    errors text,
    status character varying(20) DEFAULT 'running'::character varying
);


ALTER TABLE public.invitation_cron_log OWNER TO admin;

--
-- Name: TABLE invitation_cron_log; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.invitation_cron_log IS 'Tracks execution history of invitation expiration cron jobs';


--
-- Name: invitation_sync_tracking; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.invitation_sync_tracking (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    invitation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action character varying(50) NOT NULL,
    synced_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.invitation_sync_tracking OWNER TO admin;

--
-- Name: invitations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.invitations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    inviter_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(20),
    invitation_code character varying(32) NOT NULL,
    invitation_token character varying(128) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by_user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT invitations_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.invitations OWNER TO admin;

--
-- Name: TABLE invitations; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.invitations IS 'User invitation system for managing app invitations';


--
-- Name: COLUMN invitations.invitation_code; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.invitations.invitation_code IS 'Short code for manual entry (e.g., ABC123)';


--
-- Name: COLUMN invitations.invitation_token; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.invitations.invitation_token IS 'Secure token for deep links';


--
-- Name: COLUMN invitations.status; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.invitations.status IS 'Invitation status: pending, accepted, expired, cancelled';


--
-- Name: COLUMN invitations.metadata; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.invitations.metadata IS 'Flexible JSON data for custom messages, roles, etc.';


--
-- Name: item_tags; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.item_tags (
    item_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    deleted_at timestamp without time zone,
    source text DEFAULT 'user'::text NOT NULL
);


ALTER TABLE public.item_tags OWNER TO admin;

--
-- Name: list_group_roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_group_roles (
    list_id uuid NOT NULL,
    group_id uuid NOT NULL,
    role text NOT NULL,
    permissions jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT list_group_roles_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text])))
);


ALTER TABLE public.list_group_roles OWNER TO admin;

--
-- Name: list_group_relationships; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.list_group_relationships AS
 SELECT (md5(((list_id)::text || (group_id)::text)))::uuid AS id,
    list_id,
    group_id,
    role,
    permissions,
    created_at,
    updated_at,
    deleted_at
   FROM public.list_group_roles;


ALTER VIEW public.list_group_relationships OWNER TO admin;

--
-- Name: lgr; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.lgr AS
 SELECT id,
    list_id,
    group_id,
    role,
    permissions,
    created_at,
    updated_at,
    deleted_at
   FROM public.list_group_relationships;


ALTER VIEW public.lgr OWNER TO admin;

--
-- Name: list_categories; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_categories (
    id_int integer,
    name character varying(50) NOT NULL,
    icon character varying(50),
    description text,
    is_system boolean DEFAULT false,
    deleted_at timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    list_type text
);


ALTER TABLE public.list_categories OWNER TO admin;

--
-- Name: list_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.list_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.list_categories_id_seq OWNER TO admin;

--
-- Name: list_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.list_categories_id_seq OWNED BY public.list_categories.id_int;


--
-- Name: list_group_user_roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_group_user_roles (
    list_id uuid NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    permissions jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT list_group_user_roles_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text])))
);


ALTER TABLE public.list_group_user_roles OWNER TO admin;

--
-- Name: list_invitations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_invitations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_id uuid NOT NULL,
    inviter_id uuid NOT NULL,
    invitee_id uuid NOT NULL,
    role text NOT NULL,
    message text,
    invitation_code text NOT NULL,
    status text DEFAULT 'pending'::text,
    expires_at timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '30 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    expiration_notified_at timestamp with time zone,
    CONSTRAINT list_invitations_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text]))),
    CONSTRAINT list_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])))
);


ALTER TABLE public.list_invitations OWNER TO admin;

--
-- Name: TABLE list_invitations; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.list_invitations IS 'Manages invitations for users to collaborate on lists';


--
-- Name: list_item_categories; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_item_categories (
    item_id uuid NOT NULL,
    category_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


ALTER TABLE public.list_item_categories OWNER TO admin;

--
-- Name: list_item_tags; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_item_tags (
    item_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE public.list_item_tags OWNER TO admin;

--
-- Name: list_items; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_items (
    title character varying(255) NOT NULL,
    description text,
    image_url text,
    link text,
    price numeric(10,2),
    status character varying(50) DEFAULT 'active'::character varying,
    priority integer,
    custom_fields jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    list_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    api_metadata jsonb,
    item_subtitle text,
    item_id_from_api character varying(255),
    api_source character varying(50),
    movie_detail_id uuid,
    book_detail_id uuid,
    place_detail_id uuid,
    spotify_item_detail_id uuid,
    tv_detail_id uuid,
    sort_order integer,
    recipe_detail_id uuid,
    tags text[],
    gift_detail_id uuid,
    CONSTRAINT chk_one_detail_type CHECK ((((((((
CASE
    WHEN (movie_detail_id IS NOT NULL) THEN 1
    ELSE 0
END +
CASE
    WHEN (book_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (place_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (spotify_item_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (tv_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (recipe_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) +
CASE
    WHEN (gift_detail_id IS NOT NULL) THEN 1
    ELSE 0
END) <= 1))
);


ALTER TABLE public.list_items OWNER TO admin;

--
-- Name: list_shares; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_shares (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_id uuid NOT NULL,
    shared_by uuid NOT NULL,
    shared_with_type text NOT NULL,
    shared_with_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    CONSTRAINT list_shares_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text]))),
    CONSTRAINT list_shares_shared_with_type_check CHECK ((shared_with_type = ANY (ARRAY['user'::text, 'group'::text])))
);


ALTER TABLE public.list_shares OWNER TO admin;

--
-- Name: TABLE list_shares; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.list_shares IS 'Tracks active list shares with users and groups';


--
-- Name: list_sharing; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_sharing (
    permissions character varying(20) DEFAULT 'view'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    list_id uuid,
    shared_with_user_id uuid,
    shared_with_group_id uuid
);


ALTER TABLE public.list_sharing OWNER TO admin;

--
-- Name: list_types; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_types (
    id text NOT NULL,
    label text NOT NULL,
    description text,
    icon text,
    gradient text[] DEFAULT ARRAY[]::text[],
    icon_color text DEFAULT '#FFFFFF'::text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.list_types OWNER TO admin;

--
-- Name: list_user_overrides; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_user_overrides (
    list_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    permissions jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    id uuid NOT NULL,
    CONSTRAINT list_user_overrides_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text])))
);


ALTER TABLE public.list_user_overrides OWNER TO admin;

--
-- Name: list_user_overrides_with_id; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.list_user_overrides_with_id AS
 SELECT (md5(((list_id)::text || (user_id)::text)))::uuid AS id,
    list_id,
    user_id,
    role,
    permissions,
    created_at,
    updated_at,
    deleted_at
   FROM public.list_user_overrides;


ALTER VIEW public.list_user_overrides_with_id OWNER TO admin;

--
-- Name: lists; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.lists (
    title character varying(100) NOT NULL,
    description text,
    is_public boolean DEFAULT false,
    is_collaborative boolean DEFAULT false,
    occasion character varying(100),
    list_type text DEFAULT 'custom'::text NOT NULL,
    custom_fields jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    owner_id uuid NOT NULL,
    category_id uuid,
    background jsonb,
    image_url text,
    is_event boolean DEFAULT false,
    event_date timestamp with time zone,
    location text,
    sort_order integer DEFAULT 0,
    local_image_uri text,
    local_image_mime_type character varying(255),
    local_image_upload_status character varying(50),
    local_image_key text,
    content_background jsonb,
    privacy_level character varying(20) DEFAULT 'private'::character varying NOT NULL,
    CONSTRAINT lists_event_date_check CHECK ((((is_event = false) AND (event_date IS NULL)) OR ((is_event = true) AND (event_date IS NOT NULL)))),
    CONSTRAINT lists_sort_order_check CHECK ((sort_order >= 0))
);


ALTER TABLE public.lists OWNER TO admin;

--
-- Name: COLUMN lists.local_image_uri; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.lists.local_image_uri IS 'Temporary client-side URI of an image pending upload.';


--
-- Name: COLUMN lists.local_image_mime_type; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.lists.local_image_mime_type IS 'MIME type of the image pending upload.';


--
-- Name: COLUMN lists.local_image_upload_status; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.lists.local_image_upload_status IS 'Status of the local image upload process (pending, uploading, uploaded, failed).';


--
-- Name: COLUMN lists.local_image_key; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.lists.local_image_key IS 'Storage key (e.g., S3 key) of the successfully uploaded background image.';


--
-- Name: COLUMN lists.privacy_level; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.lists.privacy_level IS 'Privacy setting for the list: private, public, or group';


--
-- Name: luo; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.luo AS
 SELECT id,
    list_id,
    user_id,
    role,
    permissions,
    created_at,
    updated_at,
    deleted_at
   FROM public.list_user_overrides_with_id;


ALTER VIEW public.luo OWNER TO admin;

--
-- Name: migration_verification; Type: VIEW; Schema: public; Owner: admin
--

CREATE VIEW public.migration_verification AS
 SELECT 'followers_original'::text AS source,
    count(*) AS total_count,
    count(DISTINCT followers.follower_id) AS unique_followers,
    count(DISTINCT followers.followed_id) AS unique_followed,
    count(
        CASE
            WHEN (followers.deleted_at IS NULL) THEN 1
            ELSE NULL::integer
        END) AS active_count
   FROM public.followers
UNION ALL
 SELECT 'connections_following'::text AS source,
    count(*) AS total_count,
    count(DISTINCT connections.user_id) AS unique_followers,
    count(DISTINCT connections.connection_id) AS unique_followed,
    count(*) AS active_count
   FROM public.connections
  WHERE ((connections.connection_type)::text = 'following'::text)
UNION ALL
 SELECT 'connections_mutual'::text AS source,
    count(*) AS total_count,
    count(DISTINCT connections.user_id) AS unique_followers,
    count(DISTINCT connections.connection_id) AS unique_followed,
    count(*) AS active_count
   FROM public.connections
  WHERE ((connections.connection_type)::text = 'mutual'::text);


ALTER VIEW public.migration_verification OWNER TO admin;

--
-- Name: movie_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.movie_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    tmdb_id character varying(255),
    tagline text,
    release_date date,
    genres text[],
    rating numeric(3,1),
    vote_count integer,
    runtime_minutes integer,
    original_language character varying(10),
    original_title character varying(255),
    popularity numeric,
    poster_path text,
    backdrop_path text,
    budget bigint,
    revenue bigint,
    status character varying(50),
    production_companies jsonb,
    production_countries jsonb,
    spoken_languages jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    title text,
    overview text,
    watch_providers jsonb
);


ALTER TABLE public.movie_details OWNER TO admin;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.notifications (
    notification_type character varying(50) NOT NULL,
    title character varying(100) NOT NULL,
    body text NOT NULL,
    entity_type character varying(50),
    is_read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid,
    actor_id uuid,
    entity_id uuid,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.notifications OWNER TO admin;

--
-- Name: oauth_providers; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.oauth_providers (
    id integer NOT NULL,
    provider_name character varying(50) NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.oauth_providers OWNER TO admin;

--
-- Name: oauth_providers_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.oauth_providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.oauth_providers_id_seq OWNER TO admin;

--
-- Name: oauth_providers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.oauth_providers_id_seq OWNED BY public.oauth_providers.id;


--
-- Name: pending_group_invitations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.pending_group_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    inviter_id uuid NOT NULL,
    invitee_id uuid NOT NULL,
    connection_invitation_id uuid,
    message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    processed_at timestamp with time zone,
    status character varying(20) DEFAULT 'waiting'::character varying,
    CONSTRAINT pending_group_invitations_status_check CHECK (((status)::text = ANY ((ARRAY['waiting'::character varying, 'sent'::character varying, 'cancelled'::character varying, 'expired'::character varying])::text[])))
);


ALTER TABLE public.pending_group_invitations OWNER TO admin;

--
-- Name: TABLE pending_group_invitations; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON TABLE public.pending_group_invitations IS 'Tracks group invitations waiting for connection acceptance';


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.permissions (
    name character varying(100) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE public.permissions OWNER TO admin;

--
-- Name: place_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.place_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    google_place_id character varying(255),
    address_formatted text,
    address_components jsonb,
    phone_number_international character varying(50),
    phone_number_national character varying(50),
    website text,
    rating_google numeric(2,1),
    user_ratings_total_google integer,
    price_level_google integer,
    latitude double precision,
    longitude double precision,
    google_maps_url text,
    business_status character varying(50),
    opening_hours jsonb,
    types text[],
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    photos text[]
);


ALTER TABLE public.place_details OWNER TO admin;

--
-- Name: recipe_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.recipe_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title text,
    summary text,
    image_url text,
    source_url text,
    servings integer,
    cook_time integer,
    data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    list_item_id uuid,
    deleted_at timestamp with time zone
);


ALTER TABLE public.recipe_details OWNER TO admin;

--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.refresh_tokens (
    token character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    revoked boolean DEFAULT false,
    revoked_at timestamp with time zone,
    deleted_at timestamp with time zone,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid
);


ALTER TABLE public.refresh_tokens OWNER TO admin;

--
-- Name: reviews; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.reviews (
    rating integer,
    review_text text,
    sentiment_score numeric(3,2),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid,
    item_id uuid,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


ALTER TABLE public.reviews OWNER TO admin;

--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.role_permissions (
    assigned_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    role_id uuid,
    permission_id uuid
);


ALTER TABLE public.role_permissions OWNER TO admin;

--
-- Name: roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.roles (
    name character varying(50) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE public.roles OWNER TO admin;

--
-- Name: saved_locations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.saved_locations (
    name character varying(100) NOT NULL,
    address text,
    latitude numeric(10,8),
    longitude numeric(11,8),
    location_type character varying(50),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid
);


ALTER TABLE public.saved_locations OWNER TO admin;

--
-- Name: search_embeddings; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.search_embeddings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid,
    raw_query text NOT NULL,
    embedding public.vector(384) NOT NULL,
    weight real DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone
);


ALTER TABLE public.search_embeddings OWNER TO admin;

--
-- Name: spotify_item_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.spotify_item_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    spotify_id character varying(255) NOT NULL,
    spotify_item_type character varying(50) NOT NULL,
    name text,
    external_urls_spotify jsonb,
    images jsonb,
    uri_spotify character varying(255),
    item_specific_metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.spotify_item_details OWNER TO admin;

--
-- Name: tags; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.tags (
    id uuid NOT NULL,
    list_type text NOT NULL,
    name text NOT NULL,
    tag_type text DEFAULT 'tag'::text,
    is_system boolean DEFAULT false,
    deleted_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.tags OWNER TO admin;

--
-- Name: tv_details; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.tv_details (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    list_item_id uuid NOT NULL,
    tmdb_id character varying(255),
    name text,
    tagline text,
    first_air_date date,
    last_air_date date,
    genres text[],
    rating numeric(3,1),
    vote_count integer,
    episode_run_time integer[],
    number_of_episodes integer,
    number_of_seasons integer,
    status character varying(50),
    type character varying(50),
    original_language character varying(10),
    original_name character varying(255),
    popularity numeric,
    poster_path text,
    backdrop_path text,
    production_companies jsonb,
    production_countries jsonb,
    spoken_languages jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    overview text,
    in_production boolean,
    watch_providers jsonb
);


ALTER TABLE public.tv_details OWNER TO admin;

--
-- Name: user_achievements; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_achievements (
    achievement_type character varying(50) NOT NULL,
    achievement_data jsonb,
    achieved_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid
);


ALTER TABLE public.user_achievements OWNER TO admin;

--
-- Name: user_activity; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_activity (
    activity_type character varying(50) NOT NULL,
    reference_id integer,
    reference_type character varying(50),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid
);


ALTER TABLE public.user_activity OWNER TO admin;

--
-- Name: user_groups; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_groups (
    name character varying(100) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    created_by uuid
);


ALTER TABLE public.user_groups OWNER TO admin;

--
-- Name: user_integrations; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_integrations (
    integration_type character varying(50) NOT NULL,
    credentials jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid
);


ALTER TABLE public.user_integrations OWNER TO admin;

--
-- Name: user_oauth_connections; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_oauth_connections (
    provider_user_id character varying(255) NOT NULL,
    access_token text,
    refresh_token text,
    token_expires_at timestamp with time zone,
    profile_data jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid,
    provider_id integer NOT NULL
);


ALTER TABLE public.user_oauth_connections OWNER TO admin;

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_roles (
    assigned_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    user_id uuid,
    role_id uuid,
    assigned_by uuid
);


ALTER TABLE public.user_roles OWNER TO admin;

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_sessions (
    token character varying(255) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_activity_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    user_id uuid,
    refresh_token character varying(255)
);


ALTER TABLE public.user_sessions OWNER TO admin;

--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_settings (
    theme character varying(20) DEFAULT 'light'::character varying,
    notification_preferences jsonb DEFAULT '{"push": true, "email": true}'::jsonb,
    privacy_settings jsonb DEFAULT jsonb_build_object('privacy_mode', 'private', 'show_email_to_connections', false, 'allow_connection_requests', true, 'allow_group_invites_from_connections', true, 'searchable_by_username', false, 'searchable_by_email', false, 'searchable_by_name', false, 'show_mutual_connections', false, 'connection_code', NULL::unknown),
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    lists_header_image_url text,
    lists_header_background_type text,
    lists_header_background_value text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    social_networks jsonb DEFAULT '{"networks": []}'::jsonb,
    misc_settings jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.user_settings OWNER TO admin;

--
-- Name: COLUMN user_settings.privacy_settings; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.user_settings.privacy_settings IS 'User privacy preferences migrated from user_privacy_settings table. Includes visibility settings, connection settings, and privacy mode (private/standard/public)';


--
-- Name: COLUMN user_settings.lists_header_background_type; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.user_settings.lists_header_background_type IS 'Type of background for lists header (e.g., ''color'', ''image'')';


--
-- Name: COLUMN user_settings.lists_header_background_value; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.user_settings.lists_header_background_value IS 'Value for the lists header background (hex code for color, URL for image)';


--
-- Name: COLUMN user_settings.social_networks; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.user_settings.social_networks IS 'Array of social network connections with format: {"networks": [{"platform": "instagram", "username": "user123", "url": "https://..."}, ...]}';


--
-- Name: users; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.users (
    username character varying(50) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    profile_image_url text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    email_verified boolean DEFAULT false,
    verification_token character varying(255),
    verification_token_expires_at timestamp with time zone,
    reset_password_token character varying(255),
    reset_password_token_expires_at timestamp with time zone,
    last_login_at timestamp with time zone,
    account_locked boolean DEFAULT false,
    failed_login_attempts integer DEFAULT 0,
    lockout_until timestamp with time zone,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    full_name text,
    bio text,
    admin_locked boolean DEFAULT false NOT NULL,
    admin_lock_reason text,
    admin_lock_expires_at timestamp with time zone,
    invited_by_user_id uuid,
    invitation_accepted_at timestamp with time zone,
    profile_display_config jsonb
);


ALTER TABLE public.users OWNER TO admin;

--
-- Name: COLUMN users.full_name; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.users.full_name IS 'User''s full name';


--
-- Name: COLUMN users.bio; Type: COMMENT; Schema: public; Owner: admin
--

COMMENT ON COLUMN public.users.bio IS 'User''s short biography';


--
-- Name: change_log id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.change_log ALTER COLUMN id SET DEFAULT nextval('public.change_log_id_seq'::regclass);


--
-- Name: oauth_providers id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.oauth_providers ALTER COLUMN id SET DEFAULT nextval('public.oauth_providers_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_logs auth_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.auth_logs
    ADD CONSTRAINT auth_logs_pkey PRIMARY KEY (id);


--
-- Name: book_details book_details_google_book_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.book_details
    ADD CONSTRAINT book_details_google_book_id_key UNIQUE (google_book_id);


--
-- Name: book_details book_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.book_details
    ADD CONSTRAINT book_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: book_details book_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.book_details
    ADD CONSTRAINT book_details_pkey PRIMARY KEY (id);


--
-- Name: change_log change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.change_log
    ADD CONSTRAINT change_log_pkey PRIMARY KEY (id);


--
-- Name: collaboration_group_list_types collaboration_group_list_types_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_list_types
    ADD CONSTRAINT collaboration_group_list_types_pkey PRIMARY KEY (group_id, list_type_id);


--
-- Name: collaboration_group_members collaboration_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: collaboration_groups collaboration_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_pkey PRIMARY KEY (id);


--
-- Name: connection_invitations connection_invitations_invitation_code_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connection_invitations
    ADD CONSTRAINT connection_invitations_invitation_code_key UNIQUE (invitation_code);


--
-- Name: connection_invitations connection_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connection_invitations
    ADD CONSTRAINT connection_invitations_pkey PRIMARY KEY (id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: embedding_queue embedding_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.embedding_queue
    ADD CONSTRAINT embedding_queue_pkey PRIMARY KEY (id);


--
-- Name: embeddings embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_pkey PRIMARY KEY (id);


--
-- Name: favorite_categories favorite_categories_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_categories
    ADD CONSTRAINT favorite_categories_pk PRIMARY KEY (id);


--
-- Name: favorite_notification_preferences favorite_notification_preferences_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_notification_preferences
    ADD CONSTRAINT favorite_notification_preferences_pk PRIMARY KEY (id);


--
-- Name: favorite_sharing favorite_sharing_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_sharing
    ADD CONSTRAINT favorite_sharing_pk PRIMARY KEY (id);


--
-- Name: favorites favorites_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_pk PRIMARY KEY (id);


--
-- Name: favorites favorites_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_unique UNIQUE (user_id, target_type, target_id);


--
-- Name: followers followers_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.followers
    ADD CONSTRAINT followers_pkey PRIMARY KEY (id);


--
-- Name: gift_details gift_details_list_item_id_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_details
    ADD CONSTRAINT gift_details_list_item_id_unique UNIQUE (list_item_id);


--
-- Name: gift_details gift_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_details
    ADD CONSTRAINT gift_details_pkey PRIMARY KEY (id);


--
-- Name: gift_reservations gift_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT gift_reservations_pkey PRIMARY KEY (id);


--
-- Name: group_invitations group_invitations_invitation_code_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_invitations
    ADD CONSTRAINT group_invitations_invitation_code_key UNIQUE (invitation_code);


--
-- Name: group_invitations group_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_invitations
    ADD CONSTRAINT group_invitations_pkey PRIMARY KEY (id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);


--
-- Name: invitation_cron_log invitation_cron_log_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitation_cron_log
    ADD CONSTRAINT invitation_cron_log_pkey PRIMARY KEY (id);


--
-- Name: invitation_sync_tracking invitation_sync_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitation_sync_tracking
    ADD CONSTRAINT invitation_sync_tracking_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_invitation_code_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invitation_code_key UNIQUE (invitation_code);


--
-- Name: invitations invitations_invitation_token_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invitation_token_key UNIQUE (invitation_token);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: item_tags item_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_pkey PRIMARY KEY (item_id, tag_id);


--
-- Name: list_items items_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: list_categories list_categories_list_type_name_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_categories
    ADD CONSTRAINT list_categories_list_type_name_unique UNIQUE (list_type, name);


--
-- Name: list_categories list_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_categories
    ADD CONSTRAINT list_categories_pkey PRIMARY KEY (id);


--
-- Name: list_group_roles list_group_roles_id_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_roles
    ADD CONSTRAINT list_group_roles_id_unique UNIQUE (id);


--
-- Name: list_group_roles list_group_roles_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_roles
    ADD CONSTRAINT list_group_roles_pk PRIMARY KEY (list_id, group_id);


--
-- Name: list_group_user_roles list_group_user_roles_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_user_roles
    ADD CONSTRAINT list_group_user_roles_pk PRIMARY KEY (list_id, group_id, user_id);


--
-- Name: list_invitations list_invitations_invitation_code_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_invitation_code_key UNIQUE (invitation_code);


--
-- Name: list_invitations list_invitations_list_id_invitee_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_list_id_invitee_id_key UNIQUE (list_id, invitee_id);


--
-- Name: list_invitations list_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_pkey PRIMARY KEY (id);


--
-- Name: list_item_categories list_item_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_categories
    ADD CONSTRAINT list_item_categories_pkey PRIMARY KEY (id);


--
-- Name: list_item_tags list_item_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_tags
    ADD CONSTRAINT list_item_tags_pkey PRIMARY KEY (item_id, tag_id);


--
-- Name: list_shares list_shares_list_id_shared_with_type_shared_with_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_shares
    ADD CONSTRAINT list_shares_list_id_shared_with_type_shared_with_id_key UNIQUE (list_id, shared_with_type, shared_with_id);


--
-- Name: list_shares list_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_shares
    ADD CONSTRAINT list_shares_pkey PRIMARY KEY (id);


--
-- Name: list_sharing list_sharing_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_pkey PRIMARY KEY (id);


--
-- Name: list_types list_types_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_types
    ADD CONSTRAINT list_types_pkey PRIMARY KEY (id);


--
-- Name: list_user_overrides list_user_overrides_id_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_user_overrides
    ADD CONSTRAINT list_user_overrides_id_unique UNIQUE (id);


--
-- Name: list_user_overrides list_user_overrides_pk; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_user_overrides
    ADD CONSTRAINT list_user_overrides_pk PRIMARY KEY (list_id, user_id);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


--
-- Name: movie_details movie_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.movie_details
    ADD CONSTRAINT movie_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: movie_details movie_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.movie_details
    ADD CONSTRAINT movie_details_pkey PRIMARY KEY (id);


--
-- Name: movie_details movie_details_tmdb_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.movie_details
    ADD CONSTRAINT movie_details_tmdb_id_key UNIQUE (tmdb_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: oauth_providers oauth_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.oauth_providers
    ADD CONSTRAINT oauth_providers_pkey PRIMARY KEY (id);


--
-- Name: oauth_providers oauth_providers_provider_name_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.oauth_providers
    ADD CONSTRAINT oauth_providers_provider_name_key UNIQUE (provider_name);


--
-- Name: pending_group_invitations pending_group_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT pending_group_invitations_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_name_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_name_key UNIQUE (name);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: place_details place_details_google_place_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.place_details
    ADD CONSTRAINT place_details_google_place_id_key UNIQUE (google_place_id);


--
-- Name: place_details place_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.place_details
    ADD CONSTRAINT place_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: place_details place_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.place_details
    ADD CONSTRAINT place_details_pkey PRIMARY KEY (id);


--
-- Name: recipe_details recipe_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.recipe_details
    ADD CONSTRAINT recipe_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: recipe_details recipe_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.recipe_details
    ADD CONSTRAINT recipe_details_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_key UNIQUE (token);


--
-- Name: refresh_tokens refresh_tokens_user_token_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_token_key UNIQUE (user_id, token);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: saved_locations saved_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.saved_locations
    ADD CONSTRAINT saved_locations_pkey PRIMARY KEY (id);


--
-- Name: search_embeddings search_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.search_embeddings
    ADD CONSTRAINT search_embeddings_pkey PRIMARY KEY (id);


--
-- Name: spotify_item_details spotify_item_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.spotify_item_details
    ADD CONSTRAINT spotify_item_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: spotify_item_details spotify_item_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.spotify_item_details
    ADD CONSTRAINT spotify_item_details_pkey PRIMARY KEY (id);


--
-- Name: spotify_item_details spotify_item_details_spotify_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.spotify_item_details
    ADD CONSTRAINT spotify_item_details_spotify_id_key UNIQUE (spotify_id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tv_details tv_details_list_item_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tv_details
    ADD CONSTRAINT tv_details_list_item_id_key UNIQUE (list_item_id);


--
-- Name: tv_details tv_details_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tv_details
    ADD CONSTRAINT tv_details_pkey PRIMARY KEY (id);


--
-- Name: tv_details tv_details_tmdb_id_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tv_details
    ADD CONSTRAINT tv_details_tmdb_id_key UNIQUE (tmdb_id);


--
-- Name: connections unique_connection; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT unique_connection UNIQUE (user_id, connection_id);


--
-- Name: embedding_queue unique_entity; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.embedding_queue
    ADD CONSTRAINT unique_entity UNIQUE (entity_id, entity_type);


--
-- Name: pending_group_invitations unique_pending_group_invitation; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT unique_pending_group_invitation UNIQUE (group_id, invitee_id, status) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: user_achievements user_achievements_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_achievements
    ADD CONSTRAINT user_achievements_pkey PRIMARY KEY (id);


--
-- Name: user_activity user_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_activity
    ADD CONSTRAINT user_activity_pkey PRIMARY KEY (id);


--
-- Name: user_groups user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);


--
-- Name: user_integrations user_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_integrations
    ADD CONSTRAINT user_integrations_pkey PRIMARY KEY (id);


--
-- Name: user_oauth_connections user_oauth_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_oauth_connections
    ADD CONSTRAINT user_oauth_connections_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_token_key UNIQUE (token);


--
-- Name: user_sessions user_sessions_user_token_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_token_key UNIQUE (user_id, token);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: embeddings_embedding_idx; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX embeddings_embedding_idx ON public.embeddings USING hnsw (embedding public.vector_l2_ops);


--
-- Name: idx_audit_logs_table_record; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_audit_logs_table_record ON public.audit_logs USING btree (table_name, record_id);


--
-- Name: idx_audit_logs_user_action; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_audit_logs_user_action ON public.audit_logs USING btree (user_id, action_type, created_at DESC);


--
-- Name: idx_auth_logs_created_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_auth_logs_created_at ON public.auth_logs USING btree (created_at);


--
-- Name: idx_auth_logs_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_auth_logs_deleted_at ON public.auth_logs USING btree (deleted_at);


--
-- Name: idx_auth_logs_event_type; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_auth_logs_event_type ON public.auth_logs USING btree (event_type);


--
-- Name: idx_book_details_authors; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_book_details_authors ON public.book_details USING gin (authors);


--
-- Name: idx_book_details_google_book_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_book_details_google_book_id ON public.book_details USING btree (google_book_id);


--
-- Name: idx_book_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_book_details_list_item_id ON public.book_details USING btree (list_item_id);


--
-- Name: idx_book_details_published_date; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_book_details_published_date ON public.book_details USING btree (published_date);


--
-- Name: idx_cglt_group_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_cglt_group_id ON public.collaboration_group_list_types USING btree (group_id);


--
-- Name: idx_cglt_list_type_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_cglt_list_type_id ON public.collaboration_group_list_types USING btree (list_type_id);


--
-- Name: idx_cgm_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_cgm_deleted_at ON public.collaboration_group_members USING btree (deleted_at);


--
-- Name: idx_change_log_table_record; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_change_log_table_record ON public.change_log USING btree (table_name, record_id);


--
-- Name: idx_change_log_user_created; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_change_log_user_created ON public.change_log USING btree (user_id, created_at);


--
-- Name: idx_change_log_user_timestamp; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_change_log_user_timestamp ON public.change_log USING btree (user_id, created_at);


--
-- Name: idx_collaboration_group_members_group_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_collaboration_group_members_group_id ON public.collaboration_group_members USING btree (group_id);


--
-- Name: idx_collaboration_group_members_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_collaboration_group_members_user_id ON public.collaboration_group_members USING btree (user_id);


--
-- Name: idx_collaboration_groups_owner_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_collaboration_groups_owner_id ON public.collaboration_groups USING btree (owner_id);


--
-- Name: idx_connection_invitations_context; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connection_invitations_context ON public.connection_invitations USING btree (invitation_context, context_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_connection_invitations_expiration; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connection_invitations_expiration ON public.connection_invitations USING btree (status, expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_connections_auto_accepted; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_auto_accepted ON public.connections USING btree (auto_accepted);


--
-- Name: idx_connections_connection_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_connection_id ON public.connections USING btree (connection_id);


--
-- Name: idx_connections_connection_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_connection_status ON public.connections USING btree (connection_id, status);


--
-- Name: idx_connections_connection_type_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_connection_type_status ON public.connections USING btree (connection_id, connection_type, status);


--
-- Name: idx_connections_following; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_following ON public.connections USING btree (user_id, connection_id) WHERE ((connection_type)::text = 'following'::text);


--
-- Name: idx_connections_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_status ON public.connections USING btree (status);


--
-- Name: idx_connections_type; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_type ON public.connections USING btree (connection_type);


--
-- Name: idx_connections_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_user_id ON public.connections USING btree (user_id);


--
-- Name: idx_connections_user_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_user_status ON public.connections USING btree (user_id, status);


--
-- Name: idx_connections_user_type_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_user_type_status ON public.connections USING btree (user_id, connection_type, status);


--
-- Name: idx_connections_visibility; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_connections_visibility ON public.connections USING btree (visibility_level);


--
-- Name: idx_embedding_queue_entity; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_embedding_queue_entity ON public.embedding_queue USING btree (entity_id, entity_type);


--
-- Name: idx_embedding_queue_next_attempt; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_embedding_queue_next_attempt ON public.embedding_queue USING btree (next_attempt);


--
-- Name: idx_embedding_queue_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_embedding_queue_status ON public.embedding_queue USING btree (status);


--
-- Name: idx_favorite_categories_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_categories_deleted_at ON public.favorite_categories USING btree (deleted_at);


--
-- Name: idx_favorite_categories_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_categories_user_id ON public.favorite_categories USING btree (user_id);


--
-- Name: idx_favorite_notification_preferences_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_notification_preferences_deleted_at ON public.favorite_notification_preferences USING btree (deleted_at);


--
-- Name: idx_favorite_notification_preferences_favorite_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_notification_preferences_favorite_id ON public.favorite_notification_preferences USING btree (favorite_id);


--
-- Name: idx_favorite_notification_preferences_unique; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX idx_favorite_notification_preferences_unique ON public.favorite_notification_preferences USING btree (user_id, favorite_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_favorite_notification_preferences_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_notification_preferences_user_id ON public.favorite_notification_preferences USING btree (user_id);


--
-- Name: idx_favorite_sharing_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_sharing_deleted_at ON public.favorite_sharing USING btree (deleted_at);


--
-- Name: idx_favorite_sharing_favorite_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_sharing_favorite_id ON public.favorite_sharing USING btree (favorite_id);


--
-- Name: idx_favorite_sharing_shared_by_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_sharing_shared_by_user_id ON public.favorite_sharing USING btree (shared_by_user_id);


--
-- Name: idx_favorite_sharing_shared_with_group_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_sharing_shared_with_group_id ON public.favorite_sharing USING btree (shared_with_group_id);


--
-- Name: idx_favorite_sharing_shared_with_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorite_sharing_shared_with_user_id ON public.favorite_sharing USING btree (shared_with_user_id);


--
-- Name: idx_favorites_category_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_category_id ON public.favorites USING btree (category_id);


--
-- Name: idx_favorites_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_deleted_at ON public.favorites USING btree (deleted_at);


--
-- Name: idx_favorites_is_public; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_is_public ON public.favorites USING btree (is_public);


--
-- Name: idx_favorites_sort_order; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_sort_order ON public.favorites USING btree (sort_order);


--
-- Name: idx_favorites_target; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_target ON public.favorites USING btree (target_type, target_id);


--
-- Name: idx_favorites_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_favorites_user_id ON public.favorites USING btree (user_id);


--
-- Name: idx_followers_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_followers_deleted_at ON public.followers USING btree (deleted_at);


--
-- Name: idx_gift_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_gift_details_list_item_id ON public.gift_details USING btree (list_item_id);


--
-- Name: idx_gift_reservations_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_gift_reservations_deleted_at ON public.gift_reservations USING btree (deleted_at);


--
-- Name: idx_group_invitations_code; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_code ON public.group_invitations USING btree (invitation_code) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_group_invitations_expiration; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_expiration ON public.group_invitations USING btree (status, expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_group_invitations_expires_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_expires_at ON public.group_invitations USING btree (expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_group_invitations_group_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_group_status ON public.group_invitations USING btree (group_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_group_invitations_invitee_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_invitee_status ON public.group_invitations USING btree (invitee_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_group_invitations_inviter; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_inviter ON public.group_invitations USING btree (inviter_id);


--
-- Name: idx_group_invitations_role; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_invitations_role ON public.group_invitations USING btree (role);


--
-- Name: idx_group_members_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_group_members_deleted_at ON public.group_members USING btree (deleted_at);


--
-- Name: idx_invitation_sync_tracking_invitation_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitation_sync_tracking_invitation_id ON public.invitation_sync_tracking USING btree (invitation_id);


--
-- Name: idx_invitation_sync_tracking_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitation_sync_tracking_user_id ON public.invitation_sync_tracking USING btree (user_id);


--
-- Name: idx_invitations_code; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_code ON public.invitations USING btree (invitation_code);


--
-- Name: idx_invitations_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_deleted_at ON public.invitations USING btree (deleted_at);


--
-- Name: idx_invitations_email; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_email ON public.invitations USING btree (email);


--
-- Name: idx_invitations_expires_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_expires_at ON public.invitations USING btree (expires_at);


--
-- Name: idx_invitations_inviter_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_inviter_id ON public.invitations USING btree (inviter_id);


--
-- Name: idx_invitations_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_status ON public.invitations USING btree (status);


--
-- Name: idx_invitations_token; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_invitations_token ON public.invitations USING btree (invitation_token);


--
-- Name: idx_item_tags_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_item_tags_deleted_at ON public.item_tags USING btree (deleted_at);


--
-- Name: idx_item_tags_source; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_item_tags_source ON public.item_tags USING btree (source);


--
-- Name: idx_lgr_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgr_deleted_at ON public.list_group_roles USING btree (deleted_at);


--
-- Name: idx_lgr_group_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgr_group_id ON public.list_group_roles USING btree (group_id);


--
-- Name: idx_lgr_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgr_list_id ON public.list_group_roles USING btree (list_id);


--
-- Name: idx_lgur_group; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgur_group ON public.list_group_user_roles USING btree (group_id);


--
-- Name: idx_lgur_list; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgur_list ON public.list_group_user_roles USING btree (list_id);


--
-- Name: idx_lgur_user; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lgur_user ON public.list_group_user_roles USING btree (user_id);


--
-- Name: idx_list_categories_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_categories_deleted_at ON public.list_categories USING btree (deleted_at);


--
-- Name: idx_list_categories_list_type; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_categories_list_type ON public.list_categories USING btree (list_type);


--
-- Name: idx_list_group_roles_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_group_roles_id ON public.list_group_roles USING btree (id);


--
-- Name: idx_list_invitations_code; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_code ON public.list_invitations USING btree (invitation_code);


--
-- Name: idx_list_invitations_expiration; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_expiration ON public.list_invitations USING btree (status, expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_list_invitations_expires_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_expires_at ON public.list_invitations USING btree (expires_at);


--
-- Name: idx_list_invitations_invitee_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_invitee_id ON public.list_invitations USING btree (invitee_id);


--
-- Name: idx_list_invitations_inviter_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_inviter_id ON public.list_invitations USING btree (inviter_id);


--
-- Name: idx_list_invitations_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_list_id ON public.list_invitations USING btree (list_id);


--
-- Name: idx_list_invitations_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_invitations_status ON public.list_invitations USING btree (status);


--
-- Name: idx_list_item_categories_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_item_categories_deleted_at ON public.list_item_categories USING btree (deleted_at);


--
-- Name: idx_list_item_categories_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX idx_list_item_categories_item_id ON public.list_item_categories USING btree (item_id);


--
-- Name: idx_list_item_tags_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_item_tags_deleted_at ON public.list_item_tags USING btree (deleted_at);


--
-- Name: idx_list_items_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_deleted_at ON public.list_items USING btree (deleted_at);


--
-- Name: idx_list_items_gift_detail_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_gift_detail_id ON public.list_items USING btree (gift_detail_id);


--
-- Name: idx_list_items_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_list_id ON public.list_items USING btree (list_id);


--
-- Name: idx_list_items_owner_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_owner_id ON public.list_items USING btree (owner_id);


--
-- Name: idx_list_items_recipe_detail_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_recipe_detail_id ON public.list_items USING btree (recipe_detail_id);


--
-- Name: idx_list_items_tv_detail_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_tv_detail_id ON public.list_items USING btree (tv_detail_id);


--
-- Name: idx_list_shares_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_shares_list_id ON public.list_shares USING btree (list_id);


--
-- Name: idx_list_shares_revoked_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_shares_revoked_at ON public.list_shares USING btree (revoked_at);


--
-- Name: idx_list_shares_shared_by; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_shares_shared_by ON public.list_shares USING btree (shared_by);


--
-- Name: idx_list_shares_shared_with; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_shares_shared_with ON public.list_shares USING btree (shared_with_type, shared_with_id);


--
-- Name: idx_list_sharing_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_sharing_deleted_at ON public.list_sharing USING btree (deleted_at);


--
-- Name: idx_lists_background; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_background ON public.lists USING gin (background);


--
-- Name: idx_lists_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_deleted_at ON public.lists USING btree (deleted_at);


--
-- Name: idx_lists_event_date; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_event_date ON public.lists USING btree (event_date);


--
-- Name: idx_lists_is_event; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_is_event ON public.lists USING btree (is_event);


--
-- Name: idx_lists_list_type; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_list_type ON public.lists USING btree (list_type);


--
-- Name: idx_lists_local_image_upload_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_local_image_upload_status ON public.lists USING btree (local_image_upload_status);


--
-- Name: idx_lists_owner_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_owner_id ON public.lists USING btree (owner_id);


--
-- Name: idx_lists_sort_order; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_sort_order ON public.lists USING btree (sort_order);


--
-- Name: idx_luo_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_luo_deleted_at ON public.list_user_overrides USING btree (deleted_at);


--
-- Name: idx_luo_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_luo_list_id ON public.list_user_overrides USING btree (list_id);


--
-- Name: idx_luo_user_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_luo_user_id ON public.list_user_overrides USING btree (user_id);


--
-- Name: idx_movie_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_movie_details_list_item_id ON public.movie_details USING btree (list_item_id);


--
-- Name: idx_movie_details_rating; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_movie_details_rating ON public.movie_details USING btree (rating);


--
-- Name: idx_movie_details_release_date; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_movie_details_release_date ON public.movie_details USING btree (release_date);


--
-- Name: idx_movie_details_tmdb_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_movie_details_tmdb_id ON public.movie_details USING btree (tmdb_id);


--
-- Name: idx_notifications_actor_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_notifications_actor_id ON public.notifications USING btree (actor_id);


--
-- Name: idx_notifications_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_notifications_deleted_at ON public.notifications USING btree (deleted_at);


--
-- Name: idx_notifications_entity_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_notifications_entity_id ON public.notifications USING btree (entity_id);


--
-- Name: idx_oauth_providers_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_oauth_providers_deleted_at ON public.oauth_providers USING btree (deleted_at);


--
-- Name: idx_pending_group_invitations_connection; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_pending_group_invitations_connection ON public.pending_group_invitations USING btree (connection_invitation_id) WHERE ((status)::text = 'waiting'::text);


--
-- Name: idx_pending_group_invitations_invitee; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_pending_group_invitations_invitee ON public.pending_group_invitations USING btree (invitee_id, status);


--
-- Name: idx_permissions_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_permissions_deleted_at ON public.permissions USING btree (deleted_at);


--
-- Name: idx_place_details_google_place_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_google_place_id ON public.place_details USING btree (google_place_id);


--
-- Name: idx_place_details_lat_lon; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_lat_lon ON public.place_details USING btree (latitude, longitude);


--
-- Name: idx_place_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_list_item_id ON public.place_details USING btree (list_item_id);


--
-- Name: idx_place_details_photos; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_photos ON public.place_details USING gin (photos);


--
-- Name: idx_place_details_rating_google; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_rating_google ON public.place_details USING btree (rating_google);


--
-- Name: idx_place_details_types; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_place_details_types ON public.place_details USING gin (types);


--
-- Name: idx_recipe_details_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_recipe_details_deleted_at ON public.recipe_details USING btree (deleted_at);


--
-- Name: idx_recipe_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_recipe_details_list_item_id ON public.recipe_details USING btree (list_item_id);


--
-- Name: idx_refresh_tokens_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_refresh_tokens_deleted_at ON public.refresh_tokens USING btree (deleted_at);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_token; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_refresh_tokens_token ON public.refresh_tokens USING btree (token);


--
-- Name: idx_reviews_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_reviews_deleted_at ON public.reviews USING btree (deleted_at);


--
-- Name: idx_role_permissions_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_role_permissions_deleted_at ON public.role_permissions USING btree (deleted_at);


--
-- Name: idx_roles_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_roles_deleted_at ON public.roles USING btree (deleted_at);


--
-- Name: idx_saved_locations_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_saved_locations_deleted_at ON public.saved_locations USING btree (deleted_at);


--
-- Name: idx_spotify_item_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_spotify_item_details_list_item_id ON public.spotify_item_details USING btree (list_item_id);


--
-- Name: idx_spotify_item_details_name; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_spotify_item_details_name ON public.spotify_item_details USING btree (name);


--
-- Name: idx_spotify_item_details_spotify_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_spotify_item_details_spotify_id ON public.spotify_item_details USING btree (spotify_id);


--
-- Name: idx_spotify_item_details_spotify_item_type; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_spotify_item_details_spotify_item_type ON public.spotify_item_details USING btree (spotify_item_type);


--
-- Name: idx_spotify_item_specific_metadata_gin; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_spotify_item_specific_metadata_gin ON public.spotify_item_details USING gin (item_specific_metadata jsonb_path_ops);


--
-- Name: idx_tags_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tags_deleted_at ON public.tags USING btree (deleted_at);


--
-- Name: idx_tags_list_type_name; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tags_list_type_name ON public.tags USING btree (list_type, lower(name));


--
-- Name: idx_tv_details_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tv_details_deleted_at ON public.tv_details USING btree (deleted_at);


--
-- Name: idx_tv_details_list_item_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tv_details_list_item_id ON public.tv_details USING btree (list_item_id);


--
-- Name: idx_tv_details_tmdb_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tv_details_tmdb_id ON public.tv_details USING btree (tmdb_id);


--
-- Name: idx_user_achievements_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_achievements_deleted_at ON public.user_achievements USING btree (deleted_at);


--
-- Name: idx_user_activity_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_activity_deleted_at ON public.user_activity USING btree (deleted_at);


--
-- Name: idx_user_groups_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_groups_deleted_at ON public.user_groups USING btree (deleted_at);


--
-- Name: idx_user_integrations_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_integrations_deleted_at ON public.user_integrations USING btree (deleted_at);


--
-- Name: idx_user_oauth_connections_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_oauth_connections_deleted_at ON public.user_oauth_connections USING btree (deleted_at);


--
-- Name: idx_user_roles_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_roles_deleted_at ON public.user_roles USING btree (deleted_at);


--
-- Name: idx_user_sessions_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_sessions_deleted_at ON public.user_sessions USING btree (deleted_at);


--
-- Name: idx_user_sessions_expires_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_sessions_expires_at ON public.user_sessions USING btree (expires_at);


--
-- Name: idx_user_sessions_refresh_token; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_sessions_refresh_token ON public.user_sessions USING btree (refresh_token);


--
-- Name: idx_user_sessions_token; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_sessions_token ON public.user_sessions USING btree (token);


--
-- Name: idx_user_settings_connection_code; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_connection_code ON public.user_settings USING btree (((privacy_settings ->> 'connection_code'::text))) WHERE ((privacy_settings ->> 'connection_code'::text) IS NOT NULL);


--
-- Name: idx_user_settings_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_deleted_at ON public.user_settings USING btree (deleted_at);


--
-- Name: idx_user_settings_privacy_mode; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_privacy_mode ON public.user_settings USING btree (((privacy_settings ->> 'privacy_mode'::text)));


--
-- Name: idx_user_settings_social_networks; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_social_networks ON public.user_settings USING gin (social_networks);


--
-- Name: idx_users_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_users_deleted_at ON public.users USING btree (deleted_at);


--
-- Name: item_tags_unique_item_tag_active; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX item_tags_unique_item_tag_active ON public.item_tags USING btree (item_id, tag_id) WHERE (deleted_at IS NULL);


--
-- Name: search_embeddings_hnsw; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX search_embeddings_hnsw ON public.search_embeddings USING hnsw (embedding public.vector_l2_ops);


--
-- Name: search_embeddings_trgm; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX search_embeddings_trgm ON public.search_embeddings USING gin (raw_query public.gin_trgm_ops);


--
-- Name: tags_unique_listtype_name_ci; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX tags_unique_listtype_name_ci ON public.tags USING btree (list_type, lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text))) WHERE (deleted_at IS NULL);


--
-- Name: unique_entity_embedding; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX unique_entity_embedding ON public.embeddings USING btree (related_entity_id, entity_type);


--
-- Name: user_roles_user_id_role_id_unique; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX user_roles_user_id_role_id_unique ON public.user_roles USING btree (user_id, role_id) WHERE (deleted_at IS NULL);


--
-- Name: connections auto_accept_following; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER auto_accept_following BEFORE INSERT ON public.connections FOR EACH ROW WHEN (((new.connection_type)::text = 'following'::text)) EXECUTE FUNCTION public.handle_following_auto_accept();


--
-- Name: group_invitations enforce_connection_before_group_invite; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER enforce_connection_before_group_invite BEFORE INSERT ON public.group_invitations FOR EACH ROW EXECUTE FUNCTION public.check_connection_before_group_invite();


--
-- Name: group_invitations enforce_connection_for_group_invitation; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER enforce_connection_for_group_invitation BEFORE INSERT ON public.group_invitations FOR EACH ROW EXECUTE FUNCTION public.check_connection_before_group_invitation();


--
-- Name: connections ensure_mutual_connection; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER ensure_mutual_connection AFTER UPDATE OF status ON public.connections FOR EACH ROW WHEN ((((new.connection_type)::text = 'mutual'::text) AND ((new.status)::text = 'accepted'::text) AND ((old.status)::text <> 'accepted'::text))) EXECUTE FUNCTION public.ensure_bidirectional_connection();


--
-- Name: user_settings ensure_private_mode_defaults_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER ensure_private_mode_defaults_trigger BEFORE INSERT ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.ensure_private_mode_defaults();


--
-- Name: gift_details gift_details_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER gift_details_updated_at_trigger BEFORE UPDATE ON public.gift_details FOR EACH ROW EXECUTE FUNCTION public.update_gift_details_updated_at();


--
-- Name: connection_invitations set_connection_invitation_code; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER set_connection_invitation_code BEFORE INSERT ON public.connection_invitations FOR EACH ROW EXECUTE FUNCTION public.set_invitation_code();


--
-- Name: favorites sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.favorites FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: followers sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.followers FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: list_items sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.list_items FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: lists sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.lists FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: notifications sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: user_settings sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: users sync_log_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: collaboration_group_members sync_log_trigger_collaboration_group_members; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger_collaboration_group_members AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_group_members FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: collaboration_groups sync_log_trigger_collaboration_groups; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger_collaboration_groups AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_groups FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: connections sync_log_trigger_connections; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER sync_log_trigger_connections AFTER INSERT OR DELETE OR UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();


--
-- Name: collaboration_group_list_types trg_cglt_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_cglt_changes AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_group_list_types FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: collaboration_groups trg_collab_groups_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_collab_groups_changes AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_groups FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: collaboration_group_members trg_collaboration_group_members_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_collaboration_group_members_changes AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_group_members FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: collaboration_groups trg_collaboration_groups_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_collaboration_groups_changes AFTER INSERT OR DELETE OR UPDATE ON public.collaboration_groups FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: gift_reservations trg_gift_reservations_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_gift_reservations_changes AFTER INSERT OR DELETE OR UPDATE ON public.gift_reservations FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_group_roles trg_list_group_roles_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_group_roles_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_group_roles FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_group_user_roles trg_list_group_user_roles_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_group_user_roles_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_group_user_roles FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_invitations trg_list_invitations_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_invitations_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_invitations FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_shares trg_list_shares_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_shares_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_shares FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_sharing trg_list_sharing_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_sharing_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_sharing FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_types trg_list_types_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_types_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_types FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_user_overrides trg_list_user_overrides_changes; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_list_user_overrides_changes AFTER INSERT OR DELETE OR UPDATE ON public.list_user_overrides FOR EACH ROW EXECUTE FUNCTION public.track_changes();


--
-- Name: list_invitations trg_set_list_invitation_code; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_set_list_invitation_code BEFORE INSERT ON public.list_invitations FOR EACH ROW EXECUTE FUNCTION public.set_list_invitation_code();


--
-- Name: spotify_item_details trg_touch_spotify_item_details; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_touch_spotify_item_details BEFORE UPDATE ON public.spotify_item_details FOR EACH ROW EXECUTE FUNCTION public.touch_spotify_item_details();


--
-- Name: connections trigger_cascade_connection_removal; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trigger_cascade_connection_removal AFTER UPDATE ON public.connections FOR EACH ROW WHEN (((old.removed_at IS NULL) AND (new.removed_at IS NOT NULL))) EXECUTE FUNCTION public.cascade_connection_removal();


--
-- Name: connections trigger_process_pending_group_invitations; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trigger_process_pending_group_invitations AFTER UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION public.process_pending_group_invitations();


--
-- Name: user_settings trigger_update_user_settings_social_networks_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trigger_update_user_settings_social_networks_updated_at BEFORE UPDATE OF social_networks ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.update_user_settings_social_networks_updated_at();


--
-- Name: book_details update_book_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_book_details_updated_at BEFORE UPDATE ON public.book_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: collaboration_groups update_collaboration_groups_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_collaboration_groups_updated_at BEFORE UPDATE ON public.collaboration_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: connections update_connections_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_connections_updated_at BEFORE UPDATE ON public.connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: embedding_queue update_embedding_queue_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_embedding_queue_updated_at BEFORE UPDATE ON public.embedding_queue FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: embeddings update_embeddings_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_embeddings_updated_at BEFORE UPDATE ON public.embeddings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: favorite_categories update_favorite_categories_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_favorite_categories_updated_at BEFORE UPDATE ON public.favorite_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: favorite_notification_preferences update_favorite_notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_favorite_notification_preferences_updated_at BEFORE UPDATE ON public.favorite_notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: favorite_sharing update_favorite_sharing_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_favorite_sharing_updated_at BEFORE UPDATE ON public.favorite_sharing FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: favorites update_favorites_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_favorites_updated_at BEFORE UPDATE ON public.favorites FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: followers update_followers_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_followers_updated_at BEFORE UPDATE ON public.followers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: gift_reservations update_gift_reservations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_gift_reservations_updated_at BEFORE UPDATE ON public.gift_reservations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: invitations update_invitations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_invitations_updated_at BEFORE UPDATE ON public.invitations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_group_roles update_list_group_roles_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_group_roles_updated_at BEFORE UPDATE ON public.list_group_roles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_group_user_roles update_list_group_user_roles_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_group_user_roles_updated_at BEFORE UPDATE ON public.list_group_user_roles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_invitations update_list_invitations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_invitations_updated_at BEFORE UPDATE ON public.list_invitations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_items update_list_items_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_items_updated_at BEFORE UPDATE ON public.list_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_shares update_list_shares_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_shares_updated_at BEFORE UPDATE ON public.list_shares FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_sharing update_list_sharing_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_sharing_updated_at BEFORE UPDATE ON public.list_sharing FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_user_overrides update_list_user_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_user_overrides_updated_at BEFORE UPDATE ON public.list_user_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: lists update_lists_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_lists_updated_at BEFORE UPDATE ON public.lists FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: movie_details update_movie_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_movie_details_updated_at BEFORE UPDATE ON public.movie_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: notifications update_notifications_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: place_details update_place_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_place_details_updated_at BEFORE UPDATE ON public.place_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recipe_details update_recipe_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_recipe_details_updated_at BEFORE UPDATE ON public.recipe_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: reviews update_reviews_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_reviews_updated_at BEFORE UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: saved_locations update_saved_locations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_saved_locations_updated_at BEFORE UPDATE ON public.saved_locations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: spotify_item_details update_spotify_item_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_spotify_item_details_updated_at BEFORE UPDATE ON public.spotify_item_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tv_details update_tv_details_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_tv_details_updated_at BEFORE UPDATE ON public.tv_details FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_groups update_user_groups_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_groups_updated_at BEFORE UPDATE ON public.user_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_integrations update_user_integrations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_integrations_updated_at BEFORE UPDATE ON public.user_integrations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_oauth_connections update_user_oauth_connections_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_oauth_connections_updated_at BEFORE UPDATE ON public.user_oauth_connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_settings update_user_privacy_settings_trigger; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_privacy_settings_trigger BEFORE INSERT OR UPDATE OF privacy_settings ON public.user_settings FOR EACH ROW WHEN ((new.privacy_settings IS NOT NULL)) EXECUTE FUNCTION public.update_user_privacy_settings();


--
-- Name: user_settings update_user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: auth_logs auth_logs_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.auth_logs
    ADD CONSTRAINT auth_logs_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: book_details book_details_list_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.book_details
    ADD CONSTRAINT book_details_list_item_id_fkey FOREIGN KEY (list_item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: change_log change_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.change_log
    ADD CONSTRAINT change_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_list_types collaboration_group_list_types_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_list_types
    ADD CONSTRAINT collaboration_group_list_types_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_list_types collaboration_group_list_types_list_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_list_types
    ADD CONSTRAINT collaboration_group_list_types_list_type_id_fkey FOREIGN KEY (list_type_id) REFERENCES public.list_types(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_members collaboration_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_members collaboration_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_groups collaboration_groups_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: connection_invitations connection_invitations_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connection_invitations
    ADD CONSTRAINT connection_invitations_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: connection_invitations connection_invitations_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connection_invitations
    ADD CONSTRAINT connection_invitations_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: favorite_categories favorite_categories_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_categories
    ADD CONSTRAINT favorite_categories_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: favorite_notification_preferences favorite_notification_preferences_favorite_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_notification_preferences
    ADD CONSTRAINT favorite_notification_preferences_favorite_fk FOREIGN KEY (favorite_id) REFERENCES public.favorites(id);


--
-- Name: favorite_notification_preferences favorite_notification_preferences_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_notification_preferences
    ADD CONSTRAINT favorite_notification_preferences_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: favorite_sharing favorite_sharing_favorite_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_sharing
    ADD CONSTRAINT favorite_sharing_favorite_fk FOREIGN KEY (favorite_id) REFERENCES public.favorites(id);


--
-- Name: favorite_sharing favorite_sharing_shared_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_sharing
    ADD CONSTRAINT favorite_sharing_shared_by_fk FOREIGN KEY (shared_by_user_id) REFERENCES public.users(id);


--
-- Name: favorite_sharing favorite_sharing_shared_with_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_sharing
    ADD CONSTRAINT favorite_sharing_shared_with_group_fk FOREIGN KEY (shared_with_group_id) REFERENCES public.user_groups(id);


--
-- Name: favorite_sharing favorite_sharing_shared_with_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorite_sharing
    ADD CONSTRAINT favorite_sharing_shared_with_user_fk FOREIGN KEY (shared_with_user_id) REFERENCES public.users(id);


--
-- Name: favorites favorites_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_category_fk FOREIGN KEY (category_id) REFERENCES public.favorite_categories(id);


--
-- Name: favorites favorites_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: connections fk_connections_connection_id; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT fk_connections_connection_id FOREIGN KEY (connection_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: connections fk_connections_initiated_by; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT fk_connections_initiated_by FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: connections fk_connections_user_id; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT fk_connections_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: gift_reservations fk_gift_reservations_item; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT fk_gift_reservations_item FOREIGN KEY (item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: gift_reservations fk_gift_reservations_reserved_by; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT fk_gift_reservations_reserved_by FOREIGN KEY (reserved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gift_reservations fk_gift_reservations_reserved_for; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT fk_gift_reservations_reserved_for FOREIGN KEY (reserved_for) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: list_sharing fk_list_sharing_list_id; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT fk_list_sharing_list_id FOREIGN KEY (list_id) REFERENCES public.lists(id);


--
-- Name: lists fk_lists_list_type; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT fk_lists_list_type FOREIGN KEY (list_type) REFERENCES public.list_types(id);


--
-- Name: user_oauth_connections fk_provider; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_oauth_connections
    ADD CONSTRAINT fk_provider FOREIGN KEY (provider_id) REFERENCES public.oauth_providers(id);


--
-- Name: followers followers_followed_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.followers
    ADD CONSTRAINT followers_followed_id_fk FOREIGN KEY (followed_id) REFERENCES public.users(id);


--
-- Name: followers followers_follower_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.followers
    ADD CONSTRAINT followers_follower_id_fk FOREIGN KEY (follower_id) REFERENCES public.users(id);


--
-- Name: gift_details gift_details_list_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_details
    ADD CONSTRAINT gift_details_list_item_id_fkey FOREIGN KEY (list_item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: gift_reservations gift_reservations_item_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT gift_reservations_item_id_fk FOREIGN KEY (item_id) REFERENCES public.list_items(id);


--
-- Name: gift_reservations gift_reservations_reserved_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT gift_reservations_reserved_by_fk FOREIGN KEY (reserved_by) REFERENCES public.users(id);


--
-- Name: gift_reservations gift_reservations_reserved_for_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT gift_reservations_reserved_for_fk FOREIGN KEY (reserved_for) REFERENCES public.users(id);


--
-- Name: group_invitations group_invitations_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_invitations
    ADD CONSTRAINT group_invitations_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: group_invitations group_invitations_invitee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_invitations
    ADD CONSTRAINT group_invitations_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_invitations group_invitations_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_invitations
    ADD CONSTRAINT group_invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fk FOREIGN KEY (group_id) REFERENCES public.user_groups(id);


--
-- Name: group_members group_members_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.group_invitations(id);


--
-- Name: group_members group_members_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: invitation_sync_tracking invitation_sync_invitation_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitation_sync_tracking
    ADD CONSTRAINT invitation_sync_invitation_fk FOREIGN KEY (invitation_id) REFERENCES public.invitations(id) ON DELETE CASCADE;


--
-- Name: invitation_sync_tracking invitation_sync_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitation_sync_tracking
    ADD CONSTRAINT invitation_sync_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_accepted_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_accepted_by_fk FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invitations invitations_inviter_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_inviter_fk FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: list_items items_list_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT items_list_id_fk FOREIGN KEY (list_id) REFERENCES public.lists(id);


--
-- Name: list_items items_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT items_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: list_group_roles list_group_roles_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_roles
    ADD CONSTRAINT list_group_roles_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: list_group_roles list_group_roles_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_roles
    ADD CONSTRAINT list_group_roles_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_group_user_roles list_group_user_roles_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_user_roles
    ADD CONSTRAINT list_group_user_roles_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: list_group_user_roles list_group_user_roles_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_user_roles
    ADD CONSTRAINT list_group_user_roles_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_group_user_roles list_group_user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_group_user_roles
    ADD CONSTRAINT list_group_user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: list_invitations list_invitations_invitee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: list_invitations list_invitations_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: list_invitations list_invitations_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_invitations
    ADD CONSTRAINT list_invitations_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_item_categories list_item_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_categories
    ADD CONSTRAINT list_item_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.list_categories(id);


--
-- Name: list_item_categories list_item_categories_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_categories
    ADD CONSTRAINT list_item_categories_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.list_items(id);


--
-- Name: list_item_tags list_item_tags_item_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_tags
    ADD CONSTRAINT list_item_tags_item_id_fk FOREIGN KEY (item_id) REFERENCES public.list_items(id);


--
-- Name: list_items list_items_book_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_book_detail_id_fkey FOREIGN KEY (book_detail_id) REFERENCES public.book_details(id) ON DELETE SET NULL;


--
-- Name: list_items list_items_gift_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_gift_detail_id_fkey FOREIGN KEY (gift_detail_id) REFERENCES public.gift_details(id);


--
-- Name: list_items list_items_movie_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_movie_detail_id_fkey FOREIGN KEY (movie_detail_id) REFERENCES public.movie_details(id) ON DELETE SET NULL;


--
-- Name: list_items list_items_place_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_place_detail_id_fkey FOREIGN KEY (place_detail_id) REFERENCES public.place_details(id) ON DELETE SET NULL;


--
-- Name: list_items list_items_recipe_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_recipe_detail_id_fkey FOREIGN KEY (recipe_detail_id) REFERENCES public.recipe_details(id) ON DELETE SET NULL;


--
-- Name: list_items list_items_spotify_item_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_spotify_item_detail_id_fkey FOREIGN KEY (spotify_item_detail_id) REFERENCES public.spotify_item_details(id) ON DELETE SET NULL;


--
-- Name: list_items list_items_tv_detail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT list_items_tv_detail_id_fkey FOREIGN KEY (tv_detail_id) REFERENCES public.tv_details(id) ON DELETE SET NULL;


--
-- Name: list_shares list_shares_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_shares
    ADD CONSTRAINT list_shares_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_shares list_shares_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_shares
    ADD CONSTRAINT list_shares_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);


--
-- Name: list_shares list_shares_shared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_shares
    ADD CONSTRAINT list_shares_shared_by_fkey FOREIGN KEY (shared_by) REFERENCES public.users(id);


--
-- Name: list_sharing list_sharing_shared_with_group_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_shared_with_group_id_fk FOREIGN KEY (shared_with_group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: list_sharing list_sharing_shared_with_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_shared_with_user_id_fk FOREIGN KEY (shared_with_user_id) REFERENCES public.users(id);


--
-- Name: list_user_overrides list_user_overrides_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_user_overrides
    ADD CONSTRAINT list_user_overrides_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_user_overrides list_user_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_user_overrides
    ADD CONSTRAINT list_user_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lists lists_owner_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_owner_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: movie_details movie_details_list_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.movie_details
    ADD CONSTRAINT movie_details_list_item_id_fkey FOREIGN KEY (list_item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_actor_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: pending_group_invitations pending_group_invitations_connection_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT pending_group_invitations_connection_invitation_id_fkey FOREIGN KEY (connection_invitation_id) REFERENCES public.connection_invitations(id) ON DELETE CASCADE;


--
-- Name: pending_group_invitations pending_group_invitations_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT pending_group_invitations_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: pending_group_invitations pending_group_invitations_invitee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT pending_group_invitations_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pending_group_invitations pending_group_invitations_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.pending_group_invitations
    ADD CONSTRAINT pending_group_invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: place_details place_details_list_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.place_details
    ADD CONSTRAINT place_details_list_item_id_fkey FOREIGN KEY (list_item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_item_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_item_id_fk FOREIGN KEY (item_id) REFERENCES public.list_items(id);


--
-- Name: reviews reviews_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: role_permissions role_permissions_permission_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fk FOREIGN KEY (permission_id) REFERENCES public.permissions(id);


--
-- Name: role_permissions role_permissions_role_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: saved_locations saved_locations_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.saved_locations
    ADD CONSTRAINT saved_locations_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: spotify_item_details spotify_item_details_list_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.spotify_item_details
    ADD CONSTRAINT spotify_item_details_list_item_id_fkey FOREIGN KEY (list_item_id) REFERENCES public.list_items(id) ON DELETE CASCADE;


--
-- Name: user_achievements user_achievements_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_achievements
    ADD CONSTRAINT user_achievements_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_activity user_activity_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_activity
    ADD CONSTRAINT user_activity_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_groups user_groups_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: user_integrations user_integrations_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_integrations
    ADD CONSTRAINT user_integrations_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_oauth_connections user_oauth_connections_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_oauth_connections
    ADD CONSTRAINT user_oauth_connections_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_assigned_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_assigned_by_fk FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_role_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: user_roles user_roles_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_sessions user_sessions_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

