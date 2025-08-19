ALTER TABLE user_settings
ADD COLUMN misc_settings JSONB DEFAULT '{}' NOT NULL;
