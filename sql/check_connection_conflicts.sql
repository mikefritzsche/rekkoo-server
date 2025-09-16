-- Check for connection conflicts
-- User IDs from the error log:
-- senderId: 1bcd0366-498a-4d6e-82a6-e880e47c808f (mikefritzsche)
-- recipientId: 9f768190-b865-477d-9fd3-428b28e3ab7d

-- Check connections table
SELECT
    'connections' as table_name,
    user_id,
    connection_id,
    status,
    connection_type,
    initiated_by,
    created_at,
    accepted_at
FROM connections
WHERE (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '9f768190-b865-477d-9fd3-428b28e3ab7d')
   OR (user_id = '9f768190-b865-477d-9fd3-428b28e3ab7d' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f');

-- Check followers table
SELECT
    'followers' as table_name,
    follower_id,
    followed_id,
    created_at
FROM followers
WHERE (follower_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND followed_id = '9f768190-b865-477d-9fd3-428b28e3ab7d')
   OR (follower_id = '9f768190-b865-477d-9fd3-428b28e3ab7d' AND followed_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f');

-- Check connection_invitations table
SELECT
    'connection_invitations' as table_name,
    sender_id,
    recipient_id,
    status,
    created_at,
    expires_at
FROM connection_invitations
WHERE (sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND recipient_id = '9f768190-b865-477d-9fd3-428b28e3ab7d')
   OR (sender_id = '9f768190-b865-477d-9fd3-428b28e3ab7d' AND recipient_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f');

-- Check user details
SELECT id, username, full_name FROM users
WHERE id IN ('1bcd0366-498a-4d6e-82a6-e880e47c808f', '9f768190-b865-477d-9fd3-428b28e3ab7d');