# Gift Details Migration - Quick Start Guide

## Step 1: Apply Database Changes

Run these commands in order on your PostgreSQL database:

```bash
# 1. Create gift_details table and update list_items
psql -U your_user -d your_database -f sql/migrations/037_create_gift_details_table_safe.sql

# 2. Migrate existing gift items to the new structure
psql -U your_user -d your_database -f sql/migrations/039_migrate_gift_items_to_details_fixed.sql

# 3. Verify everything worked
psql -U your_user -d your_database -f sql/test_gift_details.sql
```

## Step 2: Deploy Code Changes

### Server (Node.js)
The following files have been updated:
- ✅ `src/controllers/SyncController.js` - Added gift to DETAIL_TABLES_MAP
- ✅ `src/services/ListService.js` - Added gift_details column mapping

Deploy these changes to your server.

### App (React Native)
The following files have been updated:
- ✅ `store/listTypes.ts` - Added detail_id fields to ListItem type
- ✅ `services/storage/sync/sync-transformers.ts` - Handle gift_details in sync
- ✅ `services/storage/schemas/rekkoo_main_schema.sql` - Added gift_details table
- ✅ `services/storage/schemas/web-schema.ts` - Added gift_details table
- ✅ `services/storage/migrations/add_gift_details_table.ts` - Migration v34
- ✅ `services/storage/constants.ts` - Bumped version to 4

The app will automatically run migrations when launched with the new version.

## Step 3: Verify Migration Success

Run this query to check the migration status:

```sql
-- Check migration results
SELECT 
    'Gift Lists' as metric,
    COUNT(DISTINCT l.id) as count
FROM lists l 
WHERE l.list_type = 'gift' AND l.deleted_at IS NULL
UNION ALL
SELECT 
    'Gift Items Total',
    COUNT(DISTINCT li.id)
FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE l.list_type = 'gift' AND li.deleted_at IS NULL
UNION ALL
SELECT 
    'Items with gift_details',
    COUNT(DISTINCT li.id)
FROM list_items li
WHERE li.gift_detail_id IS NOT NULL AND li.deleted_at IS NULL
UNION ALL
SELECT 
    'Gift Details Records',
    COUNT(*)
FROM gift_details;
```

## Expected Results

After successful migration:
- ✅ gift_details table exists
- ✅ list_items has gift_detail_id column
- ✅ Existing gift items have been migrated to gift_details
- ✅ Check constraint includes gift_detail_id
- ✅ App and server can sync gift data

## Quick Test

Create a test gift item to verify everything works:

```sql
-- Test creating a gift item with details
BEGIN;

-- Insert a test gift detail
INSERT INTO gift_details (quantity, where_to_buy, amazon_url, rating)
VALUES (2, 'Amazon', 'https://amazon.com/test', 5)
RETURNING id;

-- Note the returned ID and use it below
-- INSERT INTO list_items (title, list_id, owner_id, gift_detail_id)
-- VALUES ('Test Gift Item', 'YOUR_LIST_ID', 'YOUR_USER_ID', 'RETURNED_ID_FROM_ABOVE');

ROLLBACK; -- Or COMMIT if you want to keep the test
```

## Support

If you encounter issues:
1. Check that all migration scripts ran successfully
2. Verify server code was updated and restarted
3. Ensure app has the new schema version (4)
4. Review logs for any sync errors

The migration is designed to be safe and idempotent - you can run it multiple times without issues.