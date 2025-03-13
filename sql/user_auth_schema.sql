-- =============================================
-- Authentication Tables Schema
-- =============================================

-- Extend the users table with authentication fields
ALTER TABLE users
    ADD COLUMN email_verified BOOLEAN DEFAULT false,
    ADD COLUMN verification_token VARCHAR(255),
    ADD COLUMN verification_token_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN reset_password_token VARCHAR(255),
    ADD COLUMN reset_password_token_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN last_login_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN account_locked BOOLEAN DEFAULT false,
    ADD COLUMN failed_login_attempts INTEGER DEFAULT 0,
    ADD COLUMN lockout_until TIMESTAMP WITH TIME ZONE;

-- Create sessions table for managing user sessions
CREATE TABLE user_sessions (
                               id SERIAL PRIMARY KEY,
                               user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                               token VARCHAR(255) NOT NULL UNIQUE,
                               ip_address VARCHAR(45),
                               user_agent TEXT,
                               expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                               created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                               last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create table for OAuth providers
CREATE TABLE oauth_providers (
                                 id SERIAL PRIMARY KEY,
                                 provider_name VARCHAR(50) NOT NULL UNIQUE,
                                 is_active BOOLEAN DEFAULT true,
                                 created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create table for user OAuth connections
CREATE TABLE user_oauth_connections (
                                        id SERIAL PRIMARY KEY,
                                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                                        provider_id INTEGER NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
                                        provider_user_id VARCHAR(255) NOT NULL,
                                        access_token TEXT,
                                        refresh_token TEXT,
                                        token_expires_at TIMESTAMP WITH TIME ZONE,
                                        profile_data JSONB,
                                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                        UNIQUE(provider_id, provider_user_id)
);

-- Create table for authentication logs
CREATE TABLE auth_logs (
                           id SERIAL PRIMARY KEY,
                           user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                           event_type VARCHAR(50) NOT NULL, -- login, logout, failed_login, password_reset, etc.
                           ip_address VARCHAR(45),
                           user_agent TEXT,
                           details JSONB,
                           created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create roles table for role-based access control
CREATE TABLE roles (
                       id SERIAL PRIMARY KEY,
                       name VARCHAR(50) NOT NULL UNIQUE,
                       description TEXT,
                       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create user roles table for assigning roles to users
CREATE TABLE user_roles (
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                            assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                            assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                            PRIMARY KEY (user_id, role_id)
);

-- Create permissions table
CREATE TABLE permissions (
                             id SERIAL PRIMARY KEY,
                             name VARCHAR(100) NOT NULL UNIQUE,
                             description TEXT,
                             created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create role permissions table for assigning permissions to roles
CREATE TABLE role_permissions (
                                  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                                  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
                                  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                  PRIMARY KEY (role_id, permission_id)
);

-- Create indexes for performance
CREATE INDEX idx_user_sessions_token ON user_sessions(token);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_oauth_connections_user_id ON user_oauth_connections(user_id);
CREATE INDEX idx_auth_logs_user_id ON auth_logs(user_id);
CREATE INDEX idx_auth_logs_event_type ON auth_logs(event_type);
CREATE INDEX idx_auth_logs_created_at ON auth_logs(created_at);

-- Insert default roles
INSERT INTO roles (name, description) VALUES
                                          ('admin', 'Administrator with full system access'),
                                          ('moderator', 'Moderator with access to user content management'),
                                          ('user', 'Standard user with basic permissions');

-- Insert common permissions
INSERT INTO permissions (name, description) VALUES
                                                ('user:read', 'View user details'),
                                                ('user:update', 'Update user details'),
                                                ('user:delete', 'Delete user accounts'),
                                                ('list:create', 'Create lists'),
                                                ('list:read', 'View lists'),
                                                ('list:update', 'Update lists'),
                                                ('list:delete', 'Delete lists'),
                                                ('item:create', 'Create items'),
                                                ('item:read', 'View items'),
                                                ('item:update', 'Update items'),
                                                ('item:delete', 'Delete items'),
                                                ('admin:access', 'Access admin panel'),
                                                ('admin:manage_users', 'Manage users from admin panel'),
                                                ('admin:manage_content', 'Manage content from admin panel');

-- Assign permissions to roles
-- Admin role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT
    (SELECT id FROM roles WHERE name = 'admin'),
    id
FROM permissions;

-- Moderator role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT
    (SELECT id FROM roles WHERE name = 'moderator'),
    id
FROM permissions
WHERE name IN ('user:read', 'list:read', 'list:update', 'item:read', 'item:update', 'admin:access', 'admin:manage_content');

-- User role permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT
    (SELECT id FROM roles WHERE name = 'user'),
    id
FROM permissions
WHERE name IN ('user:read', 'user:update', 'list:create', 'list:read', 'list:update', 'list:delete', 'item:create', 'item:read', 'item:update', 'item:delete');

-- Insert common OAuth providers
INSERT INTO oauth_providers (provider_name) VALUES
                                                ('google'),
                                                ('facebook'),
                                                ('apple'),
                                                ('twitter');