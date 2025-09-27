-- Add beta program tracking to invitations table
-- This migration adds columns to track beta program invitations and their metadata

-- Add source column to track invitation source (user_generated, beta_program, etc.)
ALTER TABLE invitations
ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'user_generated';

-- Add metadata JSONB column for additional invitation data
ALTER TABLE invitations
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Create index for faster beta invitation lookups
CREATE INDEX IF NOT EXISTS idx_invitations_source
ON invitations (source) WHERE source = 'beta_program';

-- Create index for metadata queries
CREATE INDEX IF NOT EXISTS idx_invitations_metadata_source
ON invitations USING GIN (metadata) WHERE metadata->>'source' = 'beta_program';

-- Update existing beta_program invitations if any
UPDATE invitations
SET source = 'beta_program',
    metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{source}', '"beta_program"', true)
WHERE metadata->>'source' = 'beta_program';

-- Add comment for documentation
COMMENT ON COLUMN invitations.source IS 'Source of the invitation: user_generated, beta_program, etc.';
COMMENT ON COLUMN invitations.metadata IS 'Additional invitation metadata as JSONB';