-- Create a PostgreSQL trigger to automatically create gift_details records
-- when items are added to gift lists

-- Create function to handle gift_details creation
CREATE OR REPLACE FUNCTION create_gift_details_for_gift_items()
RETURNS TRIGGER AS $$
DECLARE
    list_type_val text;
    gift_detail_uuid uuid;
BEGIN
    -- Only process for INSERT or UPDATE operations
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Check if this item belongs to a gift list
        SELECT l.list_type INTO list_type_val
        FROM lists l
        WHERE l.id = NEW.list_id;
        
        -- If it's a gift list and no gift_detail_id exists
        IF list_type_val = 'gifts' AND NEW.gift_detail_id IS NULL THEN
            -- Check if there's gift data in custom_fields
            IF NEW.custom_fields IS NOT NULL AND (
                NEW.custom_fields ? 'quantity' OR
                NEW.custom_fields ? 'whereToBuy' OR
                NEW.custom_fields ? 'where_to_buy' OR
                NEW.custom_fields ? 'amazonUrl' OR
                NEW.custom_fields ? 'amazon_url' OR
                NEW.custom_fields ? 'webLink' OR
                NEW.custom_fields ? 'web_link' OR
                NEW.custom_fields ? 'rating'
            ) THEN
                -- Generate new UUID for gift_details
                gift_detail_uuid := gen_random_uuid();
                
                -- Create gift_details record
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
                    gift_detail_uuid,
                    NEW.id,
                    CASE 
                        WHEN NEW.custom_fields ? 'quantity' THEN 
                            (NEW.custom_fields->>'quantity')::integer
                        ELSE NULL 
                    END,
                    COALESCE(
                        NEW.custom_fields->>'whereToBuy',
                        NEW.custom_fields->>'where_to_buy'
                    ),
                    COALESCE(
                        NEW.custom_fields->>'amazonUrl',
                        NEW.custom_fields->>'amazon_url'
                    ),
                    COALESCE(
                        NEW.custom_fields->>'webLink',
                        NEW.custom_fields->>'web_link'
                    ),
                    CASE 
                        WHEN NEW.custom_fields ? 'rating' THEN 
                            (NEW.custom_fields->>'rating')::integer
                        ELSE NULL 
                    END,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (list_item_id) DO UPDATE SET
                    quantity = EXCLUDED.quantity,
                    where_to_buy = EXCLUDED.where_to_buy,
                    amazon_url = EXCLUDED.amazon_url,
                    web_link = EXCLUDED.web_link,
                    rating = EXCLUDED.rating,
                    updated_at = CURRENT_TIMESTAMP;
                
                -- Update the NEW record with gift_detail_id
                NEW.gift_detail_id := gift_detail_uuid;
                
                RAISE NOTICE 'Created gift_details % for item %', gift_detail_uuid, NEW.id;
            ELSIF NEW.gift_detail_id IS NULL THEN
                -- Even if no gift data in custom_fields, create empty gift_details for gift items
                gift_detail_uuid := gen_random_uuid();
                
                INSERT INTO gift_details (
                    id,
                    list_item_id,
                    created_at,
                    updated_at
                ) VALUES (
                    gift_detail_uuid,
                    NEW.id,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (list_item_id) DO NOTHING;
                
                -- Update the NEW record with gift_detail_id
                NEW.gift_detail_id := gift_detail_uuid;
                
                RAISE NOTICE 'Created empty gift_details % for item %', gift_detail_uuid, NEW.id;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS auto_create_gift_details ON list_items;

-- Create the trigger
CREATE TRIGGER auto_create_gift_details
    BEFORE INSERT OR UPDATE ON list_items
    FOR EACH ROW
    EXECUTE FUNCTION create_gift_details_for_gift_items();

-- Test the trigger by updating an existing gift item
-- This should automatically create gift_details if they don't exist
/*
UPDATE list_items 
SET updated_at = CURRENT_TIMESTAMP
WHERE id IN (
    SELECT li.id
    FROM list_items li
    JOIN lists l ON li.list_id = l.id
    WHERE l.list_type = 'gifts'
    AND li.gift_detail_id IS NULL
    AND li.deleted_at IS NULL
    LIMIT 1
);
*/

-- Verify trigger is created
SELECT 
    'Trigger exists' as check_type,
    EXISTS (
        SELECT FROM pg_trigger 
        WHERE tgname = 'auto_create_gift_details'
    ) as result;