-- 013_add_photos_to_place_details.sql
-- Adds an array column that stores Google photo_reference strings for each place.
-- Run with the other migrations; safe on production because it is additive.

ALTER TABLE IF EXISTS place_details
ADD COLUMN IF NOT EXISTS photos text[];

-- Optional: create a GIN index so we can search/placeholders for specific photo ids quickly.
CREATE INDEX IF NOT EXISTS idx_place_details_photos ON place_details USING gin (photos); 