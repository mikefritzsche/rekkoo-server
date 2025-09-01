-- Fixed version: Check if gift_details table exists and its structure
SELECT 
    'Table exists' as check_type,
    EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'gift_details'
    ) as result;

-- Check columns in gift_details table
SELECT 
    'Columns in gift_details' as check_type,
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

-- Check what columns actually exist in list_items table
SELECT 
    'Columns in list_items' as check_type,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'public' 
AND table_name = 'list_items'
AND column_name IN ('quantity', 'where_to_buy', 'amazon_url', 'web_link', 'rating', 'custom_fields', 'gift_detail_id')
ORDER BY column_name;

-- Check for any existing gift_details records
SELECT 
    'Record count in gift_details' as check_type,
    COUNT(*) as count
FROM public.gift_details;

-- Check for gift list items without gift_detail_id
-- (This doesn't check for gift fields since they may not exist in list_items)
SELECT 
    'Gift items without gift_detail_id' as check_type,
    COUNT(*) as count
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL;

-- Sample of gift list items without gift_details
-- Check if gift data is in custom_fields JSON
SELECT 
    li.id,
    li.title,
    li.gift_detail_id,
    l.list_type,
    li.custom_fields,
    li.created_at
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.gift_detail_id IS NULL
AND li.deleted_at IS NULL
ORDER BY li.created_at DESC
LIMIT 5;

-- Check if any gift list items have gift data in custom_fields
SELECT 
    'Gift items with data in custom_fields' as check_type,
    li.id,
    li.title,
    li.custom_fields::text as custom_fields_preview
FROM public.list_items li
JOIN public.lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts'
AND li.custom_fields IS NOT NULL
AND li.custom_fields::text != '{}'
AND li.deleted_at IS NULL
LIMIT 3;

-- Check for any orphaned gift_details records (no matching list_item)
SELECT 
    'Orphaned gift_details' as check_type,
    COUNT(*) as count
FROM public.gift_details gd
WHERE NOT EXISTS (
    SELECT 1 FROM public.list_items li 
    WHERE li.id = gd.list_item_id
);

-- Check if there are ANY gift lists in the system
SELECT 
    'Gift lists count' as check_type,
    COUNT(*) as count
FROM public.lists
WHERE list_type = 'gifts'
AND deleted_at IS NULL;