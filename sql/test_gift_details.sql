-- Test Queries for Gift Details Implementation
-- Run these queries to verify the gift_details table is working correctly

-- 1. Check if gift_details table exists and has the correct structure
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'gift_details'
ORDER BY ordinal_position;

-- 2. Check if gift_detail_id column was added to list_items
SELECT 
    column_name, 
    data_type 
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'list_items' 
AND column_name = 'gift_detail_id';

-- 3. Check the updated constraint
SELECT 
    conname, 
    pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint 
WHERE conname = 'chk_one_detail_type';

-- 4. View all gift lists and their item counts
SELECT 
    l.id as list_id,
    l.title as list_title,
    l.list_type,
    COUNT(li.id) as item_count,
    COUNT(li.gift_detail_id) as items_with_gift_details
FROM lists l
LEFT JOIN list_items li ON l.id = li.list_id AND li.deleted_at IS NULL
WHERE l.list_type = 'gift' AND l.deleted_at IS NULL
GROUP BY l.id, l.title, l.list_type
ORDER BY l.created_at DESC;

-- 5. View gift items with their details
SELECT 
    li.id,
    li.title,
    li.description,
    li.price,
    li.gift_detail_id,
    gd.quantity,
    gd.where_to_buy,
    gd.amazon_url,
    gd.web_link,
    gd.rating as gift_rating,
    l.title as list_title
FROM list_items li
JOIN lists l ON li.list_id = l.id
LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE l.list_type = 'gift' 
AND li.deleted_at IS NULL
ORDER BY l.created_at DESC, li.created_at DESC
LIMIT 20;

-- 6. Check for orphaned gift_details (should return 0 rows)
SELECT 
    gd.id,
    gd.list_item_id
FROM gift_details gd
LEFT JOIN list_items li ON gd.list_item_id = li.id
WHERE li.id IS NULL;

-- 7. Check for items with multiple detail types (should return 0 rows)
SELECT 
    id,
    title,
    (CASE WHEN movie_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN book_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN place_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN spotify_item_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN tv_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN recipe_detail_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN gift_detail_id IS NOT NULL THEN 1 ELSE 0 END) as detail_count
FROM list_items
WHERE deleted_at IS NULL
HAVING (CASE WHEN movie_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN book_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN place_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN spotify_item_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN tv_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN recipe_detail_id IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN gift_detail_id IS NOT NULL THEN 1 ELSE 0 END) > 1;

-- 8. Test creating a new gift item with details (transaction example)
/*
BEGIN;

-- Create a gift detail record
INSERT INTO gift_details (list_item_id, quantity, where_to_buy, amazon_url, web_link, rating)
VALUES (
    'YOUR_ITEM_ID_HERE',  -- Replace with actual item ID
    2,
    'Target',
    'https://amazon.com/example',
    'https://target.com/example',
    5
) RETURNING id;

-- Update the list_item with the gift_detail_id
UPDATE list_items 
SET gift_detail_id = 'RETURNED_ID_FROM_ABOVE'
WHERE id = 'YOUR_ITEM_ID_HERE';

-- Verify the relationship
SELECT 
    li.id,
    li.title,
    gd.*
FROM list_items li
JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE li.id = 'YOUR_ITEM_ID_HERE';

ROLLBACK; -- Or COMMIT if you want to keep the test data
*/

-- 9. Summary statistics
WITH stats AS (
    SELECT 
        COUNT(DISTINCT l.id) as total_gift_lists,
        COUNT(DISTINCT li.id) as total_gift_items,
        COUNT(DISTINCT gd.id) as total_gift_details,
        COUNT(DISTINCT gr.id) as total_gift_reservations
    FROM lists l
    LEFT JOIN list_items li ON l.id = li.list_id AND li.deleted_at IS NULL
    LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
    LEFT JOIN gift_reservations gr ON li.id = gr.item_id AND gr.deleted_at IS NULL
    WHERE l.list_type = 'gift' AND l.deleted_at IS NULL
)
SELECT 
    total_gift_lists,
    total_gift_items,
    total_gift_details,
    ROUND((total_gift_details::numeric / NULLIF(total_gift_items, 0) * 100), 2) as pct_items_with_details,
    total_gift_reservations
FROM stats;