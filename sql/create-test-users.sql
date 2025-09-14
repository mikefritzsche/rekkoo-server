-- Create Test Users for Connection API Testing
-- Run this if you need test users for the API testing scripts

-- Note: Adjust the password hashing method based on your auth system
-- This example assumes bcrypt with a cost factor of 10

-- Test User 1
INSERT INTO users (
    id,
    username,
    email,
    password,
    full_name,
    created_at,
    email_verified,
    is_active
) VALUES (
    gen_random_uuid(),
    'testuser1',
    'testuser1@example.com',
    -- Password: 'TestPass123!' (you need to hash this with your auth system)
    -- Example bcrypt hash: $2b$10$... (generate with your backend)
    '$2b$10$YourHashedPasswordHere',  -- REPLACE with actual hash
    'Test User One',
    NOW(),
    true,
    true
) ON CONFLICT (email) DO NOTHING;

-- Test User 2
INSERT INTO users (
    id,
    username,
    email,
    password,
    full_name,
    created_at,
    email_verified,
    is_active
) VALUES (
    gen_random_uuid(),
    'testuser2',
    'testuser2@example.com',
    -- Password: 'TestPass123!' (you need to hash this with your auth system)
    '$2b$10$YourHashedPasswordHere',  -- REPLACE with actual hash
    'Test User Two',
    NOW(),
    true,
    true
) ON CONFLICT (email) DO NOTHING;

-- Test User 3 (for testing connections between multiple users)
INSERT INTO users (
    id,
    username,
    email,
    password,
    full_name,
    created_at,
    email_verified,
    is_active
) VALUES (
    gen_random_uuid(),
    'testuser3',
    'testuser3@example.com',
    '$2b$10$YourHashedPasswordHere',  -- REPLACE with actual hash
    'Test User Three',
    NOW(),
    true,
    true
) ON CONFLICT (email) DO NOTHING;

-- Show the created users
SELECT id, username, email, full_name
FROM users
WHERE email IN ('testuser1@example.com', 'testuser2@example.com', 'testuser3@example.com');

-- To generate bcrypt hashes, you can use Node.js:
-- const bcrypt = require('bcrypt');
-- const hash = await bcrypt.hash('TestPass123!', 10);
-- console.log(hash);

-- Or use an online bcrypt generator (for testing only, not production!)
-- https://bcrypt-generator.com/