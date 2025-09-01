-- Script to migrate gift data from custom_fields to gift_details table
-- Run this after verifying the structure with verify_gift_details_table_fixed.sql

-- First, let's see what gift data exists in custom_fields
SELECT 
    'Gift items with custom_fields data' as check_type,
    li.id,
    li.title,
    l.list_type,
    li.custom_fields->>'quantity' as quantity,
    li.custom_fields->>'whereToBuy' as where_to_buy_camel,
    li.custom_fields->>'where_to_buy' as where_to_buy_snake,
    li.custom_fields->>'amazonUrl' as amazon_url_camel,
    li.custom_fields->>'amazon_url' as amazon_url_snake,
    li.custom_fields->>'webLink' as web_link_camel,
    li.custom_fields->>'web_link' as web_link_snake,
    li.custom_fields->>'rating' as rating,
    li.gift_detail_id
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL
AND li.custom_fields IS NOT NULL
LIMIT 10;

-- Create gift_details records for items that have gift data in custom_fields
-- This handles both camelCase and snake_case field names
BEGIN;

DO $$
DECLARE
    item_record RECORD;
    new_detail_id uuid;
    created_count integer := 0;
BEGIN
    RAISE NOTICE 'Starting migration of gift data from custom_fields to gift_details...';
    
    FOR item_record IN 
        SELECT 
            li.id as item_id,
            li.title,
            li.custom_fields,
            li.gift_detail_id
        FROM list_items li
        JOIN lists l ON li.list_id = l.id
        WHERE l.list_type = 'gifts'
        AND li.gift_detail_id IS NULL
        AND li.deleted_at IS NULL
        AND li.custom_fields IS NOT NULL
    LOOP
        -- Check if this item has any gift fields in custom_fields
        IF (item_record.custom_fields ? 'quantity' OR
            item_record.custom_fields ? 'whereToBuy' OR
            item_record.custom_fields ? 'where_to_buy' OR
            item_record.custom_fields ? 'amazonUrl' OR
            item_record.custom_fields ? 'amazon_url' OR
            item_record.custom_fields ? 'webLink' OR
            item_record.custom_fields ? 'web_link' OR
            item_record.custom_fields ? 'rating') THEN
            
            -- Generate new UUID for gift_details
            new_detail_id := gen_random_uuid();
            
            -- Insert gift_details record
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
                new_detail_id,
                item_record.item_id,
                -- Try to get quantity as integer
                CASE 
                    WHEN item_record.custom_fields ? 'quantity' THEN 
                        (item_record.custom_fields->>'quantity')::integer
                    ELSE NULL 
                END,
                -- Prefer camelCase, fallback to snake_case
                COALESCE(
                    item_record.custom_fields->>'whereToBuy',
                    item_record.custom_fields->>'where_to_buy'
                ),
                COALESCE(
                    item_record.custom_fields->>'amazonUrl',
                    item_record.custom_fields->>'amazon_url'
                ),
                COALESCE(
                    item_record.custom_fields->>'webLink',
                    item_record.custom_fields->>'web_link'
                ),
                -- Try to get rating as integer
                CASE 
                    WHEN item_record.custom_fields ? 'rating' THEN 
                        (item_record.custom_fields->>'rating')::integer
                    ELSE NULL 
                END,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (list_item_id) DO NOTHING;
            
            -- Update list_item with gift_detail_id
            UPDATE list_items 
            SET gift_detail_id = new_detail_id,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = item_record.item_id
            AND gift_detail_id IS NULL;
            
            created_count := created_count + 1;
            RAISE NOTICE 'Created gift_details for item: % (%)', item_record.item_id, item_record.title;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Migration complete. Created % gift_details records.', created_count;
END $$;

-- Verify the migration
SELECT 
    'After migration - Gift items with gift_details' as check_type,
    COUNT(*) as count
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NOT NULL
AND li.deleted_at IS NULL;

-- Show sample of migrated records
SELECT 
    li.id,
    li.title,
    li.gift_detail_id,
    gd.quantity,
    gd.where_to_buy,
    gd.amazon_url,
    gd.web_link,
    gd.rating
FROM public.list_items li
JOIN public.gift_details gd ON li.gift_detail_id = gd.id
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
ORDER BY gd.created_at DESC
LIMIT 5;

COMMIT;