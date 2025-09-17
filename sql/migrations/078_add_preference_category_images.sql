-- Migration: Add image URLs to preference categories
-- Purpose: Store custom images for preference categories for better visual presentation

BEGIN;

-- Add image_url column to preference_categories table
ALTER TABLE public.preference_categories
ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Update categories with stock image URLs from Pexels
UPDATE public.preference_categories SET image_url = CASE
    WHEN slug = 'music' THEN 'https://images.pexels.com/photos/1763075/pexels-photo-1763075.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'entertainment' THEN 'https://images.pexels.com/photos/7991579/pexels-photo-7991579.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'books' THEN 'https://images.pexels.com/photos/1130980/pexels-photo-1130980.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'travel' THEN 'https://images.pexels.com/photos/2387418/pexels-photo-2387418.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'food' THEN 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'lifestyle' THEN 'https://images.pexels.com/photos/3184360/pexels-photo-3184360.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'creative' THEN 'https://images.pexels.com/photos/1646953/pexels-photo-1646953.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'knowledge' THEN 'https://images.pexels.com/photos/256417/pexels-photo-256417.jpeg?auto=compress&cs=tinysrgb&w=800'
    WHEN slug = 'special' THEN 'https://images.pexels.com/photos/2173508/pexels-photo-2173508.jpeg?auto=compress&cs=tinysrgb&w=800'
    ELSE image_url
END
WHERE slug IN ('music', 'entertainment', 'books', 'travel', 'food', 'lifestyle', 'creative', 'knowledge', 'special');

COMMIT;