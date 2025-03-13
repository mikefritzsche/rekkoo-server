-- Core user management tables
CREATE TABLE users
(
    id                SERIAL PRIMARY KEY,
    username          VARCHAR(50) UNIQUE  NOT NULL,
    email             VARCHAR(255) UNIQUE NOT NULL,
    password_hash     VARCHAR(255)        NOT NULL,
    profile_image_url TEXT,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_settings
(
    user_id                  INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    theme                    VARCHAR(20)              DEFAULT 'light',
    notification_preferences JSONB                    DEFAULT '{
      "email": true,
      "push": true
    }',
    privacy_settings         JSONB                    DEFAULT '{
      "public_profile": false,
      "show_activity": true
    }',
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Social features
CREATE TABLE followers
(
    id          SERIAL PRIMARY KEY,
    follower_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    followed_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (follower_id, followed_id)
);

CREATE TABLE user_groups
(
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    created_by  INTEGER      NOT NULL REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_members
(
    id        SERIAL PRIMARY KEY,
    group_id  INTEGER NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      VARCHAR(20)              DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_id, user_id)
);

-- List management
CREATE TABLE list_categories
(
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    icon        VARCHAR(50),
    description TEXT,
    is_system   BOOLEAN DEFAULT false
);

CREATE TABLE lists
(
    id               SERIAL PRIMARY KEY,
    owner_id         INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title            VARCHAR(100) NOT NULL,
    description      TEXT,
    category_id      INTEGER      REFERENCES list_categories (id) ON DELETE SET NULL,
    is_public        BOOLEAN                  DEFAULT false,
    is_collaborative BOOLEAN                  DEFAULT false,
    occasion         VARCHAR(100),
    list_type        VARCHAR(50)  NOT NULL,
    custom_fields    JSONB,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE list_sharing
(
    id                   SERIAL PRIMARY KEY,
    list_id              INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    shared_with_user_id  INTEGER REFERENCES users (id) ON DELETE CASCADE,
    shared_with_group_id INTEGER REFERENCES user_groups (id) ON DELETE CASCADE,
    permissions          VARCHAR(20)              DEFAULT 'view', -- view, edit, admin
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK ((shared_with_user_id IS NULL AND shared_with_group_id IS NOT NULL) OR
           (shared_with_user_id IS NOT NULL AND shared_with_group_id IS NULL))
);

-- Tags system
CREATE TABLE tags
(
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(50) NOT NULL,
    created_by INTEGER     REFERENCES users (id) ON DELETE SET NULL,
    is_system  BOOLEAN                  DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Item management
CREATE TABLE items
(
    id            SERIAL PRIMARY KEY,
    list_id       INTEGER      NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    description   TEXT,
    image_url     TEXT,
    link          TEXT,
    price         DECIMAL(10, 2),
    status        VARCHAR(50)              DEFAULT 'active', -- active, completed, archived
    priority      INTEGER,
    custom_fields JSONB,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE item_tags
(
    item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

-- Gift-specific features
CREATE TABLE gift_reservations
(
    id                  SERIAL PRIMARY KEY,
    item_id             INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    reserved_by         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reserved_for        INTEGER REFERENCES users (id) ON DELETE SET NULL,
    reservation_message TEXT,
    is_purchased        BOOLEAN                  DEFAULT false,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (item_id, reserved_by)
);

-- User activity and engagement
CREATE TABLE user_activity
(
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    activity_type  VARCHAR(50) NOT NULL, -- created_list, added_item, completed_item, etc.
    reference_id   INTEGER,              -- The ID of the related object (list, item, etc.)
    reference_type VARCHAR(50),          -- The type of the related object (list, item, etc.)
    metadata       JSONB,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_achievements
(
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    achievement_type VARCHAR(50) NOT NULL,
    achievement_data JSONB,
    achieved_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Reviews and ratings
CREATE TABLE reviews
(
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    item_id         INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    rating          INTEGER CHECK (rating >= 1 AND rating <= 5),
    review_text     TEXT,
    sentiment_score DECIMAL(3, 2),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, item_id)
);

-- Integration management
CREATE TABLE user_integrations
(
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    integration_type VARCHAR(50) NOT NULL, -- goodreads, letterboxd, spotify, etc.
    credentials      JSONB,
    is_active        BOOLEAN                  DEFAULT true,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, integration_type)
);

-- Notifications
CREATE TABLE notifications
(
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    notification_type VARCHAR(50)  NOT NULL,
    title             VARCHAR(100) NOT NULL,
    message           TEXT         NOT NULL,
    reference_id      INTEGER,
    reference_type    VARCHAR(50),
    is_read           BOOLEAN                  DEFAULT false,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Location-based features
CREATE TABLE saved_locations
(
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    address       TEXT,
    latitude      DECIMAL(10, 8),
    longitude     DECIMAL(11, 8),
    location_type VARCHAR(50),
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_items_list_id ON items (list_id);
CREATE INDEX idx_list_sharing_list_id ON list_sharing (list_id);
CREATE INDEX idx_list_sharing_user_id ON list_sharing (shared_with_user_id) WHERE shared_with_user_id IS NOT NULL;
CREATE INDEX idx_list_sharing_group_id ON list_sharing (shared_with_group_id) WHERE shared_with_group_id IS NOT NULL;
CREATE INDEX idx_gift_reservations_item_id ON gift_reservations (item_id);
CREATE INDEX idx_user_activity_user_id ON user_activity (user_id);
CREATE INDEX idx_notifications_user_id ON notifications (user_id);
CREATE INDEX idx_notifications_unread ON notifications (user_id, is_read) WHERE is_read = false;

CREATE TABLE refresh_tokens
(
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER                  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token      VARCHAR(255)             NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked    BOOLEAN                  DEFAULT FALSE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for faster queries
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens (token);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);