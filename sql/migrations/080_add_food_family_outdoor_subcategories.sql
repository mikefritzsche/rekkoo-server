-- Migration: Add family-friendly and outdoor dining subcategories to Food & Drink
-- Date: 2024-12-17
-- Description: Adds subcategories for family dining and outdoor dining options

INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Family Restaurants', 'family-restaurants', ARRAY['family friendly', 'kid friendly', 'family dining', 'children welcome', 'kids menu']),
    ('Kid-Friendly Dining', 'kid-friendly-dining', ARRAY['kid friendly', 'children', 'kids meals', 'playground', 'family atmosphere']),
    ('Fast Food', 'fast-food', ARRAY['fast food', 'quick service', 'drive through', 'takeout', 'family meals']),
    ('Theme Restaurants', 'theme-restaurants', ARRAY['theme restaurant', 'entertainment dining', 'kids entertainment', 'family fun']),
    ('Outdoor Dining', 'outdoor-dining', ARRAY['outdoor dining', 'patio', 'terrace', 'al fresco', 'open air']),
    ('Rooftop Dining', 'rooftop-dining', ARRAY['rooftop', 'rooftop restaurant', 'sky dining', 'city views', 'terrace']),
    ('Garden Restaurants', 'garden-restaurants', ARRAY['garden dining', 'garden restaurant', 'outdoor garden', 'nature dining']),
    ('Beach & Waterfront', 'beach-waterfront', ARRAY['beach dining', 'waterfront', 'oceanview', 'lakeside', 'riverside']),
    ('Food Trucks', 'food-trucks', ARRAY['food truck', 'street food', 'mobile dining', 'outdoor eating']),
    ('Picnic & Parks', 'picnic-parks', ARRAY['picnic', 'park dining', 'outdoor picnic', 'takeaway', 'grab and go']),
    ('Brunch', 'brunch', ARRAY['brunch', 'breakfast', 'morning dining', 'weekend brunch', 'bottomless']),
    ('Fine Dining', 'fine-dining', ARRAY['fine dining', 'upscale', 'gourmet', 'michelin', 'haute cuisine']),
    ('Casual Dining', 'casual-dining', ARRAY['casual dining', 'relaxed', 'informal', 'everyday dining']),
    ('Street Food', 'street-food', ARRAY['street food', 'food stalls', 'markets', 'local food', 'vendors'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'food'
AND NOT EXISTS (
    SELECT 1
    FROM public.preference_subcategories ps
    WHERE ps.category_id = pc.id
    AND ps.slug = subcat.slug
);