-- Create a test list for Phase 3 testing
-- Run this in your SQL client to create a list for testing the sharing endpoints

-- Replace this with your actual user ID from the users table
-- You can find it by running: SELECT id, username FROM users WHERE username = 'your-username';
DO $$
DECLARE
    v_user_id UUID;
    v_list_id UUID;
BEGIN
    -- Get the first user (or specify a specific user)
    -- Modify this query to match your user
    SELECT id INTO v_user_id
    FROM users
    LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE NOTICE 'No users found in database';
        RETURN;
    END IF;

    -- Generate a new list ID
    v_list_id := uuid_generate_v4();

    -- Create a test list
    INSERT INTO lists (
        id,
        title,
        description,
        list_type,
        is_public,
        is_collaborative,
        owner_id,
        created_at,
        updated_at
    ) VALUES (
        v_list_id,
        'Phase 3 Test List',
        'Testing list sharing functionality',
        'custom',
        false,
        true,
        v_user_id,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    );

    RAISE NOTICE 'Created test list:';
    RAISE NOTICE '  List ID: %', v_list_id;
    RAISE NOTICE '  Owner ID: %', v_user_id;
    RAISE NOTICE '';
    RAISE NOTICE 'You can now test the list sharing endpoints with this list ID:';
    RAISE NOTICE '  GET /v1.0/lists/%/permissions', v_list_id;
    RAISE NOTICE '  GET /v1.0/lists/%/collaborators', v_list_id;
    RAISE NOTICE '  POST /v1.0/lists/%/invitations', v_list_id;
    RAISE NOTICE '  GET /v1.0/lists/%/shares', v_list_id;
END $$;

-- Verify the list was created
SELECT
    l.id,
    l.title,
    l.owner_id,
    u.username as owner_username,
    l.created_at
FROM lists l
JOIN users u ON u.id = l.owner_id
WHERE l.title = 'Phase 3 Test List'
ORDER BY l.created_at DESC
LIMIT 1;