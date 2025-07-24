-- MIGRATION: 018_create_collaboration_groups.sql
-- Description: Creates tables for collaborative features, including groups, members, and list sharing.

-- Create the main groups table
CREATE TABLE public.collaboration_groups (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    owner_id UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_collaboration_groups_owner_id ON public.collaboration_groups (owner_id);
CREATE TRIGGER update_collaboration_groups_updated_at
BEFORE UPDATE ON public.collaboration_groups
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create the group members join table
CREATE TABLE public.collaboration_group_members (
    group_id UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_collaboration_group_members_user_id ON public.collaboration_group_members (user_id);
CREATE INDEX idx_collaboration_group_members_group_id ON public.collaboration_group_members (group_id);

-- Add privacy_level to the lists table
ALTER TABLE public.lists
ADD COLUMN privacy_level VARCHAR(20) DEFAULT 'private' NOT NULL;
COMMENT ON COLUMN public.lists.privacy_level IS 'Privacy setting for the list: private, public, or group';

-- Add foreign key constraints to gift_reservations
-- It's good practice to ensure these are in place
ALTER TABLE public.gift_reservations
ADD CONSTRAINT fk_gift_reservations_item FOREIGN KEY (item_id) REFERENCES public.list_items(id) ON DELETE CASCADE,
ADD CONSTRAINT fk_gift_reservations_reserved_by FOREIGN KEY (reserved_by) REFERENCES public.users(id) ON DELETE SET NULL,
ADD CONSTRAINT fk_gift_reservations_reserved_for FOREIGN KEY (reserved_for) REFERENCES public.users(id) ON DELETE CASCADE;

-- Add triggers for the new tables
CREATE TRIGGER sync_log_trigger_collaboration_groups
AFTER INSERT OR UPDATE OR DELETE ON public.collaboration_groups
FOR EACH ROW EXECUTE FUNCTION public.log_table_changes();

CREATE TRIGGER sync_log_trigger_collaboration_group_members
AFTER INSERT OR UPDATE OR DELETE ON public.collaboration_group_members
FOR EACH ROW EXECUTE FUNCTION public.log_table_changes(); 