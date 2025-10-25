-- Migration 115: Create checklist and packing detail tables
-- Focus: foundational schema for generic checklist-style lists

-- Create checklist_details table if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'checklist_details'
    ) THEN
        CREATE TABLE public.checklist_details (
            id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
            list_item_id uuid NOT NULL,
            completed boolean DEFAULT false NOT NULL,
            completed_at timestamp with time zone,
            completed_by uuid,
            priority text CHECK (priority IN ('low', 'medium', 'high')),
            due_date timestamp with time zone,
            recurrence_pattern text,
            notes text,
            tags jsonb,
            assigned_to uuid,
            effort_estimate numeric,
            actual_effort numeric,
            completion_count integer DEFAULT 0 NOT NULL,
            last_reset_at timestamp with time zone,
            metadata jsonb,
            created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            deleted_at timestamp with time zone,
            CONSTRAINT checklist_details_list_item_id_unique UNIQUE (list_item_id),
            CONSTRAINT checklist_details_list_item_id_fkey FOREIGN KEY (list_item_id)
                REFERENCES public.list_items(id) ON DELETE CASCADE
        );

        ALTER TABLE public.checklist_details OWNER TO admin;

        CREATE INDEX idx_checklist_details_completed ON public.checklist_details(completed);
        CREATE INDEX idx_checklist_details_due_date ON public.checklist_details(due_date);
        CREATE INDEX idx_checklist_details_assigned_to ON public.checklist_details(assigned_to);
    END IF;
END $$;

-- Create checklist_history table if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'checklist_history'
    ) THEN
        CREATE TABLE public.checklist_history (
            id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
            item_id uuid NOT NULL,
            list_id uuid NOT NULL,
            list_type text NOT NULL,
            action text CHECK (action IN ('completed', 'reset', 'skipped', 'deferred', 'edited')),
            state_before jsonb,
            state_after jsonb,
            performed_by uuid,
            performed_at timestamp with time zone NOT NULL,
            notes text,
            created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT checklist_history_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.list_items(id) ON DELETE CASCADE,
            CONSTRAINT checklist_history_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE
        );

        ALTER TABLE public.checklist_history OWNER TO admin;

        CREATE INDEX idx_checklist_history_item ON public.checklist_history(item_id);
        CREATE INDEX idx_checklist_history_list ON public.checklist_history(list_id);
        CREATE INDEX idx_checklist_history_performed_at ON public.checklist_history(performed_at);
    END IF;
END $$;

-- Ensure checklist_details.updated_at stays fresh
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_checklist_details_updated_at'
    ) THEN
        CREATE TRIGGER update_checklist_details_updated_at
        BEFORE UPDATE ON public.checklist_details
        FOR EACH ROW
        EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END $$;

-- Create packing_details table if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'packing_details'
    ) THEN
        CREATE TABLE public.packing_details (
            id uuid DEFAULT public.uuid_generate_v4() PRIMARY KEY,
            list_item_id uuid NOT NULL,
            quantity integer DEFAULT 1 NOT NULL,
            packed boolean DEFAULT false NOT NULL,
            packed_at timestamp with time zone,
            category text,
            weight numeric,
            size text CHECK (size IN ('small', 'medium', 'large', 'extra-large')),
            fragile boolean DEFAULT false NOT NULL,
            essential boolean DEFAULT false NOT NULL,
            location text,
            weather_specific text,
            trip_type text,
            notes text,
            metadata jsonb,
            created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            deleted_at timestamp with time zone,
            CONSTRAINT packing_details_list_item_id_unique UNIQUE (list_item_id),
            CONSTRAINT packing_details_list_item_id_fkey FOREIGN KEY (list_item_id)
                REFERENCES public.list_items(id) ON DELETE CASCADE
        );

        ALTER TABLE public.packing_details OWNER TO admin;

        CREATE INDEX idx_packing_details_packed ON public.packing_details(packed);
        CREATE INDEX idx_packing_details_category ON public.packing_details(category);
        CREATE INDEX idx_packing_details_location ON public.packing_details(location);
    END IF;
END $$;

-- Ensure packing_details.updated_at stays fresh
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_packing_details_updated_at'
    ) THEN
        CREATE TRIGGER update_packing_details_updated_at
        BEFORE UPDATE ON public.packing_details
        FOR EACH ROW
        EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END $$;

-- Add checklist_detail_id column to list_items if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'list_items'
          AND column_name = 'checklist_detail_id'
    ) THEN
        ALTER TABLE public.list_items ADD COLUMN checklist_detail_id uuid;
    END IF;
END $$;

-- Add packing_detail_id column to list_items if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'list_items'
          AND column_name = 'packing_detail_id'
    ) THEN
        ALTER TABLE public.list_items ADD COLUMN packing_detail_id uuid;
    END IF;
END $$;

-- Wire up foreign keys and indexes for new detail columns
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'list_items_checklist_detail_id_fkey'
    ) THEN
        ALTER TABLE public.list_items
        ADD CONSTRAINT list_items_checklist_detail_id_fkey
        FOREIGN KEY (checklist_detail_id) REFERENCES public.checklist_details(id)
        ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'list_items'
          AND indexname = 'idx_list_items_checklist_detail_id'
    ) THEN
        CREATE INDEX idx_list_items_checklist_detail_id ON public.list_items(checklist_detail_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'list_items_packing_detail_id_fkey'
    ) THEN
        ALTER TABLE public.list_items
        ADD CONSTRAINT list_items_packing_detail_id_fkey
        FOREIGN KEY (packing_detail_id) REFERENCES public.packing_details(id)
        ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'list_items'
          AND indexname = 'idx_list_items_packing_detail_id'
    ) THEN
        CREATE INDEX idx_list_items_packing_detail_id ON public.list_items(packing_detail_id);
    END IF;
END $$;

-- Extend the single-detail check constraint to include new detail types
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'list_items'
          AND constraint_name = 'chk_one_detail_type'
    ) THEN
        ALTER TABLE public.list_items
        DROP CONSTRAINT chk_one_detail_type;
    END IF;

    ALTER TABLE public.list_items
    ADD CONSTRAINT chk_one_detail_type CHECK (
        (
            CASE WHEN movie_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN book_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN place_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN spotify_item_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN tv_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN recipe_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN gift_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN checklist_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN packing_detail_id IS NOT NULL THEN 1 ELSE 0 END
        ) <= 1
    );
END $$;
