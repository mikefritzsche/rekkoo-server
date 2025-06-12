-- Add social_networks column to user_settings table as JSONB
ALTER TABLE public.user_settings
ADD COLUMN social_networks JSONB DEFAULT '{
  "networks": []
}'::jsonb;

-- Add a comment explaining the structure
COMMENT ON COLUMN public.user_settings.social_networks IS 'Array of social network connections with format: {"networks": [{"platform": "instagram", "username": "user123", "url": "https://..."}, ...]}';

-- Add an index for better query performance on the JSONB field
CREATE INDEX idx_user_settings_social_networks ON public.user_settings USING gin (social_networks);

-- Add trigger to update updated_at timestamp when social_networks is modified
CREATE OR REPLACE FUNCTION update_user_settings_social_networks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_update_user_settings_social_networks_updated_at
    BEFORE UPDATE OF social_networks
    ON public.user_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_user_settings_social_networks_updated_at(); 