-- 026_create_list_types_and_group_mapping.sql
-- Adds list_types reference table, seeds default list type rows, creates
-- collaboration_group_list_types join table, and wires both tables into
-- the generic track_changes() audit system used for sync.

-- 1. Safeguard: ensure track_changes() exists (created in 020_create_track_changes_function.sql)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

-- 2. list_types reference table -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.list_types (
  id           TEXT PRIMARY KEY,                       -- e.g. 'books', 'movies'
  label        TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,                                   -- icon name for client render
  gradient     TEXT[] DEFAULT ARRAY[]::TEXT[],         -- hex colour strings
  icon_color   TEXT DEFAULT '#FFFFFF',
  created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  deleted_at   TIMESTAMPTZ
);

-- 3. Seed default list-type rows (idempotent)
INSERT INTO public.list_types (id, label, description, icon, gradient, icon_color)
VALUES
  ('books',   'Books',      'Create a list of your favorite books or reading list',                 'book',          ARRAY['#6a11cb', '#2575fc'], '#ffffff'),
  ('movies',  'Movies/TV',  'Build a watchlist or collection of films and shows',                   'movie',         ARRAY['#ff416c', '#ff4b2b'], '#ffffff'),
  ('music',   'Music',      'Compile your favorite songs and artists',                              'music-note',    ARRAY['#1d976c', '#93f9b9'], '#ffffff'),
  ('places',  'Places',     'Create a list of your favorite places',                                'place',         ARRAY['#4facfe', '#00f2fe'], '#ffffff'),
  ('gifts',   'Gifts',      'Create a list of gifts',                                               'card-giftcard', ARRAY['#f857a6', '#ff5858'], '#ffffff'),
  ('recipes', 'Recipes',    'Create a list of recipes',                                             'restaurant-menu',ARRAY['#ff7a00', '#ffbb00'], '#ffffff'),
  ('custom',  'Custom',     'Create a custom list of anything you want',                           'edit',          ARRAY['#8e2de2', '#4a00e0'], '#ffffff')
ON CONFLICT (id) DO NOTHING;

-- 4. collaboration_group_list_types join table ----------------------------------
CREATE TABLE IF NOT EXISTS public.collaboration_group_list_types (
  group_id     UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
  list_type_id TEXT NOT NULL REFERENCES public.list_types(id)           ON DELETE CASCADE,
  PRIMARY KEY (group_id, list_type_id),
  created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Helpful indices for common filtering directions
CREATE INDEX IF NOT EXISTS idx_cglt_group_id     ON public.collaboration_group_list_types(group_id);
CREATE INDEX IF NOT EXISTS idx_cglt_list_type_id ON public.collaboration_group_list_types(list_type_id);

-- 5. Triggers to log changes for sync ------------------------------------------
-- Drop first to avoid duplicates on re-run
DROP TRIGGER IF EXISTS trg_list_types_changes              ON public.list_types;
DROP TRIGGER IF EXISTS trg_cglt_changes                    ON public.collaboration_group_list_types;

CREATE TRIGGER trg_list_types_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_types
FOR EACH ROW EXECUTE FUNCTION track_changes();

CREATE TRIGGER trg_cglt_changes
AFTER INSERT OR UPDATE OR DELETE ON public.collaboration_group_list_types
FOR EACH ROW EXECUTE FUNCTION track_changes(); 