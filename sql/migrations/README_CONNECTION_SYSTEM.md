# Connection System Database Migrations

## Overview
This set of migrations implements the connection-based invitation system for Rekkoo, replacing the traditional "friend" system with a privacy-focused "connections" model.

## Migration Files Created

### Core Tables (Phase 1)

1. **040_create_connections_table.sql**
   - Creates the `connections` table for bidirectional user connections
   - Includes status tracking (pending, accepted, blocked, removed)
   - Enforces no self-connections and unique connections per user pair
   - Adds necessary indexes for performance

2. **041_create_connection_invitations_table.sql**
   - Creates the `connection_invitations` table with 30-day expiration
   - Includes auto-generated invitation codes
   - Tracks reminder and expiration notifications
   - Supports inviting users not yet on the platform (via email)

3. **042_create_user_privacy_settings_table.sql**
   - Creates the `user_privacy_settings` table
   - Implements three privacy modes: private, standard, public
   - Auto-generates connection codes for private mode users
   - Automatically creates default settings for all existing users

4. **043_create_group_invitations_table.sql**
   - Creates the `group_invitations` table
   - Enforces connection requirement before group invitations
   - Auto-accepts users into groups when invitation is accepted
   - Integrates with existing `collaboration_groups` table

### Utility Scripts

- **000_connection_system_prerequisites.sql** - Ensures required functions exist (RUN THIS FIRST!)
- **rollback_040_043_connection_system.sql** - Safely removes all migrations if needed
- **test_connection_system.sql** - Verifies all components are working correctly

## How to Apply Migrations

### Step 1: Review the migrations
```bash
# IMPORTANT: Review the prerequisite file first
cat sql/migrations/000_connection_system_prerequisites.sql

# Then review each migration file
cat sql/migrations/040_create_connections_table.sql
cat sql/migrations/041_create_connection_invitations_table.sql
cat sql/migrations/042_create_user_privacy_settings_table.sql
cat sql/migrations/043_create_group_invitations_table.sql
```

### Step 2: Apply prerequisites (REQUIRED!)
```bash
# Run this first to ensure all required functions exist
psql -U admin -d rekkoo_main -f sql/migrations/000_connection_system_prerequisites.sql
```

### Step 3: Apply migrations to your database
```bash
# Connect to your database and run migrations in order
psql -U admin -d rekkoo_main -f sql/migrations/040_create_connections_table.sql
psql -U admin -d rekkoo_main -f sql/migrations/041_create_connection_invitations_table.sql
psql -U admin -d rekkoo_main -f sql/migrations/042_create_user_privacy_settings_table.sql
psql -U admin -d rekkoo_main -f sql/migrations/043_create_group_invitations_table.sql
```

### Step 4: Verify the migrations
```bash
# Run the test script to verify everything is working
psql -U admin -d rekkoo_main -f sql/migrations/test_connection_system.sql
```

### If you need to rollback
```bash
# This will remove all the connection system tables and functions
psql -U admin -d rekkoo_main -f sql/migrations/rollback_040_043_connection_system.sql
```

## Key Features Implemented

### Connection System
- **Bidirectional connections** - Both users must accept
- **Connection status tracking** - pending, accepted, blocked, removed
- **Cascade deletion** - Removing a connection removes all associated access

### Privacy Settings
- **Three privacy modes**:
  - Private: Only discoverable via connection code
  - Standard (default): Searchable by username
  - Public: Searchable by username and display name
- **Granular controls** for email visibility, connection requests, etc.

### Invitation System
- **30-day expiration** on all invitations
- **Reminder notifications** at 25 and 28 days
- **Unique invitation codes** for sharing links
- **Connection requirement** for group invitations

## Database Changes Summary

### New Tables
- `connections` - User-to-user connections
- `connection_invitations` - Connection requests with expiration
- `user_privacy_settings` - Privacy preferences per user
- `group_invitations` - Group membership invitations

### New Functions
- `generate_invitation_code()` - Creates unique invitation codes
- `generate_connection_code()` - Creates unique user connection codes
- `check_connection_before_group_invite()` - Enforces connection requirement
- `accept_group_invitation()` - Auto-adds user to group on acceptance

### New Triggers
- Auto-generate invitation codes
- Enforce connection before group invites
- Auto-accept group members
- Update timestamps
- Log changes for sync

## Testing Checklist

Before marking these migrations as complete, verify:

- [ ] All tables created successfully
- [ ] Indexes are in place
- [ ] Functions compile without errors
- [ ] Triggers are attached to tables
- [ ] Privacy settings created for existing users
- [ ] Connection codes generate uniquely
- [ ] Invitation codes generate uniquely
- [ ] Constraints are enforced (test invalid data)
- [ ] Change log triggers are working

## Next Steps

After applying these database migrations:

1. Update backend API endpoints to use new tables
2. Create ConnectionService.ts for API calls
3. Create connectionStore.ts for state management
4. Update frontend components to use connections instead of friends
5. Implement invitation UI components

## Notes

- These migrations are designed to work with the existing `collaboration_groups` table
- The system enforces that users must be connected before group invitations
- All invitations expire after 30 days with notification reminders
- Privacy settings default to "standard" mode for all users
- The rollback script can cleanly remove everything if needed during testing