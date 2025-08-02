-- 033_seed_status_tags.sql
-- Seeds system status-tags for each list type into public.tags.
-- Requires extension uuid-ossp (uuid_generate_v4). Run inside a transaction.

BEGIN;

INSERT INTO public.tags (id, list_type, name, tag_type, is_system)
VALUES
  -- books
  (uuid_generate_v4(), 'books',  'Read',            'status', 1),
  (uuid_generate_v4(), 'books',  'Not Read',        'status', 1),
  (uuid_generate_v4(), 'books',  'Reading',         'status', 1),
  (uuid_generate_v4(), 'books',  'Abandoned',       'status', 1),
  (uuid_generate_v4(), 'books',  'Wishlist',        'status', 1),
  (uuid_generate_v4(), 'books',  'Favorite',        'status', 1),

  -- movies
  (uuid_generate_v4(), 'movies', 'Watched',         'status', 1),
  (uuid_generate_v4(), 'movies', 'Not Watched',     'status', 1),
  (uuid_generate_v4(), 'movies', 'Watching',        'status', 1),
  (uuid_generate_v4(), 'movies', 'On Hold',         'status', 1),
  (uuid_generate_v4(), 'movies', 'Favorite',        'status', 1),

  -- music
  (uuid_generate_v4(), 'music',  'Listened',        'status', 1),
  (uuid_generate_v4(), 'music',  'Not listened To', 'status', 1),
  (uuid_generate_v4(), 'music',  'Favorite',        'status', 1),
  (uuid_generate_v4(), 'music',  'In Rotation',     'status', 1),

  -- places
  (uuid_generate_v4(), 'places', 'Visited',         'status', 1),
  (uuid_generate_v4(), 'places', 'Not Visited',     'status', 1),
  (uuid_generate_v4(), 'places', 'Planned',         'status', 1),
  (uuid_generate_v4(), 'places', 'Favorite',        'status', 1),

  -- gifts
  (uuid_generate_v4(), 'gifts',  'Bought',          'status', 1),
  (uuid_generate_v4(), 'gifts',  'Not Bought',      'status', 1),
  (uuid_generate_v4(), 'gifts',  'Received',        'status', 1),
  (uuid_generate_v4(), 'gifts',  'Wishlist',        'status', 1),

  -- recipes
  (uuid_generate_v4(), 'recipes','Planned',         'status', 1),
  (uuid_generate_v4(), 'recipes','Cooked',          'status', 1),
  (uuid_generate_v4(), 'recipes','Not Tried',       'status', 1),
  (uuid_generate_v4(), 'recipes','Favorite',        'status', 1),

  -- custom
  (uuid_generate_v4(), 'custom', 'Completed',       'status', 1),
  (uuid_generate_v4(), 'custom', 'In Progress',     'status', 1),
  (uuid_generate_v4(), 'custom', 'Not Started',     'status', 1),
  (uuid_generate_v4(), 'custom', 'Archived',        'status', 1)
ON CONFLICT DO NOTHING;

COMMIT; 