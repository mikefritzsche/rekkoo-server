-- Migration: Create gift_details table to store gift-specific information (SAFE/IDEMPOTENT VERSION)
-- Author: System
-- Date: 2025-08-29
-- Note: This version checks for existing objects before creating them

-- Create gift_details table only if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables 
                   WHERE table_schema = 'public' 
                   AND table_name = 'gift_details') THEN
        
        CREATE TABLE public.gift_details (
            id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
            list_item_id uuid NOT NULL,
            quantity integer,
            where_to_buy text,
            amazon_url text,
            web_link text,
            rating integer,
            created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
            updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT gift_details_pkey PRIMARY KEY (id),
            CONSTRAINT gift_details_list_item_id_fkey FOREIGN KEY (list_item_id) 
                REFERENCES public.list_items(id) ON DELETE CASCADE,
            CONSTRAINT gift_details_list_item_id_unique UNIQUE(list_item_id)
        );
        
        -- Create index
        CREATE INDEX idx_gift_details_list_item_id ON public.gift_details(list_item_id);
        
        -- Grant permissions
        ALTER TABLE public.gift_details OWNER TO admin;
        
        -- Add comments
        COMMENT ON TABLE public.gift_details IS 'Stores gift-specific metadata for list items';
        COMMENT ON COLUMN public.gift_details.quantity IS 'Desired quantity of the gift item';
        COMMENT ON COLUMN public.gift_details.where_to_buy IS 'Store or location where the gift can be purchased';
        COMMENT ON COLUMN public.gift_details.amazon_url IS 'Direct Amazon link for the gift';
        COMMENT ON COLUMN public.gift_details.web_link IS 'General web link for the gift';
        COMMENT ON COLUMN public.gift_details.rating IS 'User rating for the gift (1-5)';
        
        RAISE NOTICE 'Created gift_details table';
    ELSE
        RAISE NOTICE 'gift_details table already exists - skipping creation';
    END IF;
END $$;

-- Create or replace the trigger function
CREATE OR REPLACE FUNCTION update_gift_details_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_trigger 
                   WHERE tgname = 'gift_details_updated_at_trigger') THEN
        CREATE TRIGGER gift_details_updated_at_trigger
        BEFORE UPDATE ON public.gift_details
        FOR EACH ROW
        EXECUTE FUNCTION update_gift_details_updated_at();
        
        RAISE NOTICE 'Created gift_details_updated_at_trigger';
    ELSE
        RAISE NOTICE 'gift_details_updated_at_trigger already exists - skipping';
    END IF;
END $$;

-- Add gift_detail_id column to list_items table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'list_items' 
                   AND column_name = 'gift_detail_id') THEN
        
        ALTER TABLE public.list_items 
        ADD COLUMN gift_detail_id uuid;
        
        RAISE NOTICE 'Added gift_detail_id column to list_items';
    ELSE
        RAISE NOTICE 'gift_detail_id column already exists in list_items - skipping';
    END IF;
END $$;

-- Add foreign key constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.table_constraints 
                   WHERE constraint_name = 'list_items_gift_detail_id_fkey') THEN
        
        ALTER TABLE public.list_items
        ADD CONSTRAINT list_items_gift_detail_id_fkey 
        FOREIGN KEY (gift_detail_id) REFERENCES public.gift_details(id);
        
        RAISE NOTICE 'Added foreign key constraint list_items_gift_detail_id_fkey';
    ELSE
        RAISE NOTICE 'Foreign key constraint already exists - skipping';
    END IF;
END $$;

-- Create index if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_indexes 
                   WHERE schemaname = 'public' 
                   AND tablename = 'list_items' 
                   AND indexname = 'idx_list_items_gift_detail_id') THEN
        
        CREATE INDEX idx_list_items_gift_detail_id ON public.list_items(gift_detail_id);
        
        RAISE NOTICE 'Created index idx_list_items_gift_detail_id';
    ELSE
        RAISE NOTICE 'Index idx_list_items_gift_detail_id already exists - skipping';
    END IF;
END $$;

-- Update the check constraint
DO $$
BEGIN
    -- First drop the existing constraint if it exists
    ALTER TABLE public.list_items 
    DROP CONSTRAINT IF EXISTS chk_one_detail_type;
    
    -- Add the updated constraint including gift_detail_id
    ALTER TABLE public.list_items
    ADD CONSTRAINT chk_one_detail_type CHECK (
        (
            CASE WHEN movie_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN book_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN place_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN spotify_item_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN tv_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN recipe_detail_id IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN gift_detail_id IS NOT NULL THEN 1 ELSE 0 END
        ) <= 1
    );
    
    RAISE NOTICE 'Updated check constraint chk_one_detail_type';
END $$;

-- Final success message
DO $$
BEGIN
    RAISE NOTICE '===========================================';
    RAISE NOTICE 'Gift details migration completed successfully';
    RAISE NOTICE '===========================================';
END $$;