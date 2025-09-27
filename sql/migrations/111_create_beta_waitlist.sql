-- Create beta_waitlist table to capture email addresses for beta access requests
CREATE TABLE IF NOT EXISTS beta_waitlist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying by status
CREATE INDEX IF NOT EXISTS idx_beta_waitlist_status
    ON beta_waitlist (status);

-- Comment for documentation
COMMENT ON TABLE beta_waitlist IS 'Stores email addresses requesting beta access invitations.';
COMMENT ON COLUMN beta_waitlist.status IS 'Current state of the request: pending, invited, or notified.';
COMMENT ON COLUMN beta_waitlist.metadata IS 'Additional JSON metadata such as source, user agent, or IP address.';
