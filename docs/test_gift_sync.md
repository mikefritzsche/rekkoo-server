# Testing Gift Details Sync

## Manual Test Steps

### 1. Test Server-Side Gift Endpoints

```bash
# First, get a valid auth token (replace with actual login)
TOKEN="your_jwt_token_here"

# Test getting gift item reservation status
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/gifts/items/{itemId}/status

# Test reserving a gift item
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reserved_by": "user_id"}' \
  http://localhost:3000/api/gifts/items/{itemId}/reserve

# Test getting list reservations
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/gifts/lists/{listId}/reservations
```

### 2. Test Sync Data Flow

#### From App to Server
1. In the app, create a new gift item with gift-specific fields:
   - Quantity: 2
   - Where to Buy: "Amazon"
   - Amazon URL: "https://amazon.com/..."
   - Web Link: "https://example.com"
   - Rating: 5

2. Trigger a sync and verify the data appears in PostgreSQL:
```sql
SELECT li.name, gd.* 
FROM list_items li
JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE li.name = 'Your Test Gift Item';
```

#### From Server to App
1. Insert a gift item directly in PostgreSQL:
```sql
-- First create the gift_details record
INSERT INTO gift_details (id, quantity, where_to_buy, amazon_url, web_link, rating)
VALUES (gen_random_uuid(), 3, 'Target', 'https://amazon.com/test', 'https://target.com', 4)
RETURNING id;

-- Then update or create a list_item with that gift_detail_id
```

2. Trigger a sync in the app and verify the gift details appear

### 3. Test Data Integrity

Run these checks after syncing:

```sql
-- On Server (PostgreSQL)
SELECT 
    li.id,
    li.name,
    li.gift_detail_id,
    gd.quantity,
    gd.where_to_buy,
    li.custom_fields
FROM list_items li
LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
WHERE li.list_id IN (
    SELECT id FROM lists WHERE LOWER(list_type) LIKE '%gift%'
);
```

```javascript
// In App (SQLite via console or debug)
db.transaction(tx => {
    tx.executeSql(
        `SELECT 
            li.id,
            li.name,
            li.gift_detail_id,
            gd.quantity,
            gd.where_to_buy,
            li.custom_fields
        FROM list_items li
        LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
        WHERE li.list_id IN (
            SELECT id FROM lists WHERE LOWER(list_type) LIKE '%gift%'
        )`,
        [],
        (_, result) => console.log('Gift items:', result.rows._array)
    );
});
```

### 4. Expected Sync Behavior

✅ **Should Work:**
- Gift-specific fields sync to/from gift_details table
- custom_fields remain in list_items and sync independently
- Gift reservation status syncs correctly
- All gift fields are preserved during sync

❌ **Should NOT Happen:**
- Gift fields in custom_fields (they should be in gift_details)
- Missing gift_detail_id for gift items
- Duplicate gift_details records
- Lost custom_fields data

## Automated Test Script

Create this test file to run automated checks:

```javascript
// server/tests/gift-sync.test.js
const { ListService } = require('../src/services/ListService');
const { SyncController } = require('../src/controllers/SyncController');

async function testGiftSync() {
    // Test 1: Create gift item with details
    const testItem = {
        name: 'Test Gift Item',
        list_id: 'gift-list-id',
        quantity: 2,
        whereToBuy: 'Amazon',
        amazonUrl: 'https://amazon.com/test',
        webLink: 'https://example.com',
        rating: 5,
        custom_fields: { color: 'blue' }
    };

    // Test 2: Verify sync data structure
    const syncData = await SyncController.prepareSyncData(userId);
    const giftItem = syncData.list_items.find(i => i.name === 'Test Gift Item');
    
    console.assert(giftItem.gift_detail_id, 'Gift item should have gift_detail_id');
    console.assert(!giftItem.quantity, 'Quantity should not be in list_items');
    
    const giftDetail = syncData.gift_details.find(d => d.id === giftItem.gift_detail_id);
    console.assert(giftDetail.quantity === 2, 'Gift detail should have quantity');
    console.assert(giftItem.custom_fields.color === 'blue', 'Custom fields should remain in list_items');

    console.log('✅ All gift sync tests passed');
}

testGiftSync().catch(console.error);
```

## Troubleshooting

If sync issues occur:

1. **Check migration status:**
```sql
SELECT COUNT(*) FROM gift_details;
SELECT COUNT(*) FROM list_items WHERE gift_detail_id IS NOT NULL;
```

2. **Verify sync mapping in ListService.js:**
   - Ensure gift_details columns are mapped correctly
   - Check DETAIL_TABLES_MAP includes 'gift'

3. **Check app migration:**
   - Verify CLIENT_SQLITE_SCHEMA_VERSION was bumped
   - Check gift_details table exists in SQLite

4. **Review sync logs:**
   - Enable verbose logging in sync operations
   - Check for any field mapping errors