# OAuth Redirect System Documentation

## Overview

The OAuth redirect system manages authentication flows for both the mobile app and admin panel, ensuring users are redirected to the appropriate client after successful authentication.

## Architecture

### Supported OAuth Providers
- Google OAuth 2.0
- GitHub OAuth 2.0  
- Apple Sign-In

### Redirect Targets
- `app` - Mobile app (React Native/Expo)
- `admin` - Admin panel (React web app)

## Flow Diagram

```
User clicks OAuth login
    ↓
/v1.0/auth/oauth/{provider}?redirect={target}
    ↓
Validate redirect target (app/admin)
    ↓
Store target in session + state parameter
    ↓
Redirect to OAuth provider
    ↓
User authenticates with provider
    ↓
Provider redirects to /v1.0/auth/oauth/{provider}/callback
    ↓
Passport authenticates and calls passportCallback
    ↓
Generate JWT tokens
    ↓
Redirect to appropriate client with tokens
```

## Implementation Details

### Route Structure

```javascript
// OAuth initiation
GET /v1.0/auth/oauth/{provider}?redirect={target}

// OAuth callback
GET /v1.0/auth/oauth/{provider}/callback
```

### Helper Functions

#### `validateOAuthRedirect(target)`
Validates that the redirect target is either 'app' or 'admin'.

#### `getFailureRedirect(target, provider)`
Returns the appropriate failure redirect URL based on the target and provider.

#### `setupOAuthRedirect(req, target, provider)`
- Validates the redirect target
- Stores the target in the session
- Logs the redirect setup for debugging

### Security Features

1. **Target Validation**: Only 'app' and 'admin' are accepted as redirect targets
2. **State Parameter**: The redirect target is passed as the OAuth state parameter for additional security
3. **Session Storage**: The redirect target is stored in the session for callback processing
4. **Error Handling**: Comprehensive error handling with appropriate redirects

## Environment Variables

```bash
# Client URLs
CLIENT_URL_APP=http://localhost:8081          # Mobile app URL
CLIENT_URL_ADMIN=https://admin-dev.rekkoo.com # Admin panel URL

# OAuth Provider Configuration
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=https://api-dev.rekkoo.com/v1.0/auth/oauth/google/callback

GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=https://api-dev.rekkoo.com/v1.0/auth/oauth/github/callback

APPLE_CLIENT_ID=your-apple-client-id
APPLE_TEAM_ID=your-apple-team-id
APPLE_KEY_ID=your-apple-key-id
APPLE_PRIVATE_KEY=your-apple-private-key
APPLE_CALLBACK_URL=https://api-dev.rekkoo.com/v1.0/auth/oauth/apple/callback
```

## Usage Examples

### Mobile App OAuth Flow

```javascript
// In your React Native app
const loginWithGoogle = () => {
  const redirectUrl = `${API_BASE_URL}/v1.0/auth/oauth/google?redirect=app`;
  window.location.href = redirectUrl;
};
```

### Admin Panel OAuth Flow

```javascript
// In your admin React app
const loginWithGoogle = () => {
  const redirectUrl = `${API_BASE_URL}/v1.0/auth/oauth/google?redirect=admin`;
  window.location.href = redirectUrl;
};
```

## Redirect URLs

### Success Redirects

#### App Redirect
```
http://localhost:8081/oauth-callback?accessToken={token}&refreshToken={token}&userId={id}
```

#### Admin Redirect
```
https://admin-dev.rekkoo.com/oauth-callback?accessToken={token}&refreshToken={token}&userId={id}
```

### Error Redirects

#### App Error Redirect
```
http://localhost:8081/oauth-callback?error=authentication_failed
```

#### Admin Error Redirect
```
https://admin-dev.rekkoo.com/login?oauth={provider}&error=1
```

## OAuth Provider Configuration

### Google Cloud Console
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials
3. Add authorized redirect URIs:
   - `https://api-dev.rekkoo.com/v1.0/auth/oauth/google/callback`
   - `https://api.rekkoo.com/v1.0/auth/oauth/google/callback`

### GitHub OAuth App
1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Create a new OAuth App
3. Set Authorization callback URL:
   - `https://api-dev.rekkoo.com/v1.0/auth/oauth/github/callback`
   - `https://api.rekkoo.com/v1.0/auth/oauth/github/callback`

### Apple Developer
1. Go to [Apple Developer Portal](https://developer.apple.com/)
2. Create a Services ID
3. Configure Sign In with Apple
4. Set Return URLs:
   - `https://api-dev.rekkoo.com/v1.0/auth/oauth/apple/callback`
   - `https://api.rekkoo.com/v1.0/auth/oauth/apple/callback`

## Testing

### Local Development
```bash
# Test app redirect
curl "http://localhost:3100/v1.0/auth/oauth/google?redirect=app"

# Test admin redirect
curl "http://localhost:3100/v1.0/auth/oauth/google?redirect=admin"

# Test invalid redirect
curl "http://localhost:3100/v1.0/auth/oauth/google?redirect=invalid"
```

### Production Testing
1. Ensure HTTPS is enabled
2. Verify all redirect URLs are properly configured
3. Test both app and admin flows
4. Verify error handling works correctly

## Troubleshooting

### Common Issues

1. **Redirect Loop**: Check that the callback URLs match exactly in OAuth provider settings
2. **Invalid Redirect Target**: Ensure only 'app' or 'admin' are used as redirect targets
3. **Session Issues**: Verify session configuration is correct
4. **HTTPS Requirements**: OAuth flows often require HTTPS in production

### Debug Logging

The system includes comprehensive logging:
- OAuth setup logs
- Session storage logs
- User agent detection logs
- Redirect decision logs

### Error Handling

All errors are handled gracefully with appropriate redirects:
- Invalid redirect targets return 400 errors
- OAuth failures redirect to error pages
- Network errors are logged and handled

## Security Considerations

1. **State Parameter**: Always use the state parameter to prevent CSRF attacks
2. **HTTPS**: Use HTTPS in production for all OAuth flows
3. **Redirect Validation**: Strictly validate redirect targets
4. **Session Security**: Ensure sessions are properly secured
5. **Token Security**: JWT tokens are short-lived and refresh tokens are securely stored

## Future Enhancements

1. **Additional Providers**: Support for more OAuth providers (Facebook, Twitter, etc.)
2. **Dynamic Redirects**: Support for custom redirect URLs
3. **Multi-tenant**: Support for multiple client applications
4. **Analytics**: Track OAuth usage and success rates 