-- Migration: Add connections table to change log for proper sync
-- This ensures connection removals are synced even if socket events are missed

-- Update the log_table_changes function to handle connections table
CREATE OR REPLACE FUNCTION log_table_changes()
RETURNS TRIGGER AS $$
DECLARE
    affected_user_id UUID;
    affected_user_id2 UUID;
    change_op VARCHAR(20);
    record_id_text TEXT;
BEGIN
    -- Determine operation type
    IF TG_OP = 'DELETE' THEN
        change_op = 'delete';
    ELSIF TG_OP = 'INSERT' THEN
        change_op = 'create';
    ELSE
        change_op = 'update';
    END IF;

    -- Extract user_id and record_id based on table
    CASE TG_TABLE_NAME
        WHEN 'lists', 'list_items' THEN
            affected_user_id = COALESCE(NEW.owner_id, OLD.owner_id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'user_settings' THEN
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
            record_id_text = COALESCE(NEW.user_id::text, OLD.user_id::text);
        WHEN 'favorites', 'notifications' THEN
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'users' THEN
            affected_user_id = COALESCE(NEW.id, OLD.id);
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
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
            record_id_text = COALESCE(NEW.id::text, OLD.id::text);
        WHEN 'connections' THEN
            -- Log for BOTH users in the connection
            -- User 1
            affected_user_id = COALESCE(NEW.user_id, OLD.user_id);
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

            -- User 2 (connection_id)
            affected_user_id2 = COALESCE(NEW.connection_id, OLD.connection_id);
            IF affected_user_id2 IS NOT NULL AND affected_user_id2 != affected_user_id THEN
                INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
                VALUES (
                    affected_user_id2,
                    TG_TABLE_NAME,
                    COALESCE(NEW.id::text, OLD.id::text),
                    change_op,
                    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
                );
            END IF;

            -- Return early since we handled both users
            RETURN COALESCE(NEW, OLD);
        ELSE
            RETURN COALESCE(NEW, OLD);
    END CASE;

    -- Insert change log entry
    IF affected_user_id IS NOT NULL THEN
        INSERT INTO public.change_log (user_id, table_name, record_id, operation, change_data)
        VALUES (
            affected_user_id,
            TG_TABLE_NAME,
            record_id_text,
            change_op,
            CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Add trigger for connections table
DROP TRIGGER IF EXISTS sync_log_trigger ON public.connections;
CREATE TRIGGER sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON public.connections
    FOR EACH ROW EXECUTE FUNCTION log_table_changes();