-- Reset connection request history for User A to User B to allow testing
-- This will clear the rate limiting block

-- User A: 1bcd0366-498a-4d6e-82a6-e880e47c808f (mike@mikefritzsche.com)
-- User B: 0320693e-043b-4750-92b4-742e298a5f7f (demo1@mikefritzsche.com)

-- Check current state first
SELECT '=== BEFORE RESET ===' as info;

-- Check if User A can send requests now
SELECT
    can_send,
    reason,
    attempt_count,
    declined_count,
    retry_after
FROM can_send_connection_request(
    '1bcd0366-498a-4d6e-82a6-e880e47c808f',
    '0320693e-043b-4750-92b4-742e298a5f7f'
);

-- Show current history
SELECT
    total_attempts,
    declined_count,
    accepted_count,
    is_soft_blocked,
    last_attempt_at,
    last_declined_at
FROM connection_request_history
WHERE sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'
AND recipient_id = '0320693e-043b-4750-92b4-742e298a5f7f';

SELECT '=== RESETTING HISTORY ===' as info;

-- Reset the connection request history for this pair
UPDATE connection_request_history
SET
    total_attempts = 0,
    declined_count = 0,
    accepted_count = 0,
    is_soft_blocked = false,
    last_attempt_at = NULL,
    last_declined_at = NULL,
    last_accepted_at = NULL,
    updated_at = NOW()
WHERE sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'
AND recipient_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- If no record exists, insert one with zero counts
INSERT INTO connection_request_history (
    sender_id,
    recipient_id,
    total_attempts,
    declined_count,
    accepted_count,
    is_soft_blocked,
    created_at,
    updated_at
)
SELECT
    '1bcd0366-498a-4d6e-82a6-e880e47c808f',
    '0320693e-043b-4750-92b4-742e298a5f7f',
    0,
    0,
    0,
    false,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM connection_request_history
    WHERE sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'
    AND recipient_id = '0320693e-043b-4750-92b4-742e298a5f7f'
);

SELECT '=== AFTER RESET ===' as info;

-- Verify the reset worked
SELECT
    can_send,
    reason,
    attempt_count,
    declined_count,
    retry_after
FROM can_send_connection_request(
    '1bcd0366-498a-4d6e-82a6-e880e47c808f',
    '0320693e-043b-4750-92b4-742e298a5f7f'
);

-- Show updated history
SELECT
    total_attempts,
    declined_count,
    accepted_count,
    is_soft_blocked,
    last_attempt_at,
    last_declined_at
FROM connection_request_history
WHERE sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'
AND recipient_id = '0320693e-043b-4750-92b4-742e298a5f7f';

SELECT '=== RESET COMPLETE ===' as info;