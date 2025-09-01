-- Check if gift_details table exists and its structure
SELECT 
    'Table exists' as check_type,
    EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'gift_details'
    ) as result;

-- Check columns in gift_details table
SELECT 
    'Columns' as check_type,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
AND table_name = 'gift_details'
ORDER BY ordinal_position;

-- Check if gift_detail_id column exists in list_items
SELECT 
    'gift_detail_id in list_items' as check_type,
    EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'list_items'
        AND column_name = 'gift_detail_id'
    ) as result;

-- Check for any existing gift_details records
SELECT 
    'Record count' as check_type,
    COUNT(*) as count
FROM public.gift_details;

-- Check for list_items with gift fields but no gift_detail_id
SELECT 
    'Items with gift fields but no gift_detail_id' as check_type,
    COUNT(*) as count
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL
AND (
    li.quantity IS NOT NULL OR
    li.where_to_buy IS NOT NULL OR
    li.amazon_url IS NOT NULL OR
    li.web_link IS NOT NULL OR
    li.rating IS NOT NULL
);

-- Sample of gift list items without gift_details
SELECT 
    li.id,
    li.title,
    li.gift_detail_id,
    li.quantity,
    li.where_to_buy,
    li.amazon_url,
    li.web_link,
    li.rating,
    l.list_type,
    li.created_at
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL
ORDER BY li.created_at DESC
LIMIT 5;