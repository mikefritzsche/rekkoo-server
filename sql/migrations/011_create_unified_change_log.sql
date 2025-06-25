-- Migration: Create unified change log table for efficient sync
-- This reduces sync queries from 9+ per user to 1 query per user

CREATE TABLE IF NOT EXISTS public.change_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    record_id VARCHAR(255) NOT NULL,
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    change_data JSONB,
    
    -- Foreign key to users table
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Create indexes separately (PostgreSQL syntax)
CREATE INDEX IF NOT EXISTS idx_change_log_user_timestamp ON public.change_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_change_log_table_record ON public.change_log (table_name, record_id);

-- Add trigger function to automatically log changes
CREATE OR REPLACE FUNCTION log_table_changes()
RETURNS TRIGGER AS $$
DECLARE
    affected_user_id UUID;
    change_op VARCHAR(20);
BEGIN
    -- Determine operation type
    IF TG_OP = 'DELETE' THEN
        change_op = 'delete';
    ELSIF TG_OP = 'INSERT' THEN
        change_op = 'create';
    ELSE
        change_op = 'update';
    END IF;
    
    -- Extract user_id based on table
    CASE TG_TABLE_NAME
        WHEN 'lists', 'list_items' THEN
            affected_user_id = COALESCE(NEW.owner_id, OLD.owner_id);
        WHEN 'user_settings', 'favorites', 'notifications' THEN
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
        WHEN 'users' THEN
            affected_user_id = COALESCE(NEW.id, OLD.id);
        WHEN 'followers' THEN
            -- Log for both follower and followed user
            IF COALESCE(NEW.follower_id, OLD.follower_id) IS NOT NULL THEN
                INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
                VALUES (
                    COALESCE(NEW.follower_id, OLD.follower_id),
                    TG_TABLE_NAME,
                    COALESCE(NEW.id::text, OLD.id::text),
                    change_op,
                    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
                );
            END IF;
            affected_user_id = COALESCE(NEW.followed_id, OLD.followed_id);
        ELSE
            RETURN COALESCE(NEW, OLD);
    END CASE;
    
    -- Insert change log entry
    IF affected_user_id IS NOT NULL THEN
        INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
        VALUES (
            affected_user_id,
            TG_TABLE_NAME,
            COALESCE(NEW.id::text, OLD.id::text),
            change_op,
            CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
        );
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Add triggers to all sync tables
DROP TRIGGER IF EXISTS sync_log_trigger ON public.lists;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.lists
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.list_items;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.list_items
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.user_settings;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.user_settings
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.users;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.users
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.favorites;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.favorites
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.followers;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.followers
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS sync_log_trigger ON public.notifications;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();

-- Cleanup function to prevent change_log from growing indefinitely
CREATE OR REPLACE FUNCTION cleanup_old_change_logs()
RETURNS void AS $$
BEGIN
    -- Delete change logs older than 30 days
    DELETE FROM public.change_log 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Create scheduled cleanup (requires pg_cron extension or external scheduler)
-- SELECT cron.schedule('cleanup-change-logs', '0 2 * * *', 'SELECT cleanup_old_change_logs();'); 