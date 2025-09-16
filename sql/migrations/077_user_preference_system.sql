-- Migration: User Preference System
-- Purpose: Create comprehensive preference tracking for personalized recommendations

BEGIN;

-- Main preference categories (top-level)
CREATE TABLE IF NOT EXISTS public.preference_categories (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    icon VARCHAR(50), -- emoji or icon class name
    color VARCHAR(7), -- hex color for UI
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Subcategories within each main category
CREATE TABLE IF NOT EXISTS public.preference_subcategories (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES public.preference_categories(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    keywords TEXT[] DEFAULT '{}', -- For non-AI matching
    popularity_score INTEGER DEFAULT 0, -- Track how often selected
    example_lists TEXT[] DEFAULT '{}', -- Example list titles for this subcategory
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id, slug)
);

-- User preference selections
CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    subcategory_id UUID NOT NULL REFERENCES public.preference_subcategories(id) ON DELETE CASCADE,
    weight DECIMAL(3,2) DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    source VARCHAR(20) NOT NULL DEFAULT 'manual', -- 'onboarding', 'manual', 'inferred', 'behavior'
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, subcategory_id)
);

-- User discovery mode preferences
CREATE TABLE IF NOT EXISTS public.user_discovery_settings (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    discovery_mode VARCHAR(20) DEFAULT 'balanced', -- 'focused', 'balanced', 'explorer'
    onboarding_completed BOOLEAN DEFAULT false,
    onboarding_completed_at TIMESTAMPTZ,
    preferences_set_count INTEGER DEFAULT 0,
    last_preference_update TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Track preference changes for learning
CREATE TABLE IF NOT EXISTS public.user_preference_history (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    subcategory_id UUID REFERENCES public.preference_subcategories(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL, -- 'added', 'removed', 'weight_increased', 'weight_decreased'
    old_weight DECIMAL(3,2),
    new_weight DECIMAL(3,2),
    reason VARCHAR(100), -- Why the change happened
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON public.user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_subcategory ON public.user_preferences(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_weight ON public.user_preferences(weight DESC);
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON public.preference_subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_popularity ON public.preference_subcategories(popularity_score DESC);
CREATE INDEX IF NOT EXISTS idx_subcategories_keywords ON public.preference_subcategories USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_preference_history_user ON public.user_preference_history(user_id, created_at DESC);

-- Insert initial categories
INSERT INTO public.preference_categories (name, slug, icon, color, display_order) VALUES
    ('Music', 'music', '🎵', '#8B5CF6', 1),
    ('Entertainment', 'entertainment', '🎬', '#EF4444', 2),
    ('Books & Reading', 'books', '📚', '#F59E0B', 3),
    ('Travel & Places', 'travel', '✈️', '#10B981', 4),
    ('Food & Drink', 'food', '🍔', '#EC4899', 5),
    ('Lifestyle', 'lifestyle', '💫', '#6366F1', 6),
    ('Creative & Hobbies', 'creative', '🎨', '#14B8A6', 7),
    ('Knowledge & Growth', 'knowledge', '💡', '#F97316', 8),
    ('Special Interests', 'special', '⚡', '#8B5CF6', 9)
ON CONFLICT (slug) DO NOTHING;

-- Insert Music subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Pop', 'pop', ARRAY['pop', 'popular', 'top 40', 'mainstream']),
    ('Rock', 'rock', ARRAY['rock', 'alternative', 'indie rock', 'classic rock']),
    ('Hip-Hop', 'hip-hop', ARRAY['hip hop', 'rap', 'trap', 'urban']),
    ('R&B', 'r-and-b', ARRAY['r&b', 'rnb', 'soul', 'neo soul']),
    ('Country', 'country', ARRAY['country', 'nashville', 'bluegrass']),
    ('Electronic', 'electronic', ARRAY['electronic', 'edm', 'house', 'techno', 'dance']),
    ('Jazz', 'jazz', ARRAY['jazz', 'smooth jazz', 'bebop', 'swing']),
    ('Classical', 'classical', ARRAY['classical', 'orchestra', 'symphony', 'opera']),
    ('Indie', 'indie', ARRAY['indie', 'independent', 'alternative']),
    ('Latin', 'latin', ARRAY['latin', 'salsa', 'bachata', 'cumbia']),
    ('K-Pop', 'k-pop', ARRAY['kpop', 'korean pop', 'k-pop']),
    ('Reggae', 'reggae', ARRAY['reggae', 'dancehall', 'ska']),
    ('Reggaeton', 'reggaeton', ARRAY['reggaeton', 'latin urban', 'perreo']),
    ('Meditation', 'meditation', ARRAY['meditation', 'ambient', 'relaxation', 'calm']),
    ('Soundtracks', 'soundtracks', ARRAY['soundtrack', 'score', 'film music', 'ost'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'music';

-- Insert Entertainment subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Action Movies', 'action-movies', ARRAY['action', 'adventure', 'blockbuster']),
    ('Comedy', 'comedy', ARRAY['comedy', 'funny', 'humor', 'standup']),
    ('Drama', 'drama', ARRAY['drama', 'dramatic', 'serious']),
    ('Horror', 'horror', ARRAY['horror', 'scary', 'thriller', 'suspense']),
    ('Sci-Fi', 'sci-fi', ARRAY['science fiction', 'scifi', 'futuristic']),
    ('Romance', 'romance', ARRAY['romance', 'romantic', 'love story']),
    ('Documentary', 'documentary', ARRAY['documentary', 'docuseries', 'true story']),
    ('Animation', 'animation', ARRAY['animation', 'animated', 'cartoon', 'pixar', 'disney']),
    ('Anime', 'anime', ARRAY['anime', 'manga', 'japanese animation']),
    ('TV Shows', 'tv-shows', ARRAY['tv', 'series', 'television', 'streaming']),
    ('Gaming', 'gaming', ARRAY['gaming', 'video games', 'esports', 'games']),
    ('Podcasts', 'podcasts', ARRAY['podcast', 'audio', 'talk show'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'entertainment';

-- Update user_settings to track preference status
ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS preferences_onboarded BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS preferences_onboarded_at TIMESTAMPTZ;

COMMIT;
