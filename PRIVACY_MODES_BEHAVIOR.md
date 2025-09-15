# Privacy Modes Behavior

## Overview
The application supports four privacy modes that control user visibility and discoverability:

## Privacy Modes

### 1. Ghost Mode
- **Visibility**: Completely invisible to all users
- **Suggestions**: Never appears in connection suggestions (`show_in_suggestions` = false)
- **Search**: Cannot be found via search
- **Discovery**: Only through explicit connection code
- **Use Case**: Users who want complete privacy

### 2. Private Mode
- **Visibility**: Limited visibility, profile details require connection
- **Suggestions**: CAN appear in connection suggestions (user-controlled via `show_in_suggestions`)
- **Search**: Not searchable by username/email/name
- **Discovery**: Through suggestions or connection code
- **Use Case**: Default mode for most users who want privacy but still be discoverable for connections

### 3. Standard Mode
- **Visibility**: Balanced privacy with user controls
- **Suggestions**: Appears in suggestions by default (`show_in_suggestions` defaults to true)
- **Search**: User-controlled search visibility
- **Discovery**: Multiple methods based on user preferences
- **Use Case**: Users who want balanced privacy with flexibility

### 4. Public Mode
- **Visibility**: Fully visible to everyone
- **Suggestions**: Always appears in suggestions (`show_in_suggestions` = true)
- **Search**: Fully searchable
- **Discovery**: All methods available
- **Auto-accept**: Can enable automatic connection acceptance
- **Use Case**: Public figures, businesses, or users who want maximum visibility

## Key Settings

### show_in_suggestions
- **Ghost**: Always false (enforced)
- **Private**: User-controlled (can be true or false)
- **Standard**: Defaults to true (user can change)
- **Public**: Always true (enforced)

### Migration History
- Migration 071: Initially set all private users to `show_in_suggestions = false` (incorrect)
- Migration 073: Fixed to allow private users to control `show_in_suggestions`

## Important Notes
1. Private mode users SHOULD be discoverable for connection requests
2. Only ghost mode users should be completely hidden from suggestions
3. The `show_in_suggestions` setting is user-controlled for private and standard modes
4. Public and ghost modes enforce their suggestion visibility