-- Test creating gift_details records manually
-- This script will help verify the gift_details table is working correctly

-- First, find a gift list item that doesn't have gift_details
SELECT 
    li.id as item_id,
    li.title,
    li.gift_detail_id,
    l.list_type,
    li.quantity,
    li.where_to_buy,
    li.amazon_url,
    li.web_link,
    li.rating
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL
LIMIT 1;

-- Create a gift_details record for a specific item (replace the UUID with actual item_id)
-- Uncomment and run this after identifying an item above
/*
INSERT INTO public.gift_details (
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
    gen_random_uuid(),
    'REPLACE_WITH_ITEM_ID', -- Replace with actual list_item id from above query
    1, -- quantity
    'Amazon', -- where_to_buy
    'https://amazon.com/example', -- amazon_url
    'https://example.com', -- web_link
    5, -- rating
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) 
ON CONFLICT (list_item_id) 
DO UPDATE SET 
    quantity = EXCLUDED.quantity,
    where_to_buy = EXCLUDED.where_to_buy,
    amazon_url = EXCLUDED.amazon_url,
    web_link = EXCLUDED.web_link,
    rating = EXCLUDED.rating,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;
*/

-- After inserting, update the list_item with the gift_detail_id
/*
UPDATE public.list_items 
SET gift_detail_id = (
    SELECT id FROM public.gift_details 
    WHERE list_item_id = 'REPLACE_WITH_ITEM_ID'
)
WHERE id = 'REPLACE_WITH_ITEM_ID'
RETURNING id, title, gift_detail_id;
*/

-- Verify the relationship
/*
SELECT 
    li.id,
    li.title,
    li.gift_detail_id,
    gd.id as detail_id,
    gd.quantity,
    gd.where_to_buy,
    gd.amazon_url,
    gd.web_link,
    gd.rating
FROM public.list_items li
LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id
WHERE li.id = 'REPLACE_WITH_ITEM_ID';
*/