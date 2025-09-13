-- MIGRATION: 040_create_connections_table_safe.sql
-- Description: Creates the connections table for bidirectional user connections (SAFE VERSION - can run multiple times)

-- Ensure the update_updated_at_column function exists
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the connections table (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS public.connections (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    initiated_by UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraints (only if they don't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_user_id') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT fk_connections_user_id
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_connection_id') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT fk_connections_connection_id
            FOREIGN KEY (connection_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_connections_initiated_by') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT fk_connections_initiated_by
            FOREIGN KEY (initiated_by) REFERENCES public.users(id);
    END IF;

    -- Add other constraints
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_connection') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT unique_connection
            UNIQUE (user_id, connection_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_self_connection') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT no_self_connection
            CHECK (user_id != connection_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_status') THEN
        ALTER TABLE public.connections
            ADD CONSTRAINT valid_status
            CHECK (status IN ('pending', 'accepted', 'blocked', 'removed'));
    END IF;
END $$;

-- Create indexes for performance (only if they don't exist)
CREATE INDEX IF NOT EXISTS idx_connections_user_id ON public.connections (user_id);
CREATE INDEX IF NOT EXISTS idx_connections_connection_id ON public.connections (connection_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON public.connections (status);
CREATE INDEX IF NOT EXISTS idx_connections_user_status ON public.connections (user_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_connection_status ON public.connections (connection_id, status);

-- Drop and recreate triggers to ensure they're up to date
DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
    BEFORE UPDATE ON public.connections
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS sync_log_trigger_connections ON public.connections;
CREATE TRIGGER sync_log_trigger_connections
    AFTER INSERT OR UPDATE OR DELETE ON public.connections
    FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

-- Add comments to document the table (will update if they exist)
COMMENT ON TABLE public.connections IS 'Stores bidirectional user connections';
COMMENT ON COLUMN public.connections.status IS 'Connection status values';
COMMENT ON COLUMN public.connections.initiated_by IS 'User who sent the initial connection request';

-- Verify the table was created/exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'connections') THEN
        RAISE NOTICE 'Table public.connections is ready';
    ELSE
        RAISE EXCEPTION 'Failed to create table public.connections';
    END IF;
END $$;