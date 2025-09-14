# Privacy Settings Migration Summary

## Problem
The database had an inconsistency where:
- **Frontend**: Used `user_settings` table with a `privacy_settings` JSONB field
- **Backend**: Was referencing a separate `user_privacy_settings` table

## Solution
Unified the database structure to match the frontend by migrating all privacy settings to the `user_settings.privacy_settings` JSONB field.

## Changes Made

### 1. Migration Script (050_migrate_privacy_to_user_settings.sql)
- Migrates all data from `user_privacy_settings` table to `user_settings.privacy_settings` JSONB field
- Preserves all existing privacy settings including:
  - privacy_mode (private/standard/public)
  - show_email_to_connections
  - allow_connection_requests
  - allow_group_invites_from_connections
  - searchable_by_username/email/name
  - show_mutual_connections
  - connection_code
- Creates triggers to handle privacy mode changes and connection code generation
- Adds appropriate indexes for performance

### 2. Backend Controller Updates (ConnectionsController.js)
Updated all queries to read from `user_settings.privacy_settings` instead of `user_privacy_settings`:
- `getPendingRequests()` - Shows user info based on privacy settings
- `getSentRequests()` - Respects recipient's privacy settings
- `getConnections()` - Shows email only when allowed
- `getPrivacySettings()` - Reads from user_settings table
- `updatePrivacySettings()` - Updates user_settings table
- `searchUsers()` - Respects searchable settings

### 3. Cleanup Migration (051_drop_user_privacy_settings_table.sql)
- Verifies all data has been migrated successfully
- Drops the old `user_privacy_settings` table
- Removes obsolete triggers and functions
- **Only run after verifying the migration is successful!**

## Migration Steps

1. **Run migration 050** to migrate data to user_settings table
   ```sql
   -- In your SQL client
   \i /app/sql/migrations/050_migrate_privacy_to_user_settings.sql
   ```

2. **Test the application** to verify:
   - Privacy settings can be viewed and updated
   - Connection requests respect privacy settings
   - User search respects privacy settings

3. **After verification, run migration 051** to clean up
   ```sql
   -- Only after confirming everything works!
   \i /app/sql/migrations/051_drop_user_privacy_settings_table.sql
   ```

## Benefits
- Consistent database structure between frontend and backend
- Simpler data model with fewer tables
- All user settings in one place
- Easier to maintain and extend

## Rollback Plan
If issues arise before running migration 051:
- The `user_privacy_settings` table is still intact
- Can revert ConnectionsController.js changes
- Data is duplicated, not moved, so no data loss