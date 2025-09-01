# Gift Migration Troubleshooting Guide

## Problem: Migration ran but no gift_details were created

This usually happens because the migration is looking for `list_type = 'gift'` but your lists might have `list_type = 'gifts'` (plural) or another variation.

## Step 1: Debug Your Data

Run the debug script to understand your data:

```bash
psql -U your_user -d your_database -f sql/debug_gift_migration.sql
```

This will show you:
1. What list_type values actually exist in your database
2. Which lists are gift lists
3. Whether those lists have items
4. Whether items have gift data in custom_fields

## Step 2: Check the Most Important Query

Run this specific query to see your actual gift list types:

```sql
SELECT DISTINCT list_type, COUNT(*) as count 
FROM lists 
WHERE LOWER(list_type) LIKE '%gift%'
GROUP BY list_type;
```

Common values we see:
- `gift` (singular)
- `gifts` (plural) ← Most likely your case
- `Gift` or `Gifts` (capitalized)
- `gift_list`, `gift-list`, etc.

## Step 3: Run the Adaptive Migration

I've created an adaptive migration script that handles ANY variation of gift list types:

```bash
psql -U your_user -d your_database -f sql/migrations/039_migrate_gift_items_to_details_adaptive.sql
```

This script:
- ✅ Handles 'gift', 'gifts', 'Gift', 'Gifts', etc.
- ✅ Uses LIKE '%gift%' to catch any variation
- ✅ Also checks custom_fields for gift data
- ✅ Shows detailed progress and summary

## Step 4: Verify Success

After running the adaptive migration, check if it worked:

```sql
-- Check if gift_details were created
SELECT COUNT(*) FROM gift_details;

-- See the migrated data
SELECT 
    li.title,
    gd.*,
    l.list_type
FROM list_items li
JOIN lists l ON li.list_id = l.id
JOIN gift_details gd ON li.gift_detail_id = gd.id
LIMIT 10;
```

## Quick Fix if Your list_type is 'gifts' (plural)

If you know your list_type is specifically 'gifts', you can also manually update the original migration:

In `039_migrate_gift_items_to_details_v3.sql`, change:
```sql
-- FROM:
AND l.list_type = 'gift'

-- TO:
AND l.list_type = 'gifts'
```

Then run it again.

## Still Not Working?

If items still aren't migrating, check:

1. **Do the items exist?**
```sql
SELECT COUNT(*) FROM list_items li
JOIN lists l ON li.list_id = l.id
WHERE l.list_type = 'gifts';  -- or your actual list_type
```

2. **Do items already have gift_detail_id?**
```sql
SELECT COUNT(*) FROM list_items 
WHERE gift_detail_id IS NOT NULL;
```

3. **Is the gift_details table created?**
```sql
\dt gift_details
```

## Summary

The most common issue is the list_type mismatch:
- Migration looks for: `list_type = 'gift'`
- Your database has: `list_type = 'gifts'`

The adaptive migration script (`039_migrate_gift_items_to_details_adaptive.sql`) solves this by matching ANY gift-like list_type.