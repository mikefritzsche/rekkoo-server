-- Debug Script: Investigate why gift_details migration didn't work
-- Run each section to understand your data structure

-- 1. Check what list_type values actually exist (might be 'gifts' instead of 'gift')
SELECT DISTINCT list_type, COUNT(*) as count 
FROM lists 
WHERE deleted_at IS NULL
GROUP BY list_type
ORDER BY list_type;

-- 2. Find all potential gift lists (check various spellings)
SELECT id, title, list_type, created_at
FROM lists
WHERE (
    LOWER(list_type) LIKE '%gift%' 
    OR LOWER(title) LIKE '%gift%'
    OR LOWER(list_type) = 'gifts'
    OR LOWER(list_type) = 'gift'
)
AND deleted_at IS NULL
ORDER BY created_at DESC;

-- 3. Check if those lists have any items
SELECT 
    l.id as list_id,
    l.title as list_title,
    l.list_type,
    COUNT(li.id) as item_count
FROM lists l
LEFT JOIN list_items li ON l.id = li.list_id AND li.deleted_at IS NULL
WHERE LOWER(l.list_type) LIKE '%gift%'
AND l.deleted_at IS NULL
GROUP BY l.id, l.title, l.list_type;

-- 4. Look at actual items in gift lists to see their structure
SELECT 
    li.id,
    li.title,
    li.description,
    li.price,
    li.gift_detail_id,
    li.custom_fields,
    l.list_type,
    l.title as list_title
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE LOWER(l.list_type) LIKE '%gift%'
AND li.deleted_at IS NULL
LIMIT 10;

-- 5. Check if any items have gift-related data in custom_fields
SELECT 
    li.id,
    li.title,
    li.custom_fields,
    l.list_type
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE li.custom_fields IS NOT NULL
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
AND li.deleted_at IS NULL;

-- 6. Check if gift_details table exists and has any data
SELECT 
    'gift_details table exists' as check,
    EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'gift_details'
    ) as result
UNION ALL
SELECT 
    'gift_details has data',
    EXISTS (SELECT 1 FROM gift_details LIMIT 1);

-- 7. Find the exact list_type for your gift lists
SELECT 
    list_type,
    COUNT(*) as list_count,
    STRING_AGG(title, ', ' ORDER BY title) as list_titles
FROM lists
WHERE deleted_at IS NULL
GROUP BY list_type
HAVING LOWER(list_type) LIKE '%gift%';

-- 8. Count items that would be migrated if list_type = 'gifts' (plural)
SELECT 
    COUNT(*) as items_to_migrate
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'  -- Note: using 'gifts' plural
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL;