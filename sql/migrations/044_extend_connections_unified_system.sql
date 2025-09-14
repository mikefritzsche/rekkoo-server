-- MIGRATION: 044_extend_connections_unified_system.sql
-- Description: Extends the connections table to support both mutual connections and following relationships
-- Part of Week 1: Unified System Implementation

-- Add connection_type column to distinguish between mutual connections and following
ALTER TABLE public.connections
ADD COLUMN IF NOT EXISTS connection_type VARCHAR(20) DEFAULT 'mutual';

-- Add auto_accepted column for automatic acceptance of following relationships
ALTER TABLE public.connections
ADD COLUMN IF NOT EXISTS auto_accepted BOOLEAN DEFAULT FALSE;

-- Add visibility_level column for privacy control
ALTER TABLE public.connections
ADD COLUMN IF NOT EXISTS visibility_level VARCHAR(20) DEFAULT 'public';

-- Update the valid_status constraint to include 'following' status
ALTER TABLE public.connections
DROP CONSTRAINT IF EXISTS valid_status;

ALTER TABLE public.connections
ADD CONSTRAINT valid_status
CHECK (status IN ('pending', 'accepted', 'blocked', 'removed', 'following'));

-- Add constraint for connection_type values (drop first if exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_connection_type') THEN
        ALTER TABLE public.connections
        ADD CONSTRAINT valid_connection_type
        CHECK (connection_type IN ('mutual', 'following'));
    END IF;
END $$;

-- Add constraint for visibility_level values (drop first if exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_visibility_level') THEN
        ALTER TABLE public.connections
        ADD CONSTRAINT valid_visibility_level
        CHECK (visibility_level IN ('public', 'friends', 'private'));
    END IF;
END $$;

-- Create indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_connections_type ON public.connections (connection_type);
CREATE INDEX IF NOT EXISTS idx_connections_visibility ON public.connections (visibility_level);
CREATE INDEX IF NOT EXISTS idx_connections_auto_accepted ON public.connections (auto_accepted);

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_connections_user_type_status
ON public.connections (user_id, connection_type, status);

CREATE INDEX IF NOT EXISTS idx_connections_connection_type_status
ON public.connections (connection_id, connection_type, status);

-- Update comments to document the new columns
COMMENT ON COLUMN public.connections.connection_type IS 'Type of connection: mutual (bidirectional friend) or following (unidirectional)';
COMMENT ON COLUMN public.connections.auto_accepted IS 'Whether the connection was automatically accepted (for following relationships)';
COMMENT ON COLUMN public.connections.visibility_level IS 'Privacy level for the connection: public, friends, or private';

-- Migrate existing data (if any) to use the new schema
-- All existing connections are assumed to be mutual connections
UPDATE public.connections
SET connection_type = 'mutual'
WHERE connection_type IS NULL;

-- Create a function to handle auto-acceptance of following relationships
CREATE OR REPLACE FUNCTION public.handle_following_auto_accept()
RETURNS TRIGGER AS $$
BEGIN
    -- If it's a following connection type, automatically set to accepted and mark auto_accepted
    IF NEW.connection_type = 'following' THEN
        NEW.status = 'following';
        NEW.auto_accepted = TRUE;
        NEW.accepted_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-accepting following relationships
DROP TRIGGER IF EXISTS auto_accept_following ON public.connections;
CREATE TRIGGER auto_accept_following
    BEFORE INSERT ON public.connections
    FOR EACH ROW
    WHEN (NEW.connection_type = 'following')
    EXECUTE FUNCTION public.handle_following_auto_accept();

-- Create a function to ensure bidirectional records for mutual connections
CREATE OR REPLACE FUNCTION public.ensure_bidirectional_connection()
RETURNS TRIGGER AS $$
BEGIN
    -- Only for mutual connections that are accepted
    IF NEW.connection_type = 'mutual' AND NEW.status = 'accepted' THEN
        -- Check if the reciprocal connection exists
        IF NOT EXISTS (
            SELECT 1 FROM public.connections
            WHERE user_id = NEW.connection_id
            AND connection_id = NEW.user_id
        ) THEN
            -- Create the reciprocal connection
            INSERT INTO public.connections (
                user_id,
                connection_id,
                status,
                connection_type,
                initiated_by,
                accepted_at,
                visibility_level
            ) VALUES (
                NEW.connection_id,
                NEW.user_id,
                'accepted',
                'mutual',
                NEW.initiated_by,
                NEW.accepted_at,
                NEW.visibility_level
            );
        ELSE
            -- Update the reciprocal connection to accepted
            UPDATE public.connections
            SET status = 'accepted',
                accepted_at = NEW.accepted_at,
                connection_type = 'mutual'
            WHERE user_id = NEW.connection_id
            AND connection_id = NEW.user_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for ensuring bidirectional mutual connections
DROP TRIGGER IF EXISTS ensure_mutual_connection ON public.connections;
CREATE TRIGGER ensure_mutual_connection
    AFTER UPDATE OF status ON public.connections
    FOR EACH ROW
    WHEN (NEW.connection_type = 'mutual' AND NEW.status = 'accepted' AND OLD.status != 'accepted')
    EXECUTE FUNCTION public.ensure_bidirectional_connection();

-- Verify the migration completed successfully
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'connections'
        AND column_name IN ('connection_type', 'auto_accepted', 'visibility_level')
    ) THEN
        RAISE NOTICE 'Connections table successfully extended with unified system fields';
    ELSE
        RAISE EXCEPTION 'Failed to extend connections table with unified system fields';
    END IF;
END $$;