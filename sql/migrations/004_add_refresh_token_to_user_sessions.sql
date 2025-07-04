ALTER TABLE user_sessions ADD COLUMN refresh_token varchar(255);
CREATE INDEX idx_user_sessions_refresh_token ON user_sessions(refresh_token); 