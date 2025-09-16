-- Migration: Create list sharing tables
-- Description: Creates list_collaborators and collaboration_group_lists tables for list sharing functionality
-- Date: 2025-01-16

-- 1. Create list_collaborators table for individual list sharing
CREATE TABLE IF NOT EXISTS public.list_collaborators (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    permission VARCHAR(20) DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(list_id, user_id)
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_list_collaborators_list_id ON public.list_collaborators(list_id);
CREATE INDEX IF NOT EXISTS idx_list_collaborators_user_id ON public.list_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_list_collaborators_owner_id ON public.list_collaborators(owner_id);

-- Add trigger to update updated_at timestamp
CREATE TRIGGER update_list_collaborators_updated_at
    BEFORE UPDATE ON public.list_collaborators
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 2. Create collaboration_group_lists table for group list sharing
CREATE TABLE IF NOT EXISTS public.collaboration_group_lists (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
    list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
    added_by UUID NOT NULL REFERENCES public.users(id),
    permission VARCHAR(20) DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, list_id)
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_collaboration_group_lists_group_id ON public.collaboration_group_lists(group_id);
CREATE INDEX IF NOT EXISTS idx_collaboration_group_lists_list_id ON public.collaboration_group_lists(list_id);
CREATE INDEX IF NOT EXISTS idx_collaboration_group_lists_added_by ON public.collaboration_group_lists(added_by);

-- Add trigger to update updated_at timestamp
CREATE TRIGGER update_collaboration_group_lists_updated_at
    BEFORE UPDATE ON public.collaboration_group_lists
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 3. Create list_invitations table for list sharing invitations (if it doesn't exist)
CREATE TABLE IF NOT EXISTS public.list_invitations (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    permission VARCHAR(20) DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
    message TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    UNIQUE(list_id, invitee_id)
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_list_invitations_inviter_id ON public.list_invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_list_invitations_invitee_id ON public.list_invitations(invitee_id);
CREATE INDEX IF NOT EXISTS idx_list_invitations_list_id ON public.list_invitations(list_id);
CREATE INDEX IF NOT EXISTS idx_list_invitations_status ON public.list_invitations(status);

-- Add helpful comments
COMMENT ON TABLE public.list_collaborators IS 'Stores individual list sharing permissions between users';
COMMENT ON TABLE public.collaboration_group_lists IS 'Stores lists shared with collaboration groups';
COMMENT ON TABLE public.list_invitations IS 'Stores pending invitations for list sharing';

COMMENT ON COLUMN public.list_collaborators.permission IS 'Permission level: view (read-only), edit (can modify), admin (can share/delete)';
COMMENT ON COLUMN public.collaboration_group_lists.permission IS 'Permission level for all group members: view, edit, or admin';