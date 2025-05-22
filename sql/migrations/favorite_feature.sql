-- Migration: Add favorites feature
-- Description: Adds tables and relationships for list and list item favorites

-- Create favorites categories table
CREATE TABLE public.favorite_categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(50),
    icon character varying(50),
    description text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT favorite_categories_pk PRIMARY KEY (id),
    CONSTRAINT favorite_categories_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id)
);

-- Create indexes for favorite categories
CREATE INDEX idx_favorite_categories_user_id ON public.favorite_categories USING btree (user_id);
CREATE INDEX idx_favorite_categories_deleted_at ON public.favorite_categories USING btree (deleted_at);

-- Create favorites table
CREATE TABLE public.favorites (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    list_id uuid,
    list_item_id uuid,
    category_id uuid,
    is_public boolean DEFAULT false,
    sort_order integer DEFAULT 0,
    notes text,
    custom_fields jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT favorites_pk PRIMARY KEY (id),
    CONSTRAINT favorites_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id),
    CONSTRAINT favorites_list_fk FOREIGN KEY (list_id) REFERENCES public.lists(id),
    CONSTRAINT favorites_list_item_fk FOREIGN KEY (list_item_id) REFERENCES public.list_items(id),
    CONSTRAINT favorites_category_fk FOREIGN KEY (category_id) REFERENCES public.favorite_categories(id),
    CONSTRAINT favorites_either_list_or_item CHECK ((list_id IS NOT NULL AND list_item_id IS NULL) OR (list_id IS NULL AND list_item_id IS NOT NULL))
);

-- Create indexes for favorites including conditional unique indexes instead of partial constraints
CREATE INDEX idx_favorites_user_id ON public.favorites USING btree (user_id);
CREATE INDEX idx_favorites_list_id ON public.favorites USING btree (list_id);
CREATE INDEX idx_favorites_list_item_id ON public.favorites USING btree (list_item_id);
CREATE INDEX idx_favorites_category_id ON public.favorites USING btree (category_id);
CREATE INDEX idx_favorites_deleted_at ON public.favorites USING btree (deleted_at);
CREATE INDEX idx_favorites_is_public ON public.favorites USING btree (is_public);
CREATE INDEX idx_favorites_sort_order ON public.favorites USING btree (sort_order);

-- Create unique indexes instead of partial constraints
CREATE UNIQUE INDEX idx_favorites_unique_list ON public.favorites (user_id, list_id) 
WHERE list_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_favorites_unique_list_item ON public.favorites (user_id, list_item_id) 
WHERE list_item_id IS NOT NULL AND deleted_at IS NULL;

-- Create favorites sharing table for more granular sharing control
CREATE TABLE public.favorite_sharing (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    favorite_id uuid NOT NULL,
    shared_by_user_id uuid NOT NULL,
    shared_with_user_id uuid,
    shared_with_group_id uuid,
    permissions character varying(20) DEFAULT 'view'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT favorite_sharing_pk PRIMARY KEY (id),
    CONSTRAINT favorite_sharing_favorite_fk FOREIGN KEY (favorite_id) REFERENCES public.favorites(id),
    CONSTRAINT favorite_sharing_shared_by_fk FOREIGN KEY (shared_by_user_id) REFERENCES public.users(id),
    CONSTRAINT favorite_sharing_shared_with_user_fk FOREIGN KEY (shared_with_user_id) REFERENCES public.users(id),
    CONSTRAINT favorite_sharing_shared_with_group_fk FOREIGN KEY (shared_with_group_id) REFERENCES public.user_groups(id),
    CONSTRAINT favorite_sharing_user_or_group CHECK ((shared_with_user_id IS NOT NULL AND shared_with_group_id IS NULL) OR (shared_with_user_id IS NULL AND shared_with_group_id IS NOT NULL))
);

-- Create indexes for favorite sharing
CREATE INDEX idx_favorite_sharing_favorite_id ON public.favorite_sharing USING btree (favorite_id);
CREATE INDEX idx_favorite_sharing_shared_by_user_id ON public.favorite_sharing USING btree (shared_by_user_id);
CREATE INDEX idx_favorite_sharing_shared_with_user_id ON public.favorite_sharing USING btree (shared_with_user_id);
CREATE INDEX idx_favorite_sharing_shared_with_group_id ON public.favorite_sharing USING btree (shared_with_group_id);
CREATE INDEX idx_favorite_sharing_deleted_at ON public.favorite_sharing USING btree (deleted_at);

-- Create notification preferences for favorites
CREATE TABLE public.favorite_notification_preferences (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    favorite_id uuid NOT NULL,
    notify_on_update boolean DEFAULT true,
    notify_on_comment boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    CONSTRAINT favorite_notification_preferences_pk PRIMARY KEY (id),
    CONSTRAINT favorite_notification_preferences_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id),
    CONSTRAINT favorite_notification_preferences_favorite_fk FOREIGN KEY (favorite_id) REFERENCES public.favorites(id)
);

-- Create unique index instead of partial constraint
CREATE UNIQUE INDEX idx_favorite_notification_preferences_unique ON public.favorite_notification_preferences (user_id, favorite_id) 
WHERE deleted_at IS NULL;

-- Create indexes for favorite notification preferences
CREATE INDEX idx_favorite_notification_preferences_user_id ON public.favorite_notification_preferences USING btree (user_id);
CREATE INDEX idx_favorite_notification_preferences_favorite_id ON public.favorite_notification_preferences USING btree (favorite_id);
CREATE INDEX idx_favorite_notification_preferences_deleted_at ON public.favorite_notification_preferences USING btree (deleted_at);

-- Create triggers for updated_at
CREATE TRIGGER update_favorite_categories_updated_at BEFORE UPDATE ON public.favorite_categories 
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_favorites_updated_at BEFORE UPDATE ON public.favorites 
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_favorite_sharing_updated_at BEFORE UPDATE ON public.favorite_sharing 
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_favorite_notification_preferences_updated_at BEFORE UPDATE ON public.favorite_notification_preferences 
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add default category for each user (optional, can be executed separately)
-- INSERT INTO public.favorite_categories (user_id, name, color, icon)
-- SELECT id, 'Default', '#4a90e2', 'star' FROM public.users WHERE deleted_at IS NULL;

-- Add these tables to the sync_tracking system tables list if needed
-- This would be done in application code, typically in the SyncController 