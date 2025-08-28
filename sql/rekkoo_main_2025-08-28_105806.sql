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
    -- Determine operation type
    IF TG_OP = 'DELETE' THEN
        change_op = 'delete';
    ELSIF TG_OP = 'INSERT' THEN
        change_op = 'create';
    ELSE
        change_op = 'update';
    END IF;
    
    -- Extract user_id and record_id based on table
    CASE TG_TABLE_NAME
        WHEN 'lists', 'list_items' THEN
            affected_user_id = COALESCE(NEW.owner_id, OLD.owner_id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'user_settings' THEN
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
            record_id_text = COALESCE(NEW.user_id::text, OLD.user_id::text);
        WHEN 'favorites', 'notifications' THEN
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'users' THEN
            affected_user_id = COALESCE(NEW.id, OLD.id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'followers' THEN
            -- Log for both follower and followed user
            IF COALESCE(NEW.follower_id, OLD.follower_id) IS NOT NULL THEN
                INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
                VALUES (
                    COALESCE(NEW.follower_id, OLD.follower_id),
                    TG_TABLE_NAME,
                    COALESCE(NEW.id::text, OLD.id::text),
                    change_op,
                    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
                );
            END IF;
            affected_user_id = COALESCE(NEW.followed_id, OLD.followed_id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        ELSE
            RETURN COALESCE(NEW, OLD);
    END CASE;
    
    -- Insert change log entry
    IF affected_user_id IS NOT NULL THEN
        INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
        VALUES (
            affected_user_id,
            TG_TABLE_NAME,
            record_id_text,
            change_op,
            CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
        );
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION public.log_table_changes() OWNER TO admin;

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
  v_owner UUID;
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

  -- Derive record identifier (supports composite keys)
  v_id := COALESCE(
    j->>'id',
    j->>'uuid',
    j->>'pk',
    CASE WHEN (j ? 'list_id') AND (j ? 'group_id') THEN (j->>'list_id') || ':' || (j->>'group_id') ELSE NULL END,
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  -- Prefer list owner if list_id is present
  v_list_id := NULLIF(j->>'list_id', '')::uuid;
  IF v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_owner FROM public.lists WHERE id = v_list_id;
  END IF;

  v_user := COALESCE(v_owner, NULLIF(j->>'user_id','')::uuid, NULLIF(j->>'owner_id','')::uuid);

  INSERT INTO change_log(table_name,record_id,operation,change_data,user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$;


ALTER FUNCTION public.track_changes() OWNER TO admin;

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
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
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
-- Name: group_members; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.group_members (
    role character varying(20) DEFAULT 'member'::character varying,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    group_id uuid,
    user_id uuid
);


ALTER TABLE public.group_members OWNER TO admin;

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
    CONSTRAINT list_group_roles_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text])))
);


ALTER TABLE public.list_group_roles OWNER TO admin;

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
    CONSTRAINT chk_one_detail_type CHECK (((((
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
END) <= 1))
);


ALTER TABLE public.list_items OWNER TO admin;

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
    CONSTRAINT list_user_overrides_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'commenter'::text, 'editor'::text, 'admin'::text, 'reserver'::text])))
);


ALTER TABLE public.list_user_overrides OWNER TO admin;

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
    privacy_settings jsonb DEFAULT '{"show_activity": true, "public_profile": false}'::jsonb,
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
-- Name: gift_reservations gift_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.gift_reservations
    ADD CONSTRAINT gift_reservations_pkey PRIMARY KEY (id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);


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
-- Name: embedding_queue unique_entity; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.embedding_queue
    ADD CONSTRAINT unique_entity UNIQUE (entity_id, entity_type);


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
-- Name: idx_change_log_table_record; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_change_log_table_record ON public.change_log USING btree (table_name, record_id);


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
-- Name: idx_gift_reservations_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_gift_reservations_deleted_at ON public.gift_reservations USING btree (deleted_at);


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
-- Name: idx_user_settings_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_deleted_at ON public.user_settings USING btree (deleted_at);


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
-- Name: spotify_item_details trg_touch_spotify_item_details; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_touch_spotify_item_details BEFORE UPDATE ON public.spotify_item_details FOR EACH ROW EXECUTE FUNCTION public.touch_spotify_item_details();


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
-- Name: list_items update_list_items_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_items_updated_at BEFORE UPDATE ON public.list_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: user_settings update_user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: group_members group_members_group_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fk FOREIGN KEY (group_id) REFERENCES public.user_groups(id);


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

