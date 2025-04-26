-- First, drop the existing foreign key constraint
ALTER TABLE user_settings DROP CONSTRAINT user_settings_user_id_fkey;

-- Change the user_id column type to UUID
ALTER TABLE user_settings ALTER COLUMN user_id TYPE UUID USING user_id::text::uuid;

-- Add back the foreign key constraint to reference the users table's UUID id
ALTER TABLE user_settings ADD CONSTRAINT user_settings_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE; 