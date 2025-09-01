-- Verification queries for gift_details migration
-- Run these queries to confirm the migration was successful

-- 1. Check how many gift lists exist
SELECT 
    COUNT(*) as gift_list_count,
    STRING_AGG(DISTINCT list_type, ', ') as gift_list_types
FROM lists 
WHERE LOWER(list_type) LIKE '%gift%';

-- 2. Check how many gift_details records were created
SELECT COUNT(*) as gift_details_count 
FROM gift_details;

-- 3. Verify list_items have gift_detail_id populated for items in gift lists
SELECT 
    COUNT(*) as total_gift_items,
    COUNT(li.gift_detail_id) as items_with_gift_detail_id,
    COUNT(*) - COUNT(li.gift_detail_id) as items_missing_gift_detail_id
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE LOWER(l.list_type) LIKE '%gift%';

-- 4. Show sample of migrated gift_details data
SELECT 
    gd.id,
    gd.quantity,
    gd.where_to_buy,
    gd.amazon_url,
    gd.web_link,
    gd.rating,
    li.name as item_name,
    l.name as list_name
FROM gift_details gd
JOIN list_items li ON li.gift_detail_id = gd.id
JOIN lists l ON li.list_id = l.id
LIMIT 5;

-- 5. Check for any orphaned gift_details (shouldn't be any)
SELECT COUNT(*) as orphaned_gift_details
FROM gift_details gd
WHERE NOT EXISTS (
    SELECT 1 FROM list_items li WHERE li.gift_detail_id = gd.id
);

-- 6. Verify custom_fields remained in list_items (not moved to gift_details)
SELECT 
    COUNT(*) as items_with_custom_fields,
    COUNT(DISTINCT li.list_id) as lists_with_custom_fields
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE LOWER(l.list_type) LIKE '%gift%'
AND li.custom_fields IS NOT NULL 
AND li.custom_fields != '{}'::jsonb;

-- 7. Summary report
WITH gift_stats AS (
    SELECT 
        COUNT(DISTINCT l.id) as gift_lists,
        COUNT(DISTINCT li.id) as gift_items,
        COUNT(DISTINCT gd.id) as gift_details_records,
        COUNT(DISTINCT CASE WHEN li.gift_detail_id IS NOT NULL THEN li.id END) as linked_items
    FROM lists l
    LEFT JOIN list_items li ON li.list_id = l.id
    LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
    WHERE LOWER(l.list_type) LIKE '%gift%'
)
SELECT 
    gift_lists,
    gift_items,
    gift_details_records,
    linked_items,
    CASE 
        WHEN gift_items = linked_items AND gift_items = gift_details_records 
        THEN '✅ Migration successful - all items linked'
        WHEN gift_items > linked_items 
        THEN '⚠️ Some items not linked to gift_details'
        ELSE '✅ Migration complete'
    END as status
FROM gift_stats;