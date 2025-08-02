-- 034_create_spotify_item_details.sql
-- Creates table to store raw Spotify object per track/album/etc.

CREATE TABLE IF NOT EXISTS public.spotify_item_details (
    id          UUID PRIMARY KEY,
    spotify_id  TEXT UNIQUE NOT NULL,
    raw_json    JSONB,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- add simple trigger to keep updated_at current
CREATE OR REPLACE FUNCTION public.touch_spotify_item_details()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_spotify_item_details ON public.spotify_item_details;
CREATE TRIGGER trg_touch_spotify_item_details
BEFORE UPDATE ON public.spotify_item_details
FOR EACH ROW EXECUTE PROCEDURE public.touch_spotify_item_details(); 