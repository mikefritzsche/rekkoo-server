-- Migration: Create invitations system
-- Description: Adds invitation tables and relationships for user invitation flow

-- Main invitations table
CREATE TABLE IF NOT EXISTS public.invitations (
    id UUID DEFAULT public.uuid_generate_v4() NOT NULL,
    inviter_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    invitation_code VARCHAR(32) UNIQUE NOT NULL,
    invitation_token VARCHAR(128) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' NOT NULL,
    metadata JSONB DEFAULT '{}',
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    accepted_by_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT invitations_pkey PRIMARY KEY (id),
    CONSTRAINT invitations_inviter_fk FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT invitations_accepted_by_fk FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT invitations_status_check CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled'))
);

-- Invitation sync tracking for offline-first architecture
CREATE TABLE IF NOT EXISTS public.invitation_sync_tracking (
    id UUID DEFAULT public.uuid_generate_v4() NOT NULL,
    invitation_id UUID NOT NULL,
    user_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT invitation_sync_tracking_pkey PRIMARY KEY (id),
    CONSTRAINT invitation_sync_invitation_fk FOREIGN KEY (invitation_id) REFERENCES public.invitations(id) ON DELETE CASCADE,
    CONSTRAINT invitation_sync_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Add invitation tracking to users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES public.users(id),
ADD COLUMN IF NOT EXISTS invitation_accepted_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_invitations_inviter_id ON public.invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_code ON public.invitations(invitation_code);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON public.invitations(invitation_token);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON public.invitations(status);
CREATE INDEX IF NOT EXISTS idx_invitations_expires_at ON public.invitations(expires_at);
CREATE INDEX IF NOT EXISTS idx_invitations_deleted_at ON public.invitations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_invitation_sync_tracking_user_id ON public.invitation_sync_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_invitation_sync_tracking_invitation_id ON public.invitation_sync_tracking(invitation_id);

-- Add triggers for updated_at
CREATE TRIGGER update_invitations_updated_at 
    BEFORE UPDATE ON public.invitations
    FOR EACH ROW 
    EXECUTE FUNCTION public.update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE public.invitations IS 'User invitation system for managing app invitations';
COMMENT ON COLUMN public.invitations.invitation_code IS 'Short code for manual entry (e.g., ABC123)';
COMMENT ON COLUMN public.invitations.invitation_token IS 'Secure token for deep links';
COMMENT ON COLUMN public.invitations.metadata IS 'Flexible JSON data for custom messages, roles, etc.';
COMMENT ON COLUMN public.invitations.status IS 'Invitation status: pending, accepted, expired, cancelled'; 