# Spotify Integration for Rekkoo

This document explains how to set up Spotify integration for music search and the Web Playback SDK.

## Overview

The Spotify integration provides:
1. **Music Search**: Search for tracks, albums, artists, playlists, shows, episodes, and audiobooks
2. **Web Playback SDK**: Stream music directly in the web app
3. **Rich Music Details**: Display comprehensive information about music items

## Environment Variables

Add these environment variables to your server configuration:

### Required
```bash
# Spotify API Credentials
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# OAuth Redirect URI
SPOTIFY_REDIRECT_URI=http://localhost:3000/v1.0/spotify/callback
```

### Production Environment
For production, update the redirect URI:
```bash
SPOTIFY_REDIRECT_URI=https://your-domain.com/v1.0/spotify/callback
```

## Spotify App Setup

1. **Create Spotify App**:
   - Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Create a new app
   - Note the Client ID and Client Secret

2. **Configure App Settings**:
   - Add your redirect URI to "Redirect URIs" in app settings
   - For development: `http://localhost:3000/v1.0/spotify/callback`
   - For production: `https://your-domain.com/v1.0/spotify/callback`

3. **Required Scopes**:
   The integration requests these scopes for the Web Playback SDK:
   - `streaming` - Control Spotify playback
   - `user-read-email` - Read user email
   - `user-read-private` - Read user profile

## API Endpoints

### GET /v1.0/spotify/search
Search Spotify for music content.

**Query Parameters:**
- `q` (string, required): Search query
- `type` (string, optional): Comma-separated list of types (track,album,artist,playlist,show,episode,audiobook)
- `market` (string, optional): Two-letter ISO 3166-1 alpha-2 country code
- `limit` (number, optional): Number of results (default: 50, max: 50)
- `offset` (number, optional): Offset for pagination (default: 0)

### POST /v1.0/spotify/token
Get a basic Spotify access token for API calls (Client Credentials flow).

### POST /v1.0/spotify/player-token
Get a Spotify access token for Web Playback SDK with user permissions.

### GET /v1.0/spotify/auth
Initiate Spotify OAuth 2.0 authorization flow.

**Response:**
```json
{
  "authUrl": "https://accounts.spotify.com/authorize?...",
  "state": "random_state_string"
}
```

### GET /v1.0/spotify/callback
Handle OAuth callback from Spotify. This endpoint processes the authorization code.

### GET /v1.0/spotify/:type/:id
Get detailed information about a specific item.

**Parameters:**
- `type`: One of `track`, `album`, `artist`, `show`
- `id`: Spotify ID of the item

## Frontend Integration

### SpotifyPlayer Component
The `SpotifyPlayer` component provides:
- Web Playback SDK integration
- OAuth authentication flow
- Playback controls (play/pause, next/previous)
- Track information display

### MusicExtraInfo Component
Displays comprehensive music information including:
- Artist details with images
- Album information
- Track listings
- Genre chips
- Release information
- External links

## Authentication Flow

1. **User clicks "Connect to Spotify"** in the player
2. **Frontend calls** `GET /v1.0/spotify/auth`
3. **Server returns** OAuth authorization URL
4. **Frontend opens popup** with authorization URL
5. **User authorizes** the app on Spotify
6. **Spotify redirects** to callback URL with authorization code
7. **Server exchanges** code for access token
8. **Frontend receives** success message and reinitializes player

## Development vs Production

### Development
- Uses `http://localhost:3000` as base URL
- Simple token storage (no user sessions)
- Callback serves HTML page for popup flow

### Production Considerations
- Implement proper user session management
- Store tokens securely associated with user accounts
- Use HTTPS for all OAuth flows
- Implement token refresh logic
- Add error handling for expired/revoked tokens

## Testing the Integration

1. **Start the server** with Spotify credentials configured
2. **Open the app** and navigate to a music list
3. **Add a music item** and open the edit modal
4. **Click "Connect to Spotify"** in the player section
5. **Authorize the app** in the popup window
6. **Verify playback controls** appear and function

## Troubleshooting

### Common Issues

**"Invalid redirect URI"**
- Ensure the redirect URI in your Spotify app matches exactly
- Check for typos in the URL
- Verify the URI is added to the app settings

**"Access token expired"**
- Tokens expire after 1 hour
- Implement token refresh logic for production use

**"Web Playback SDK not available"**
- SDK only works on web browsers
- Mobile devices show fallback UI with "Open in Spotify" option

**"Premium required"**
- Spotify Web Playback SDK requires Spotify Premium
- Consider showing appropriate messaging for free users

## File Structure

```
server/
├── src/
│   ├── controllers/SpotifyController.js    # API endpoints
│   ├── services/spotify-service.js         # Spotify API integration
│   └── routes/spotify.routes.js            # Route definitions
└── public/spotify-callback.html            # OAuth callback page

app/
├── components/common/
│   ├── SpotifyPlayer.js                    # Web Playback SDK component
│   └── ItemManager/
│       └── MusicExtraInfo.js               # Music details display
└── services/spotify-auth.js                # Frontend auth service
```

## Next Steps

1. **Implement user sessions** for production token storage
2. **Add token refresh** logic for long-lived sessions
3. **Enhanced error handling** for network/auth failures
4. **Playlist creation** functionality
5. **User library integration** (saved tracks, playlists)