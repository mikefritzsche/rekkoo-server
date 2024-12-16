-- Users
-- Create
INSERT INTO users (email, username, password_hash)
VALUES ('user@example.com', 'johndoe', 'hashed_password_here');

-- Read
SELECT *
FROM users
WHERE username = 'johndoe';
SELECT email, username, created_at
FROM users
WHERE created_at > (CURRENT_DATE - INTERVAL '30 days');

-- Update
UPDATE users
SET email       = 'newemail@example.com',
    preferences = preferences || '{
      "theme": "dark"
    }'::jsonb
WHERE id = 'user_uuid_here';

-- Delete
DELETE
FROM users
WHERE id = 'user_uuid_here';

-- User Profiles
-- Create
INSERT INTO user_profiles (user_id, display_name, bio, location)
VALUES ('user_uuid_here', 'John Doe', 'Bio text here',
        ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326));

-- Read
SELECT u.username, p.*
FROM user_profiles p
         JOIN users u ON u.id = p.user_id
WHERE ST_DWithin(
              location::geography,
              ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326)::geography,
              5000 -- 5km radius
      );

-- Update
UPDATE user_profiles
SET privacy_settings = privacy_settings || '{
  "show_activity": false
}'::jsonb
WHERE user_id = 'user_uuid_here';

-- Delete
DELETE
FROM user_profiles
WHERE user_id = 'user_uuid_here';

-- List Categories
-- Create
INSERT INTO list_categories (name, description, custom_fields)
VALUES ('Movies', 'Movie watchlist',
        '{
          "fields": [
            "rating",
            "release_date",
            "genre"
          ]
        }'::jsonb);

-- Read
SELECT *
FROM list_categories
WHERE custom_fields ? 'rating' -- Categories that have rating field
ORDER BY created_at DESC;

-- Update
UPDATE list_categories
SET custom_fields = custom_fields || '{
  "required": [
    "rating"
  ]
}'::jsonb
WHERE name = 'Movies';

-- Delete
DELETE
FROM list_categories
WHERE id = 'category_uuid_here';

-- Lists
-- Create
INSERT INTO lists (user_id, category_id, title, is_public, view_type)
VALUES ('user_uuid_here', 'category_uuid_here', 'My Favorite Movies', true, 'grid');

-- Read
SELECT l.*,
       c.name                                                 as category_name,
       (SELECT COUNT(*) FROM list_items WHERE list_id = l.id) as item_count
FROM lists l
         JOIN list_categories c ON c.id = l.category_id
WHERE l.user_id = 'user_uuid_here'
  AND l.archived_at IS NULL;

-- Update
UPDATE lists
SET custom_fields = custom_fields || '{
  "theme": "dark"
}'::jsonb,
    updated_at    = CURRENT_TIMESTAMP
WHERE id = 'list_uuid_here';

-- Delete
DELETE
FROM lists
WHERE id = 'list_uuid_here';

-- List Items
-- Create
INSERT INTO list_items (list_id, title, description, priority, custom_fields)
VALUES ('list_uuid_here', 'The Dark Knight', 'Watch this weekend', 1,
        '{
          "rating": 9.0,
          "genre": "Action"
        }'::jsonb);

-- Read
SELECT i.*, array_agg(t.name) as tags
FROM list_items i
         LEFT JOIN item_tags it ON it.item_id = i.id
         LEFT JOIN tags t ON t.id = it.tag_id
WHERE i.list_id = 'list_uuid_here'
  AND i.status = 'active'
GROUP BY i.id
ORDER BY i.sort_order;

-- Update
UPDATE list_items
SET status       = 'completed',
    completed_at = CURRENT_TIMESTAMP,
    metadata     = metadata || '{
      "completion_note": "Excellent movie!"
    }'::jsonb
WHERE id = 'item_uuid_here';

-- Delete
DELETE
FROM list_items
WHERE id = 'item_uuid_here';

-- Tags
-- Create
INSERT INTO tags (name, color)
VALUES ('Must Watch', '#FF0000');

-- Read
SELECT t.*, COUNT(it.item_id) as usage_count
FROM tags t
         LEFT JOIN item_tags it ON it.tag_id = t.id
GROUP BY t.id
ORDER BY usage_count DESC;

-- Update
UPDATE tags
SET color = '#00FF00'
WHERE name = 'Must Watch';

-- Delete
DELETE
FROM tags
WHERE id = 'tag_uuid_here';

-- List Collaborators
-- Create
INSERT INTO list_collaborators (list_id, user_id, role)
VALUES ('list_uuid_here', 'user_uuid_here', 'editor');

-- Read
SELECT u.username, lc.role, lc.created_at
FROM list_collaborators lc
         JOIN users u ON u.id = lc.user_id
WHERE list_id = 'list_uuid_here';

-- Update
UPDATE list_collaborators
SET role = 'admin'
WHERE list_id = 'list_uuid_here'
  AND user_id = 'user_uuid_here';

-- Delete
DELETE
FROM list_collaborators
WHERE list_id = 'list_uuid_here'
  AND user_id = 'user_uuid_here';

-- Activity Log
-- Create
INSERT INTO activity_log (user_id, list_id, item_id, action_type, action_details)
VALUES ('user_uuid_here', 'list_uuid_here', 'item_uuid_here', 'item_completed',
        '{
          "completion_date": "2024-12-15"
        }'::jsonb);

-- Read
SELECT u.username, a.action_type, a.created_at, a.action_details
FROM activity_log a
         JOIN users u ON u.id = a.user_id
WHERE a.created_at > (CURRENT_TIMESTAMP - INTERVAL '24 hours')
ORDER BY a.created_at DESC;

-- Update (typically not needed, but possible)
UPDATE activity_log
SET action_details = action_details || '{
  "updated_note": "Additional info"
}'::jsonb
WHERE id = 'activity_uuid_here';

-- Delete
DELETE
FROM activity_log
WHERE created_at < (CURRENT_DATE - INTERVAL '90 days');

-- User Achievements
-- Create
INSERT INTO user_achievements (user_id, achievement_id)
VALUES ('user_uuid_here', 'achievement_uuid_here');

-- Read
SELECT a.name, a.description, ua.earned_at
FROM user_achievements ua
         JOIN achievements a ON a.id = ua.achievement_id
WHERE ua.user_id = 'user_uuid_here'
ORDER BY ua.earned_at DESC;

-- Update (typically not needed, but possible)
UPDATE user_achievements
SET earned_at = CURRENT_TIMESTAMP
WHERE user_id = 'user_uuid_here'
  AND achievement_id = 'achievement_uuid_here';

-- Delete
DELETE
FROM user_achievements
WHERE user_id = 'user_uuid_here'
  AND achievement_id = 'achievement_uuid_here';

-- User Streaks
-- Create
INSERT INTO user_streaks (user_id, streak_type, current_streak, last_activity_date)
VALUES ('user_uuid_here', 'daily_login', 1, CURRENT_DATE);

-- Read
SELECT streak_type, current_streak, longest_streak
FROM user_streaks
WHERE user_id = 'user_uuid_here'
  AND current_streak > 0;

-- Update
UPDATE user_streaks
SET current_streak     = current_streak + 1,
    longest_streak     = GREATEST(longest_streak, current_streak + 1),
    last_activity_date = CURRENT_DATE
WHERE user_id = 'user_uuid_here'
  AND streak_type = 'daily_login'
  AND last_activity_date = CURRENT_DATE - 1;

-- Delete
DELETE
FROM user_streaks
WHERE user_id = 'user_uuid_here';

-- Complex Queries Examples

-- Get user's lists with item counts and recent activity
SELECT l.id,
       l.title,
       c.name                                                               as category,
       COUNT(DISTINCT li.id)                                                as total_items,
       COUNT(DISTINCT CASE WHEN li.completed_at IS NOT NULL THEN li.id END) as completed_items,
       MAX(al.created_at)                                                   as last_activity,
       array_agg(DISTINCT lc.user_id)                                       as collaborator_ids
FROM lists l
         LEFT JOIN list_categories c ON c.id = l.category_id
         LEFT JOIN list_items li ON li.list_id = l.id
         LEFT JOIN activity_log al ON al.list_id = l.id
         LEFT JOIN list_collaborators lc ON lc.list_id = l.id
WHERE l.user_id = 'user_uuid_here'
  AND l.archived_at IS NULL
GROUP BY l.id, l.title, c.name
ORDER BY last_activity DESC;

-- Search across all user's items with relevance ranking
SELECT li.title,
       l.title as list_name,
       ts_rank(
               to_tsvector('english', li.title || ' ' || COALESCE(li.description, '')),
               plainto_tsquery('english', 'search_term_here')
       )       as relevance
FROM list_items li
         JOIN lists l ON l.id = li.list_id
WHERE l.user_id = 'user_uuid_here'
  AND to_tsvector('english', li.title || ' ' || COALESCE(li.description, '')) @@
      plainto_tsquery('english', 'search_term_here')
ORDER BY relevance DESC;

-- Get nearby items with distance
SELECT li.title,
       l.title as list_name,
       ST_Distance(
               li.location::geography,
               ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326)::geography
       )       as distance_meters
FROM list_items li
         JOIN lists l ON l.id = li.list_id
WHERE ST_DWithin(
              li.location::geography,
              ST_SetSRID(ST_MakePoint(-73.935242, 40.730610), 4326)::geography,
              5000 -- 5km radius
      )
ORDER BY distance_meters;
