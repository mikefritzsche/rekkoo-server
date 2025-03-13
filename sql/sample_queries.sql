-- =============================================
-- users table queries
-- =============================================

-- Create a new user
INSERT INTO users (username, email, password_hash)
VALUES ('johndoe', 'john@example.com', '$2a$10$somehashvalue');

-- Get user by username or email (for login)
SELECT id, username, email, password_hash
FROM users
WHERE username = 'johndoe' OR email = 'john@example.com';

-- Update user profile
UPDATE users
SET profile_image_url = 'https://example.com/images/profile123.jpg',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Search users by username (for friend suggestions)
SELECT id, username, profile_image_url
FROM users
WHERE username ILIKE '%john%'
LIMIT 10;

-- =============================================
-- user_settings table queries
-- =============================================

-- Create settings for a new user
INSERT INTO user_settings (user_id, theme, notification_preferences)
VALUES (1, 'dark', '{"email": true, "push": false}');

-- Update notification preferences
UPDATE user_settings
SET notification_preferences = jsonb_set(notification_preferences, '{push}', 'true'),
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1;

-- Get user settings
SELECT theme, notification_preferences, privacy_settings
FROM user_settings
WHERE user_id = 1;

-- =============================================
-- followers table queries
-- =============================================

-- Follow a user
INSERT INTO followers (follower_id, followed_id)
VALUES (1, 2);

-- Unfollow a user
DELETE FROM followers
WHERE follower_id = 1 AND followed_id = 2;

-- Get all users that a specific user follows
SELECT u.id, u.username, u.profile_image_url
FROM users u
         JOIN followers f ON u.id = f.followed_id
WHERE f.follower_id = 1;

-- Get all followers of a specific user
SELECT u.id, u.username, u.profile_image_url
FROM users u
         JOIN followers f ON u.id = f.follower_id
WHERE f.followed_id = 1;

-- Count total followers
SELECT COUNT(*) AS follower_count
FROM followers
WHERE followed_id = 1;

-- =============================================
-- user_groups table queries
-- =============================================

-- Create a new group
INSERT INTO user_groups (name, description, created_by)
VALUES ('Family', 'Family members for gift sharing', 1);

-- Update group details
UPDATE user_groups
SET description = 'Close family members',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Get all groups created by a user
SELECT id, name, description, created_at
FROM user_groups
WHERE created_by = 1;

-- =============================================
-- group_members table queries
-- =============================================

-- Add member to a group
INSERT INTO group_members (group_id, user_id, role)
VALUES (1, 2, 'member');

-- Change member role
UPDATE group_members
SET role = 'admin'
WHERE group_id = 1 AND user_id = 2;

-- Remove member from group
DELETE FROM group_members
WHERE group_id = 1 AND user_id = 2;

-- Get all members of a group
SELECT u.id, u.username, u.profile_image_url, gm.role, gm.joined_at
FROM users u
         JOIN group_members gm ON u.id = gm.user_id
WHERE gm.group_id = 1;

-- Get all groups a user is member of
SELECT g.id, g.name, g.description, gm.role
FROM user_groups g
         JOIN group_members gm ON g.id = gm.group_id
WHERE gm.user_id = 1;

-- =============================================
-- list_categories table queries
-- =============================================

-- Create system categories
INSERT INTO list_categories (name, icon, description, is_system)
VALUES
    ('Movies', 'film', 'Movies to watch', true),
    ('Books', 'book', 'Books to read', true),
    ('Restaurants', 'utensils', 'Restaurants to visit', true),
    ('Gifts', 'gift', 'Gift ideas', true);

-- Create custom category
INSERT INTO list_categories (name, icon, description, is_system)
VALUES ('Home Improvement', 'home', 'Home projects and ideas', false);

-- Get all categories
SELECT id, name, icon, description
FROM list_categories
ORDER BY is_system DESC, name ASC;

-- =============================================
-- lists table queries
-- =============================================

-- Create a new list
INSERT INTO lists (owner_id, title, description, category_id, is_public, list_type, custom_fields)
VALUES (1, 'Movies to Watch in 2025', 'My watchlist for next year', 1, false, 'movie',
        '{"display_mode": "grid", "sort_by": "date_added"}');

-- Create a gift list
INSERT INTO lists (owner_id, title, description, category_id, is_public, list_type, occasion)
VALUES (1, 'Birthday Wishlist', 'Things I want for my birthday', 4, true, 'gift', 'Birthday');

-- Update list details
UPDATE lists
SET title = 'Must-See Movies 2025',
    is_public = true,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Get all lists for a user
SELECT l.id, l.title, l.description, lc.name as category, l.is_public, l.created_at,
       COUNT(i.id) as item_count
FROM lists l
         JOIN list_categories lc ON l.category_id = lc.id
         LEFT JOIN items i ON l.id = i.list_id
WHERE l.owner_id = 1
GROUP BY l.id, lc.name
ORDER BY l.updated_at DESC;

-- Get public lists
SELECT l.id, l.title, l.description, u.username as owner,
       lc.name as category, COUNT(i.id) as item_count
FROM lists l
         JOIN users u ON l.owner_id = u.id
         JOIN list_categories lc ON l.category_id = lc.id
         LEFT JOIN items i ON l.id = i.list_id
WHERE l.is_public = true
GROUP BY l.id, u.username, lc.name
ORDER BY l.created_at DESC
LIMIT 20;

-- Get all gift lists for a specific occasion
SELECT id, title, description, created_at
FROM lists
WHERE list_type = 'gift' AND occasion = 'Birthday' AND owner_id = 1;

-- =============================================
-- list_sharing table queries
-- =============================================

-- Share a list with a user
INSERT INTO list_sharing (list_id, shared_with_user_id, permissions)
VALUES (1, 2, 'view');

-- Share a list with a group
INSERT INTO list_sharing (list_id, shared_with_group_id, permissions)
VALUES (1, 1, 'edit');

-- Update sharing permissions
UPDATE list_sharing
SET permissions = 'edit',
    updated_at = CURRENT_TIMESTAMP
WHERE list_id = 1 AND shared_with_user_id = 2;

-- Remove sharing
DELETE FROM list_sharing
WHERE list_id = 1 AND shared_with_user_id = 2;

-- Get all users a list is shared with
SELECT u.id, u.username, u.profile_image_url, ls.permissions
FROM users u
         JOIN list_sharing ls ON u.id = ls.shared_with_user_id
WHERE ls.list_id = 1;

-- Get all lists shared with a user
SELECT l.id, l.title, l.description, u.username as owner, ls.permissions
FROM lists l
         JOIN users u ON l.owner_id = u.id
         JOIN list_sharing ls ON l.id = ls.list_id
WHERE ls.shared_with_user_id = 2;

-- Get all lists shared with groups a user belongs to
SELECT l.id, l.title, l.description, u.username as owner,
       g.name as group_name, ls.permissions
FROM lists l
         JOIN users u ON l.owner_id = u.id
         JOIN list_sharing ls ON l.id = ls.list_id
         JOIN user_groups g ON ls.shared_with_group_id = g.id
         JOIN group_members gm ON g.id = gm.group_id
WHERE gm.user_id = 1;

-- =============================================
-- tags table queries
-- =============================================

-- Create system tags
INSERT INTO tags (name, is_system)
VALUES
    ('Favorite', true),
    ('Urgent', true),
    ('In Progress', true);

-- Create user tag
INSERT INTO tags (name, created_by)
VALUES ('Science Fiction', 1);

-- Get all tags (system + user created)
SELECT id, name, is_system
FROM tags
WHERE is_system = true OR created_by = 1
ORDER BY is_system DESC, name ASC;

-- =============================================
-- items table queries
-- =============================================

-- Add an item to a list
INSERT INTO items (list_id, title, description, image_url, link, price, status, priority)
VALUES (1, 'The Matrix Resurrections', 'Fourth installment in The Matrix series',
        'https://example.com/images/matrix.jpg', 'https://www.themoviedb.org/movie/624860',
        NULL, 'active', 2);

-- Add a gift item to a list
INSERT INTO items (list_id, title, description, image_url, link, price, custom_fields)
VALUES (2, 'Sony WH-1000XM5 Headphones', 'Noise cancelling headphones',
        'https://example.com/images/headphones.jpg', 'https://www.amazon.com/dp/B09XS7JWHH',
        349.99, '{"color": "Black", "condition": "New", "importance": "High"}');

-- Update item status
UPDATE items
SET status = 'completed',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Update item details
UPDATE items
SET description = 'Updated description',
    price = 299.99,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Delete an item
DELETE FROM items WHERE id = 1;

-- Get all items in a list
SELECT id, title, description, image_url, link, price, status, priority, created_at
FROM items
WHERE list_id = 1
ORDER BY
    CASE WHEN status = 'active' THEN 0
         WHEN status = 'in_progress' THEN 1
         WHEN status = 'completed' THEN 2
         ELSE 3
        END,
    COALESCE(priority, 999),
    created_at DESC;

-- Search for items across all user's lists
SELECT i.id, i.title, i.description, i.status, l.title as list_title
FROM items i
         JOIN lists l ON i.list_id = l.id
WHERE l.owner_id = 1 AND i.title ILIKE '%matrix%';

-- Get completed items count
SELECT COUNT(*) as completed_count
FROM items
WHERE list_id = 1 AND status = 'completed';

-- =============================================
-- item_tags table queries
-- =============================================

-- Tag an item
INSERT INTO item_tags (item_id, tag_id)
VALUES (1, 1);

-- Remove a tag from an item
DELETE FROM item_tags
WHERE item_id = 1 AND tag_id = 1;

-- Get all tags for an item
SELECT t.id, t.name
FROM tags t
         JOIN item_tags it ON t.id = it.tag_id
WHERE it.item_id = 1;

-- Get all items with a specific tag
SELECT i.id, i.title, i.description, l.title as list_title
FROM items i
         JOIN item_tags it ON i.id = it.item_id
         JOIN lists l ON i.list_id = l.id
WHERE it.tag_id = 1 AND (l.owner_id = 1 OR l.is_public = true);

-- =============================================
-- gift_reservations table queries
-- =============================================

-- Reserve a gift
INSERT INTO gift_reservations (item_id, reserved_by, reserved_for, reservation_message)
VALUES (1, 2, 1, 'I'll get this for your birthday!');

-- Mark a gift as purchased
UPDATE gift_reservations
SET is_purchased = true,
    updated_at = CURRENT_TIMESTAMP
WHERE item_id = 1 AND reserved_by = 2;

-- Cancel a reservation
DELETE FROM gift_reservations
WHERE item_id = 1 AND reserved_by = 2;

-- Check if an item is reserved
SELECT COUNT(*) > 0 as is_reserved
FROM gift_reservations
WHERE item_id = 1;

-- Check if user has reserved an item
SELECT id, reservation_message, is_purchased, created_at
FROM gift_reservations
WHERE item_id = 1 AND reserved_by = 2;

-- Get all gifts reserved by a user
SELECT i.id, i.title, i.description, i.image_url, i.price,
       gr.is_purchased, gr.created_at as reserved_at,
       l.title as list_title, u.username as list_owner
FROM gift_reservations gr
JOIN items i ON gr.item_id = i.id
JOIN lists l ON i.list_id = l.id
JOIN users u ON l.owner_id = u.id
WHERE gr.reserved_by = 2;

-- Query for list owner to see reservation status (without revealing who reserved)
SELECT i.id, i.title,
       CASE WHEN EXISTS (SELECT 1 FROM gift_reservations WHERE item_id = i.id)
            THEN true ELSE false
       END as is_reserved
FROM items i
WHERE i.list_id = 1;

-- =============================================
-- user_activity table queries
-- =============================================

-- Record a new activity
INSERT INTO user_activity (user_id, activity_type, reference_id, reference_type, metadata)
VALUES (1, 'created_list', 1, 'list', '{"title": "Movies to Watch"}');

-- Record item completion activity
INSERT INTO user_activity (user_id, activity_type, reference_id, reference_type, metadata)
VALUES (1, 'completed_item', 1, 'item', '{"item_title": "The Matrix", "list_id": 1}');

-- Get activity feed for a user
SELECT ua.activity_type, ua.reference_id, ua.reference_type, ua.metadata, ua.created_at,
       u.username, u.profile_image_url
FROM user_activity ua
JOIN users u ON ua.user_id = u.id
WHERE ua.user_id = 1
ORDER BY ua.created_at DESC
LIMIT 20;

-- Get activity feed from followed users
SELECT ua.activity_type, ua.reference_id, ua.reference_type, ua.metadata, ua.created_at,
       u.username, u.profile_image_url
FROM user_activity ua
JOIN users u ON ua.user_id = u.id
JOIN followers f ON ua.user_id = f.followed_id
WHERE f.follower_id = 1
ORDER BY ua.created_at DESC
LIMIT 50;

-- =============================================
-- user_achievements table queries
-- =============================================

-- Record a new achievement
INSERT INTO user_achievements (user_id, achievement_type, achievement_data)
VALUES (1, 'list_master', '{"completed_lists": 10, "badge": "gold"}');

-- Get all achievements for a user
SELECT achievement_type, achievement_data, achieved_at
FROM user_achievements
WHERE user_id = 1
ORDER BY achieved_at DESC;

-- Count achievements by type
SELECT achievement_type, COUNT(*)
FROM user_achievements
WHERE user_id = 1
GROUP BY achievement_type;

-- =============================================
-- reviews table queries
-- =============================================

-- Add a review
INSERT INTO reviews (user_id, item_id, rating, review_text)
VALUES (1, 1, 5, 'Great movie, highly recommended!');

-- Update a review
UPDATE reviews
SET rating = 4,
    review_text = 'Good but not great.',
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1 AND item_id = 1;

-- Get average rating for an item
SELECT AVG(rating) as average_rating, COUNT(*) as review_count
FROM reviews
WHERE item_id = 1;

-- Get all reviews for an item
SELECT r.rating, r.review_text, r.created_at,
       u.username, u.profile_image_url
FROM reviews r
JOIN users u ON r.user_id = u.id
WHERE r.item_id = 1
ORDER BY r.created_at DESC;

-- Get all reviews by a user
SELECT r.rating, r.review_text, r.created_at,
       i.title as item_title, l.title as list_title
FROM reviews r
JOIN items i ON r.item_id = i.id
JOIN lists l ON i.list_id = l.id
WHERE r.user_id = 1
ORDER BY r.created_at DESC;

-- Update sentiment score (would typically be done by backend service)
UPDATE reviews
SET sentiment_score = 0.85
WHERE id = 1;

-- =============================================
-- user_integrations table queries
-- =============================================

-- Add a new integration
INSERT INTO user_integrations (user_id, integration_type, credentials)
VALUES (1, 'goodreads', '{"access_token": "abc123", "refresh_token": "xyz789"}');

-- Update integration credentials
UPDATE user_integrations
SET credentials = jsonb_set(credentials, '{access_token}', '"new_token_here"'),
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1 AND integration_type = 'goodreads';

-- Deactivate an integration
UPDATE user_integrations
SET is_active = false,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1 AND integration_type = 'goodreads';

-- Get all active integrations for a user
SELECT integration_type, credentials, created_at
FROM user_integrations
WHERE user_id = 1 AND is_active = true;

-- =============================================
-- notifications table queries
-- =============================================

-- Create a notification
INSERT INTO notifications (user_id, notification_type, title, message, reference_id, reference_type)
VALUES (1, 'list_shared', 'New List Shared', 'John shared a movie list with you', 1, 'list');

-- Mark notification as read
UPDATE notifications
SET is_read = true
WHERE id = 1;

-- Mark all notifications as read
UPDATE notifications
SET is_read = true
WHERE user_id = 1 AND is_read = false;

-- Get unread notifications count
SELECT COUNT(*) as unread_count
FROM notifications
WHERE user_id = 1 AND is_read = false;

-- Get recent notifications
SELECT id, notification_type, title, message, reference_id, reference_type, is_read, created_at
FROM notifications
WHERE user_id = 1
ORDER BY created_at DESC
LIMIT 20;

-- Delete old notifications
DELETE FROM notifications
WHERE user_id = 1 AND created_at < (CURRENT_TIMESTAMP - INTERVAL '30 days');

-- =============================================
-- saved_locations table queries
-- =============================================

-- Save a new location
INSERT INTO saved_locations (user_id, name, address, latitude, longitude, location_type)
VALUES (1, 'Favorite Restaurant', '123 Main St, City', 40.7128, -74.0060, 'restaurant');

-- Update location details
UPDATE saved_locations
SET name = 'Best Italian Restaurant',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Delete a saved location
DELETE FROM saved_locations WHERE id = 1;

-- Get all saved locations for a user
SELECT id, name, address, latitude, longitude, location_type, created_at
FROM saved_locations
WHERE user_id = 1;

-- Get nearby saved locations (within ~5km/3mi radius)
SELECT id, name, address, location_type,
       -- Calculate distance in kilometers using the Haversine formula
       111.111 *
       DEGREES(ACOS(COS(RADIANS(40.7128)) *
                    COS(RADIANS(latitude)) *
                    COS(RADIANS(-74.0060) - RADIANS(longitude)) +
                    SIN(RADIANS(40.7128)) *
                    SIN(RADIANS(latitude)))) AS distance
FROM saved_locations
WHERE user_id = 1
HAVING distance < 5 -- 5km radius
ORDER BY distance;

-- =============================================
-- Complex queries combining multiple tables
-- =============================================

-- Get gift recommendations based on user's lists
SELECT i.title, i.description, i.image_url, i.price, l.title as list_title
FROM items i
JOIN lists l ON i.list_id = l.id
WHERE l.is_public = true
  AND l.list_type = 'gift'
  AND l.owner_id IN (
      SELECT followed_id FROM followers WHERE follower_id = 1
  )
  AND NOT EXISTS (
      SELECT 1 FROM gift_reservations gr WHERE gr.item_id = i.id
  )
LIMIT 10;

-- Get activity statistics for a user
SELECT
    COUNT(DISTINCT CASE WHEN activity_type = 'created_list' THEN reference_id END) as lists_created,
    COUNT(DISTINCT CASE WHEN activity_type = 'added_item' THEN reference_id END) as items_added,
    COUNT(DISTINCT CASE WHEN activity_type = 'completed_item' THEN reference_id END) as items_completed
FROM user_activity
WHERE user_id = 1
  AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days';

-- Get popular items across all public lists
SELECT i.title, i.description, COUNT(r.id) as review_count, AVG(r.rating) as avg_rating
FROM items i
         JOIN lists l ON i.list_id = l.id
         LEFT JOIN reviews r ON i.id = r.item_id
WHERE l.is_public = true
GROUP BY i.id
HAVING COUNT(r.id) > 0
ORDER BY avg_rating DESC, review_count DESC
LIMIT 20;

-- Get collaborative activity on a shared list
SELECT ua.created_at, ua.activity_type, ua.metadata, u.username
FROM user_activity ua
         JOIN users u ON ua.user_id = u.id
WHERE ua.reference_type = 'list'
  AND ua.reference_id = 1
  AND ua.user_id IN (
    SELECT shared_with_user_id
    FROM list_sharing
    WHERE list_id = 1 AND shared_with_user_id IS NOT NULL
    UNION
    SELECT gm.user_id
    FROM list_sharing ls
             JOIN group_members gm ON ls.shared_with_group_id = gm.group_id
    WHERE ls.list_id = 1 AND ls.shared_with_group_id IS NOT NULL
)
ORDER BY ua.created_at DESC;