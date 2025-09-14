# Private Mode Default Configuration Summary

## Overview
All users (existing and new) are now set to **private mode** by default to enhance privacy and security.

## Changes Made

### 1. Database Migration (052_set_all_users_private_mode.sql)
- Updates all existing users to `privacy_mode: 'private'`
- Generates unique connection codes for all users
- Sets searchable flags to false for private mode users
- Updates the default column value for new rows
- Creates trigger to ensure new users get private mode

### 2. Backend Updates

#### ConnectionsController.js
- Updated `getPrivacySettings()` to create settings with private mode by default
- Changed default from 'standard' to 'private'
- Auto-generates connection code for private users

#### AuthController.js
- **Standard Registration**: Creates user_settings with private mode for new users
- **OAuth Registration**: Added user_settings creation in 3 OAuth flows:
  - oauthCallback flow
  - passportCallback flow
  - linkOAuthAccount flow
- All new users get:
  - `privacy_mode: 'private'`
  - Unique connection code
  - Searchable settings set to false
  - Connection requests allowed

### 3. Frontend Updates

#### privacy-settings.tsx
- Changed DEFAULT_SETTINGS to use `privacy_mode: 'private'`
- Updated fallback from 'standard' to 'private' when loading settings

## Private Mode Features

When a user is in private mode:
- **Not searchable** by username, email, or name
- **Profile hidden** from non-connections (no full name or profile image)
- **Connection code required** for others to connect
- **Basic info only** shown in connection requests (username only)

## Migration Steps

1. **Run migration 050** - Consolidate privacy settings to user_settings table
2. **Run migration 052** - Set all users to private mode
3. **Verify** - Test that:
   - Existing users are now private
   - New registrations create private accounts
   - OAuth sign-ups create private accounts
   - Connection codes are generated

## Connection Codes

Each private user gets a unique 4-digit code (e.g., "1234") that others need to send connection requests. This prevents unwanted connection requests and enhances privacy.

## Rollback

If needed, you can update users back to 'standard' mode:
```sql
UPDATE public.user_settings
SET privacy_settings = jsonb_set(
  privacy_settings,
  '{privacy_mode}',
  '"standard"'
),
privacy_settings = jsonb_set(
  privacy_settings,
  '{searchable_by_username}',
  'true'
);
```

## Benefits

1. **Enhanced Privacy**: Users are private by default
2. **Reduced Spam**: Connection codes prevent unwanted requests
3. **User Control**: Users can opt-in to being more discoverable
4. **GDPR Friendly**: Privacy-first approach