-- Migration: Migrate existing gift items to gift_details table (FIXED VERSION)
-- Author: System
-- Date: 2025-08-29
-- Purpose: Extract gift-specific fields to gift_details - handles 'gift', 'gifts', or any gift-like list_type
-- Fixed: Renamed variable to avoid ambiguous column reference error

BEGIN;

DO $$
DECLARE
    migrated_count integer := 0;
    item_record RECORD;
    new_gift_detail_id uuid;  -- Renamed to avoid ambiguity with column name
    has_gift_fields boolean;
    gift_list_types text[];
BEGIN
    RAISE NOTICE 'Starting adaptive migration of gift items to gift_details table...';
    
    -- First, find what gift-related list_types actually exist
    SELECT ARRAY_AGG(DISTINCT list_type) INTO gift_list_types
    FROM lists
    WHERE LOWER(list_type) LIKE '%gift%'
    AND deleted_at IS NULL;
    
    IF gift_list_types IS NOT NULL THEN
        RAISE NOTICE 'Found gift list types: %', gift_list_types;
    ELSE
        RAISE NOTICE 'No gift list types found. Looking for items with gift data in custom_fields...';
    END IF;
    
    -- Find all gift items that don't have a gift_detail_id yet
    -- This now handles 'gift', 'gifts', or any variation containing 'gift'
    FOR item_record IN 
        SELECT 
            li.id as item_id,
            li.custom_fields,
            li.price,
            l.list_type
        FROM list_items li
        JOIN lists l ON li.list_id = l.id
        WHERE 
            li.gift_detail_id IS NULL 
            AND li.deleted_at IS NULL
            AND (
                -- Match any gift-like list type
                LOWER(l.list_type) LIKE '%gift%'
                -- OR has gift-related fields in custom_fields
                OR (
                    li.custom_fields IS NOT NULL 
                    AND (
                        li.custom_fields ? 'quantity'
                        OR li.custom_fields ? 'whereToBuy'
                        OR li.custom_fields ? 'where_to_buy'
                        OR li.custom_fields ? 'amazonUrl'
                        OR li.custom_fields ? 'amazon_url'
                        OR li.custom_fields ? 'webLink'
                        OR li.custom_fields ? 'web_link'
                        OR li.custom_fields ? 'rating'
                    )
                )
            )
    LOOP
        has_gift_fields := false;
        
        -- Check if custom_fields contains any gift-specific fields
        IF item_record.custom_fields IS NOT NULL THEN
            has_gift_fields := (
                item_record.custom_fields ? 'quantity' OR
                item_record.custom_fields ? 'whereToBuy' OR
                item_record.custom_fields ? 'where_to_buy' OR
                item_record.custom_fields ? 'amazonUrl' OR
                item_record.custom_fields ? 'amazon_url' OR
                item_record.custom_fields ? 'webLink' OR
                item_record.custom_fields ? 'web_link' OR
                item_record.custom_fields ? 'rating'
            );
        END IF;
        
        -- Create gift_details if:
        -- 1. It's in a gift-type list (any variation)
        -- 2. OR it has gift fields in custom_fields
        IF LOWER(item_record.list_type) LIKE '%gift%' OR has_gift_fields THEN
            
            -- Generate new gift_detail_id
            new_gift_detail_id := public.uuid_generate_v4();
            
            -- Insert into gift_details (extracting from custom_fields if present)
            INSERT INTO gift_details (
                id,
                list_item_id,
                quantity,
                where_to_buy,
                amazon_url,
                web_link,
                rating,
                created_at,
                updated_at
            ) VALUES (
                new_gift_detail_id,  -- Using renamed variable
                item_record.item_id,
                -- Extract quantity
                CASE 
                    WHEN item_record.custom_fields ? 'quantity' 
                    THEN (item_record.custom_fields->>'quantity')::integer
                    ELSE NULL
                END,
                -- Extract where_to_buy (check both naming conventions)
                CASE 
                    WHEN item_record.custom_fields ? 'whereToBuy' 
                    THEN item_record.custom_fields->>'whereToBuy'
                    WHEN item_record.custom_fields ? 'where_to_buy' 
                    THEN item_record.custom_fields->>'where_to_buy'
                    ELSE NULL
                END,
                -- Extract amazon_url (check both naming conventions)
                CASE 
                    WHEN item_record.custom_fields ? 'amazonUrl' 
                    THEN item_record.custom_fields->>'amazonUrl'
                    WHEN item_record.custom_fields ? 'amazon_url' 
                    THEN item_record.custom_fields->>'amazon_url'
                    ELSE NULL
                END,
                -- Extract web_link (check both naming conventions)
                CASE 
                    WHEN item_record.custom_fields ? 'webLink' 
                    THEN item_record.custom_fields->>'webLink'
                    WHEN item_record.custom_fields ? 'web_link' 
                    THEN item_record.custom_fields->>'web_link'
                    ELSE NULL
                END,
                -- Extract rating
                CASE 
                    WHEN item_record.custom_fields ? 'rating' 
                    THEN (item_record.custom_fields->>'rating')::integer
                    ELSE NULL
                END,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (list_item_id) DO UPDATE
            SET 
                -- Update if already exists (in case of re-run)
                quantity = EXCLUDED.quantity,
                where_to_buy = EXCLUDED.where_to_buy,
                amazon_url = EXCLUDED.amazon_url,
                web_link = EXCLUDED.web_link,
                rating = EXCLUDED.rating,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id INTO new_gift_detail_id;  -- Using renamed variable
            
            -- Update list_items with the gift_detail_id
            UPDATE list_items 
            SET 
                gift_detail_id = new_gift_detail_id,  -- Fixed: Using renamed variable
                updated_at = CURRENT_TIMESTAMP
            WHERE id = item_record.item_id;
            
            -- Increment counter
            migrated_count := migrated_count + 1;
            
            IF migrated_count % 10 = 0 THEN
                RAISE NOTICE 'Processed % items...', migrated_count;
            END IF;
        END IF;
    END LOOP;
    
    RAISE NOTICE '===========================================';
    RAISE NOTICE 'Migration completed successfully!';
    RAISE NOTICE 'Total items migrated to gift_details: %', migrated_count;
    RAISE NOTICE 'custom_fields have been preserved in list_items table.';
    RAISE NOTICE '===========================================';
END $$;

-- Detailed verification
DO $$
DECLARE
    total_gift_lists integer;
    gift_list_types text;
    total_gift_items integer;
    migrated_items integer;
    items_with_custom_fields integer;
BEGIN
    -- Get distinct gift list types
    SELECT STRING_AGG(DISTINCT list_type, ', ' ORDER BY list_type) INTO gift_list_types
    FROM lists
    WHERE LOWER(list_type) LIKE '%gift%' AND deleted_at IS NULL;
    
    -- Count gift lists
    SELECT COUNT(*) INTO total_gift_lists
    FROM lists
    WHERE LOWER(list_type) LIKE '%gift%' AND deleted_at IS NULL;
    
    -- Count gift items
    SELECT COUNT(*) INTO total_gift_items
    FROM list_items li
    JOIN lists l ON li.list_id = l.id
    WHERE LOWER(l.list_type) LIKE '%gift%' AND li.deleted_at IS NULL;
    
    -- Count migrated items
    SELECT COUNT(*) INTO migrated_items
    FROM list_items li
    JOIN lists l ON li.list_id = l.id
    WHERE LOWER(l.list_type) LIKE '%gift%' 
    AND li.gift_detail_id IS NOT NULL 
    AND li.deleted_at IS NULL;
    
    -- Count items that still have custom_fields
    SELECT COUNT(*) INTO items_with_custom_fields
    FROM list_items li
    JOIN lists l ON li.list_id = l.id
    WHERE LOWER(l.list_type) LIKE '%gift%' 
    AND li.custom_fields IS NOT NULL
    AND li.deleted_at IS NULL;
    
    RAISE NOTICE '===========================================';
    RAISE NOTICE 'Final Migration Summary:';
    RAISE NOTICE 'Gift list types found: %', COALESCE(gift_list_types, 'none');
    RAISE NOTICE 'Total gift lists: %', total_gift_lists;
    RAISE NOTICE 'Total items in gift lists: %', total_gift_items;
    RAISE NOTICE 'Items with gift_details: %', migrated_items;
    RAISE NOTICE 'Items still having custom_fields: %', items_with_custom_fields;
    RAISE NOTICE '===========================================';
END $$;

COMMIT;

-- Verification query to see migrated data
/*
SELECT 
    li.id,
    li.title,
    li.custom_fields,
    gd.quantity,
    gd.where_to_buy,
    gd.amazon_url,
    gd.web_link,
    gd.rating,
    l.list_type,
    l.title as list_title
FROM list_items li
JOIN lists l ON li.list_id = l.id
LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE LOWER(l.list_type) LIKE '%gift%'
ORDER BY l.created_at DESC, li.created_at DESC
LIMIT 20;
*/