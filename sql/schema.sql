--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
-- SET transaction_timeout = 0;
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

CREATE SCHEMA IF NOT EXISTS public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


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
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


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
-- Name: followers; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.followers (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone,
    follower_id uuid,
    followed_id uuid
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
    api_metadata jsonb
);


ALTER TABLE public.list_items OWNER TO admin;

--
-- Name: list_categories; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.list_categories (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    icon character varying(50),
    description text,
    is_system boolean DEFAULT false,
    deleted_at timestamp with time zone
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

ALTER SEQUENCE public.list_categories_id_seq OWNED BY public.list_categories.id;


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
-- Name: lists; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.lists (
    title character varying(100) NOT NULL,
    description text,
    is_public boolean DEFAULT false,
    is_collaborative boolean DEFAULT false,
    occasion character varying(100),
    list_type character varying(50) NOT NULL,
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
-- Name: notifications; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.notifications (
    user_id uuid NOT NULL,
    actor_id uuid,
    notification_type character varying(50) NOT NULL,
    title character varying(255),
    body text,
    is_read boolean DEFAULT false,
    read_at timestamp with time zone,
    entity_type character varying(50),
    entity_id character varying(255), -- Can be UUID or other string IDs
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    deleted_at timestamp with time zone
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
-- Name: sync_tracking; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.sync_tracking (
    id integer NOT NULL,
    table_name character varying(50) NOT NULL,
    record_id uuid NOT NULL,
    operation character varying(10) NOT NULL,
    sync_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    sync_error text,
    last_sync_attempt timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    data jsonb
);


ALTER TABLE public.sync_tracking OWNER TO admin;

--
-- Name: sync_tracking_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.sync_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.sync_tracking_id_seq OWNER TO admin;

--
-- Name: sync_tracking_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.sync_tracking_id_seq OWNED BY public.sync_tracking.id;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.tags (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(50) NOT NULL,
    is_system boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    created_by uuid
);


ALTER TABLE public.tags OWNER TO admin;

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
    provider_id uuid
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
    user_id uuid
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
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
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
    full_name text, -- Renamed from "fullName"
    bio text
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
-- Name: list_categories id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_categories ALTER COLUMN id SET DEFAULT nextval('public.list_categories_id_seq'::regclass);


--
-- Name: oauth_providers id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.oauth_providers ALTER COLUMN id SET DEFAULT nextval('public.oauth_providers_id_seq'::regclass);


--
-- Name: sync_tracking id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.sync_tracking ALTER COLUMN id SET DEFAULT nextval('public.sync_tracking_id_seq'::regclass);


--
-- Name: auth_logs auth_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.auth_logs
    ADD CONSTRAINT auth_logs_pkey PRIMARY KEY (id);


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
-- Name: list_item_tags list_item_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--
ALTER TABLE ONLY public.list_item_tags
    ADD CONSTRAINT list_item_tags_pkey PRIMARY KEY (item_id, tag_id);

--
-- Name: list_items items_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: list_categories list_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_categories
    ADD CONSTRAINT list_categories_pkey PRIMARY KEY (id);


--
-- Name: list_sharing list_sharing_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_pkey PRIMARY KEY (id);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


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
-- Name: sync_tracking sync_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.sync_tracking
    ADD CONSTRAINT sync_tracking_pkey PRIMARY KEY (id);


--
-- Name: sync_tracking sync_tracking_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.sync_tracking
    ADD CONSTRAINT sync_tracking_unique UNIQUE (table_name, record_id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


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
-- Name: idx_list_item_tags_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_item_tags_deleted_at ON public.list_item_tags USING btree (deleted_at);


--
-- Name: idx_list_items_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_deleted_at ON public.list_items USING btree (deleted_at);


--
-- Name: idx_list_items_owner_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_owner_id ON public.list_items USING btree (owner_id);

--
-- Name: idx_list_items_list_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_items_list_id ON public.list_items USING btree (list_id);


--
-- Name: idx_list_categories_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_list_categories_deleted_at ON public.list_categories USING btree (deleted_at);


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
-- Name: idx_lists_local_image_upload_status; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_local_image_upload_status ON public.lists USING btree (local_image_upload_status);


--
-- Name: idx_lists_sort_order; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_sort_order ON public.lists USING btree (sort_order);

--
-- Name: idx_lists_owner_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_lists_owner_id ON public.lists USING btree (owner_id);


--
-- Name: idx_notifications_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_notifications_deleted_at ON public.notifications USING btree (deleted_at);


--
-- Name: idx_oauth_providers_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_oauth_providers_deleted_at ON public.oauth_providers USING btree (deleted_at);


--
-- Name: idx_permissions_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_permissions_deleted_at ON public.permissions USING btree (deleted_at);


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
-- Name: idx_sync_tracking_table_record; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_sync_tracking_table_record ON public.sync_tracking USING btree (table_name, record_id);


--
-- Name: idx_tags_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_tags_deleted_at ON public.tags USING btree (deleted_at);


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
-- Name: idx_user_sessions_token; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_sessions_token ON public.user_sessions USING btree (token);


--
-- Name: idx_user_settings_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_user_settings_deleted_at ON public.user_settings USING btree (deleted_at);


--
-- Name: idx_users_deleted_at; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_users_deleted_at ON public.users USING btree (deleted_at);


--
-- Name: gift_reservations update_gift_reservations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_gift_reservations_updated_at BEFORE UPDATE ON public.gift_reservations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_items update_list_items_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_items_updated_at BEFORE UPDATE ON public.list_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: list_sharing update_list_sharing_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_list_sharing_updated_at BEFORE UPDATE ON public.list_sharing FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: lists update_lists_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_lists_updated_at BEFORE UPDATE ON public.lists FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: reviews update_reviews_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_reviews_updated_at BEFORE UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: saved_locations update_saved_locations_updated_at; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_saved_locations_updated_at BEFORE UPDATE ON public.saved_locations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: list_sharing fk_list_sharing_list_id; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT fk_list_sharing_list_id FOREIGN KEY (list_id) REFERENCES public.lists(id);


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
-- Name: list_item_tags list_item_tags_item_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_item_tags
    ADD CONSTRAINT list_item_tags_item_id_fk FOREIGN KEY (item_id) REFERENCES public.list_items(id);

--
-- Name: list_item_tags list_item_tags_tag_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--
ALTER TABLE ONLY public.list_item_tags
    ADD CONSTRAINT list_item_tags_tag_id_fk FOREIGN KEY (tag_id) REFERENCES public.tags(id);


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
-- Name: list_sharing list_sharing_shared_with_group_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_shared_with_group_id_fk FOREIGN KEY (shared_with_group_id) REFERENCES public.user_groups(id);


--
-- Name: list_sharing list_sharing_shared_with_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.list_sharing
    ADD CONSTRAINT list_sharing_shared_with_user_id_fk FOREIGN KEY (shared_with_user_id) REFERENCES public.users(id);


--
-- Name: lists lists_owner_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_owner_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


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
-- Name: tags tags_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


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
-- Name: TRIGGER update_followers_updated_at ON followers; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_followers_updated_at BEFORE UPDATE ON public.followers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: TRIGGER update_notifications_updated_at ON notifications; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: TRIGGER update_oauth_providers_updated_at ON oauth_providers; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER update_oauth_providers_updated_at BEFORE UPDATE ON public.oauth_providers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- PostgreSQL database dump complete
--