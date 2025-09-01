# Gift Details Issue Resolution

## Problem Summary
The `gift_details` table exists in PostgreSQL but records weren't being created when gift items were added. The verification SQL query failed because it was looking for gift fields (quantity, where_to_buy, etc.) as columns on `list_items` table, but these fields are actually stored in the `custom_fields` JSON column.

## Database Schema Reality

### PostgreSQL Structure
- **list_items table**: Has `gift_detail_id` column (foreign key) but NOT individual gift field columns
- **Gift data location**: Stored in `custom_fields` JSONB column with keys like:
  - `quantity`, `whereToBuy`/`where_to_buy`, `amazonUrl`/`amazon_url`, `webLink`/`web_link`, `rating`
- **gift_details table**: Properly created with all necessary columns

### Client-Side (SQLite)
- The app's local SQLite database may have gift fields directly on list_items (legacy)
- Client sends gift data through sync in snake_case format via `prepareDataForSync`

## Issues Found and Fixed

### 1. Server-Side SyncController
**Issue**: Missing cases for 'gift'/'gifts' list types
**Fix**: Added gift cases in both CREATE and UPDATE operations
```javascript
case 'gift':
case 'gifts':
    detailTable = 'gift_details';
    detailIdColumn = 'gift_detail_id';
    break;
```

### 2. Server-Side ListService Column Mapping
**Issue**: Wrong field mapping (camelCase instead of snake_case)
**Fix**: Corrected mapping in ListService.js:
```javascript
gift_details: {
    quantity: 'quantity',
    where_to_buy: 'where_to_buy',  // was 'whereToBuy'
    amazon_url: 'amazon_url',      // was 'amazonUrl'
    web_link: 'web_link',          // was 'webLink'
    rating: 'rating'
}
```

### 3. Data Source for gift_details
**Issue**: Using only `api_metadata` instead of full item data
**Fix**: Pass full `createData` for gift items:
```javascript
const detailSource = detailTable === 'gift_details' ? createData : 
                    (detailTable === 'place_details' && createData.raw) ? createData.raw : createData.api_metadata;
```

## SQL Scripts Created

### 1. verify_gift_details_table_fixed.sql
- Checks table existence and structure
- Looks for gift data in `custom_fields` JSON (not as direct columns)
- Counts gift items without `gift_detail_id`

### 2. migrate_gift_custom_fields.sql
- Extracts gift data from `custom_fields` JSON
- Creates `gift_details` records
- Updates `list_items` with `gift_detail_id`
- Handles both camelCase and snake_case field names

### 3. create_gift_details_trigger.sql
- PostgreSQL trigger to auto-create `gift_details` for gift items
- Extracts data from `custom_fields` automatically
- Ensures all gift items have associated `gift_details` records

## Resolution Steps

1. **Deploy server changes** (SyncController.js and ListService.js)

2. **Run verification**:
   ```bash
   psql -d your_database -f sql/verify_gift_details_table_fixed.sql
   ```

3. **Migrate existing data** (if needed):
   ```bash
   psql -d your_database -f sql/migrate_gift_custom_fields.sql
   ```

4. **Optional: Install trigger** for automatic gift_details creation:
   ```bash
   psql -d your_database -f sql/create_gift_details_trigger.sql
   ```

5. **Test**: Add a new gift item and verify:
   - Check server logs for debug output
   - Verify `gift_details` record is created
   - Confirm `gift_detail_id` is set on `list_items`

## How It Works Now

### When Adding Gift Item:
1. Client sends item with gift fields in snake_case
2. Server detects `list_type = 'gifts'`
3. SyncController calls `ListService.createDetailRecord`
4. ListService extracts gift fields from item data
5. `gift_details` record is created
6. `list_items.gift_detail_id` is updated with foreign key

### Data Flow:
```
Client (SQLite) → prepareDataForSync → Server (PostgreSQL)
    ↓                                        ↓
gift fields                           custom_fields JSON
(may be direct)                       + gift_details table
```

## Monitoring

Enable debug logging to track gift_details creation:
- Look for: `[SyncController] CREATE: Detected gift list type`
- Look for: `[ListService.createDetailRecord] Processing gift_details`

## Future Considerations

1. Consider removing gift fields from `custom_fields` after successful migration
2. Ensure all gift data flows through `gift_details` table
3. Update client to fetch gift data from joined `gift_details` table