-- Enable necessary extensions
CREATE
EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE
EXTENSION IF NOT EXISTS "postgis";
CREATE
EXTENSION IF NOT EXISTS "pg_trgm";

-- Core user management
CREATE TABLE users
(
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    username      VARCHAR(50) UNIQUE  NOT NULL,
    password_hash VARCHAR(255)        NOT NULL,
    created_at    TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    last_login    TIMESTAMPTZ,
    is_active     BOOLEAN          DEFAULT true,
    preferences   JSONB            DEFAULT '{}'::jsonb
);

-- User profile and settings
CREATE TABLE user_profiles
(
    user_id               UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    display_name          VARCHAR(100),
    avatar_url            TEXT,
    bio                   TEXT,
    location              GEOGRAPHY(POINT),
    timezone              VARCHAR(50),
    privacy_settings      JSONB DEFAULT '{}'::jsonb,
    notification_settings JSONB DEFAULT '{}'::jsonb
);

-- List categories (predefined and custom)
CREATE TABLE list_categories
(
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(100) NOT NULL,
    description   TEXT,
    icon_name     VARCHAR(50),
    is_system     BOOLEAN          DEFAULT false,
    custom_fields JSONB            DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP
);

-- Main lists table
CREATE TABLE lists
(
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        UUID REFERENCES users (id) ON DELETE CASCADE,
    category_id    UUID REFERENCES list_categories (id),
    parent_list_id UUID REFERENCES lists (id),
    title          VARCHAR(255) NOT NULL,
    description    TEXT,
    is_public      BOOLEAN          DEFAULT false,
    view_type      VARCHAR(20)      DEFAULT 'list',
    custom_fields  JSONB            DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    archived_at    TIMESTAMPTZ,
    sort_order     INTEGER,
    CONSTRAINT valid_view_type CHECK (view_type IN ('list', 'grid', 'kanban', 'calendar'))
);

-- List items
CREATE TABLE list_items
(
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    list_id       UUID REFERENCES lists (id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    description   TEXT,
    custom_fields JSONB            DEFAULT '{}'::jsonb,
    metadata      JSONB            DEFAULT '{}'::jsonb,
    status        VARCHAR(50)      DEFAULT 'active',
    priority      INTEGER,
    due_date      TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    sort_order    INTEGER,
    location      GEOGRAPHY(POINT)
);

-- Tags system
CREATE TABLE tags
(
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(100) NOT NULL,
    color      VARCHAR(7),
    created_at TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (name)
);

-- Item-Tag relationship
CREATE TABLE item_tags
(
    item_id    UUID REFERENCES list_items (id) ON DELETE CASCADE,
    tag_id     UUID REFERENCES tags (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (item_id, tag_id)
);

-- Social features
CREATE TABLE follows
(
    follower_id UUID REFERENCES users (id) ON DELETE CASCADE,
    followed_id UUID REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, followed_id)
);

-- List sharing and collaboration
CREATE TABLE list_collaborators
(
    list_id    UUID REFERENCES lists (id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users (id) ON DELETE CASCADE,
    role       VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (list_id, user_id),
    CONSTRAINT valid_role CHECK (role IN ('viewer', 'editor', 'admin'))
);

-- Activity tracking
CREATE TABLE activity_log
(
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        UUID        REFERENCES users (id) ON DELETE SET NULL,
    list_id        UUID        REFERENCES lists (id) ON DELETE SET NULL,
    item_id        UUID        REFERENCES list_items (id) ON DELETE SET NULL,
    action_type    VARCHAR(50) NOT NULL,
    action_details JSONB            DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP
);

-- Achievements and gamification
CREATE TABLE achievements
(
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    criteria    JSONB        NOT NULL,
    points      INTEGER          DEFAULT 0,
    icon_url    TEXT
);

CREATE TABLE user_achievements
(
    user_id        UUID REFERENCES users (id) ON DELETE CASCADE,
    achievement_id UUID REFERENCES achievements (id) ON DELETE CASCADE,
    earned_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, achievement_id)
);

-- Streaks and challenges
CREATE TABLE user_streaks
(
    user_id            UUID REFERENCES users (id) ON DELETE CASCADE,
    streak_type        VARCHAR(50) NOT NULL,
    current_streak     INTEGER DEFAULT 0,
    longest_streak     INTEGER DEFAULT 0,
    last_activity_date DATE,
    PRIMARY KEY (user_id, streak_type)
);

-- Integration settings
CREATE TABLE user_integrations
(
    user_id      UUID REFERENCES users (id) ON DELETE CASCADE,
    service_name VARCHAR(50) NOT NULL,
    credentials  JSONB   DEFAULT '{}'::jsonb,
    settings     JSONB   DEFAULT '{}'::jsonb,
    last_sync    TIMESTAMPTZ,
    is_active    BOOLEAN DEFAULT true,
    PRIMARY KEY (user_id, service_name)
);

-- Saved searches
CREATE TABLE saved_searches
(
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users (id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    search_criteria JSONB        NOT NULL,
    created_at      TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP
);

-- Content enrichment cache
CREATE TABLE content_metadata_cache
(
    item_id      UUID REFERENCES list_items (id) ON DELETE CASCADE,
    source       VARCHAR(50) NOT NULL,
    metadata     JSONB       NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (item_id, source)
);

-- Indexes for performance
CREATE INDEX idx_list_items_list_id ON list_items (list_id);
CREATE INDEX idx_list_items_status ON list_items (status);
CREATE INDEX idx_list_items_location ON list_items USING GIST(location);
CREATE INDEX idx_lists_user_id ON lists (user_id);
CREATE INDEX idx_activity_log_user_id ON activity_log (user_id);
CREATE INDEX idx_activity_log_created_at ON activity_log (created_at);
CREATE INDEX idx_list_items_custom_fields ON list_items USING gin(custom_fields);
CREATE INDEX idx_item_tags_tag_id ON item_tags (tag_id);
CREATE INDEX idx_lists_archived_at ON lists (archived_at);
CREATE INDEX idx_list_items_title_trgm ON list_items USING gin(title gin_trgm_ops);

-- Full-text search
CREATE INDEX idx_list_items_fts ON list_items
    USING gin(to_tsvector('english', title || ' ' || COALESCE (description, '')));
