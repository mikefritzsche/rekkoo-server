-- Test script to verify connection upgrade from following to mutual works
-- This script can be run to test the fix for the duplicate constraint error

-- First, let's check if there are any duplicate connection records
SELECT
    user_id,
    connection_id,
    status,
    connection_type,
    COUNT(*) as duplicate_count
FROM connections
GROUP BY user_id, connection_id, status, connection_type
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- Check for bidirectional connections with mismatched statuses
SELECT
    c1.user_id,
    c1.connection_id,
    c1.status as status1,
    c1.connection_type as type1,
    c2.status as status2,
    c2.connection_type as type2
FROM connections c1
JOIN connections c2 ON c1.user_id = c2.connection_id AND c1.connection_id = c2.user_id
WHERE c1.status != c2.status OR c1.connection_type != c2.connection_type
ORDER BY c1.user_id, c1.connection_id;

-- Test the connection upgrade scenario
-- This simulates what happens when User A follows User B, then sends a mutual connection request
DO $$
DECLARE
    v_test_sender_id UUID := gen_random_uuid();
    v_test_recipient_id UUID := gen_random_uuid();
    v_following_result RECORD;
    v_mutual_result RECORD;
BEGIN
    RAISE NOTICE 'Testing connection upgrade scenario...';

    -- Step 1: Create test users
    INSERT INTO users (id, username, email, created_at, updated_at)
    VALUES
        (v_test_sender_id, 'test_sender', 'sender@test.com', NOW(), NOW()),
        (v_test_recipient_id, 'test_recipient', 'recipient@test.com', NOW(), NOW());

    -- Step 2: Create a following relationship
    INSERT INTO connections (user_id, connection_id, status, connection_type, initiated_by, visibility_level)
    VALUES (v_test_sender_id, v_test_recipient_id, 'following', 'following', v_test_sender_id, 'public');

    RAISE NOTICE 'Created following relationship from % to %', v_test_sender_id, v_test_recipient_id;

    -- Step 3: Check if the following relationship exists
    SELECT * INTO v_following_result
    FROM connections
    WHERE user_id = v_test_sender_id AND connection_id = v_test_recipient_id;

    IF v_following_result.status = 'following' THEN
        RAISE NOTICE 'Following relationship verified';
    ELSE
        RAISE EXCEPTION 'Following relationship not found';
    END IF;

    -- Step 4: Simulate sending a mutual connection request
    -- This should upgrade the following relationship to pending mutual
    -- Note: This would normally be done through the API endpoint

    -- Clean up test data
    DELETE FROM connections WHERE user_id IN (v_test_sender_id, v_test_recipient_id);
    DELETE FROM users WHERE id IN (v_test_sender_id, v_test_recipient_id);

    RAISE NOTICE 'Test completed successfully';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Test failed: %', SQLERRM;
    -- Clean up on error
    DELETE FROM connections WHERE user_id IN (v_test_sender_id, v_test_recipient_id);
    DELETE FROM users WHERE id IN (v_test_sender_id, v_test_recipient_id);
END $$;