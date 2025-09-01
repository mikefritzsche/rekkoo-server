# Gift Details Implementation Guide

## Overview
This guide covers the implementation of the `gift_details` table to store gift-specific metadata, following the same pattern as other detail tables (movie_details, book_details, etc.).

## Database Structure

### Key Points:
- `list_type` is in the **lists** table, NOT list_items
- `custom_fields` stays in **list_items** table (not moved to gift_details)
- Only 5 specific fields go to **gift_details** table

### Tables Relationship:
```
lists (has list_type='gift') → list_items (has custom_fields) → gift_details (has gift fields)
```

### gift_details Table Fields:
- `id` (UUID, PK)
- `list_item_id` (UUID, FK to list_items)
- `quantity` (integer)
- `where_to_buy` (text)
- `amazon_url` (text)
- `web_link` (text)
- `rating` (integer)
- `created_at`, `updated_at` (timestamps)

## Migration Files

### Clean Structure - Only 3 Essential Files:

1. **`037_create_gift_details_table_safe.sql`** - Main migration (idempotent)
2. **`039_migrate_gift_items_to_details_v3.sql`** - Data migration (fixed: no change_log)
3. **`test_gift_details.sql`** - Verification queries

## Step-by-Step Migration

### 1. Run Database Migrations

```bash
# Create gift_details table (safe to run multiple times)
psql -U your_user -d your_database -f sql/migrations/037_create_gift_details_table_safe.sql

# Migrate existing gift data
psql -U your_user -d your_database -f sql/migrations/039_migrate_gift_items_to_details_v3.sql

# Verify migration
psql -U your_user -d your_database -f sql/test_gift_details.sql
```

### 2. Deploy Code Changes

#### Server Files Updated:
- `src/controllers/SyncController.js` - Added `gift: 'gift_details'` to DETAIL_TABLES_MAP
- `src/services/ListService.js` - Added gift_details column mapping

#### App Files Updated:
- `store/listTypes.ts` - Added detail_id fields
- `services/storage/sync/sync-transformers.ts` - Handle gift_details
- `services/storage/schemas/*` - Added gift_details table
- `services/storage/constants.ts` - Version bumped to 4

## How It Works

### Data Flow:

1. **Gift items are identified by:**
   - Items in lists where `list_type = 'gift'`
   - JOIN required: `list_items JOIN lists ON list_id`

2. **Migration extracts gift fields:**
   - FROM: `custom_fields` (if they exist there)
   - TO: `gift_details` table
   - `custom_fields` remains in list_items with other data

3. **Sync process:**
   - Server creates/updates gift_details for gift fields
   - Links via gift_detail_id
   - Returns both list_item and gift_details data

## Verification Queries

```sql
-- Check migration status
SELECT 
    'Gift Lists' as metric, COUNT(DISTINCT l.id) as count
FROM lists l WHERE l.list_type = 'gift' AND l.deleted_at IS NULL
UNION ALL
SELECT 
    'Items with gift_details', COUNT(*)
FROM list_items WHERE gift_detail_id IS NOT NULL;

-- View gift items with details
SELECT 
    li.title,
    li.custom_fields,  -- Still exists
    gd.*
FROM list_items li
JOIN lists l ON li.list_id = l.id
LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE l.list_type = 'gift'
LIMIT 10;
```

## Important Notes

1. **custom_fields behavior:**
   - Remains in list_items table
   - Can contain non-gift custom data
   - Gift fields are extracted but custom_fields preserved

2. **Backward compatibility:**
   - Server handles both old format (fields in item) and new (gift_details)
   - App migration runs automatically on launch

3. **Gift vs Gift Reservations:**
   - `gift_details` = WHAT the gift is (metadata)
   - `gift_reservations` = WHO reserved/purchased (social features)

## Troubleshooting

### "column gift_detail_id already exists"
Run the safe migration script - it checks for existing structures

### Gift fields not syncing
Verify:
- Server has updated SyncController.js and ListService.js
- App has schema version 4
- Check sync transformers are updated

### Finding gift items
Always JOIN with lists table:
```sql
-- CORRECT
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE l.list_type = 'gift'

-- WRONG (will error)
FROM list_items WHERE list_type = 'gift'  -- list_type doesn't exist here!
```