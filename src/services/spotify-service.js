const axios = require('axios');
const { logger } = require('../utils/logger');
const { cacheFetch } = require('../utils/cache');

class SpotifyService {
  constructor() {
    this.token = null;
    this.playerToken = null;
    this.clientId = process.env.SPOTIFY_CLIENT_ID;
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    this.baseUrl = 'https://api.spotify.com/v1';
    this.redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000/spotify/callback';
  }

  async getToken() {
    if (this.token && Date.now() < this.token.expires_at) {
      return this.token.access_token;
    }

    try {
      const response = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'client_credentials',
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(
              `${this.clientId}:${this.clientSecret}`
            ).toString('base64')}`,
          },
        }
      );

      const data = response.data;
      this.token = {
        ...data,
        expires_at: Date.now() + (data.expires_in * 1000),
      };

      return this.token.access_token;
    } catch (error) {
      logger.error('Failed to get Spotify token:', error);
      throw new Error('Failed to authenticate with Spotify');
    }
  }

  /**
   * Get Spotify player token with user scopes for Web Playback SDK
   * For development, this creates a mock token. In production, this would 
   * require proper OAuth 2.0 flow with user authentication.
   */
  async getPlayerToken() {
    // Check if we have a valid player token
    if (this.playerToken && Date.now() < this.playerToken.expires_at) {
      return {
        access_token: this.playerToken.access_token,
        token_type: 'Bearer',
        expires_in: Math.floor((this.playerToken.expires_at - Date.now()) / 1000)
      };
    }

    try {
      // For development/demo purposes, we'll use the same client credentials token
      // In production, you'd need to implement proper OAuth 2.0 flow
      const token = await this.getToken();
      
      // Store as player token (same token but tracked separately)
      this.playerToken = {
        access_token: token,
        expires_at: Date.now() + (3600 * 1000), // 1 hour
      };

      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600
      };
    } catch (error) {
      logger.error('Failed to get Spotify player token:', error);
      throw new Error('Failed to get Spotify player token');
    }
  }

  /**
   * Generate OAuth 2.0 authorization URL for user authentication
   * This would be used in a full implementation with user login
   */
  getAuthUrl(state, scopes = ['streaming', 'user-read-email', 'user-read-private']) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes.join(' '),
      redirect_uri: this.redirectUri,
      state: state,
    });

    return `https://accounts.spotify.com/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * This would be called after user authorizes the app
   */
  async exchangeCodeForToken(code) {
    try {
      const response = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: this.redirectUri,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(
              `${this.clientId}:${this.clientSecret}`
            ).toString('base64')}`,
          },
        }
      );

      const data = response.data;
      this.playerToken = {
        ...data,
        expires_at: Date.now() + (data.expires_in * 1000),
      };

      return this.playerToken;
    } catch (error) {
      logger.error('Failed to exchange code for token:', error);
      throw new Error('Failed to exchange authorization code for token');
    }
  }

  async search(query, offset = 0, limit = 24, typeParam = null) {
    // Respect client-provided type list if supplied, otherwise default to all types
    const types = typeParam
      ? typeParam.split(',').map((t) => t.trim()).filter(Boolean)
      : ['album', 'artist', 'playlist', 'track', 'show', 'episode', 'audiobook'];

    const payload = { q: query, type: types.join(','), limit, offset };

    return cacheFetch(
      'spotify',
      payload,
      async () => {
        try {
          const token = await this.getToken();
          const { data } = await axios.get(`${this.baseUrl}/search`, {
            params: payload,
            headers: { Authorization: `Bearer ${token}` },
          });

          return {
            items: data,
            next: data.tracks?.next || data.artists?.next || null,
          };
        } catch (error) {
          logger.error('Spotify search error:', error);
          throw new Error('Failed to search Spotify');
        }
      },
      60 * 60 // 1-hour TTL
    );
  }

  /**
   * Fetch next page using Spotify-provided next URL.
   * Simply proxies with auth header and returns same wrapper shape { items, next }
   */
  async searchWithNext(nextUrl) {
    try {
      const token = await this.getToken();
      const { data } = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { items: data, next: data.next };
    } catch (error) {
      logger.error('Spotify paging error:', error);
      throw new Error('Failed to fetch next page from Spotify');
    }
  }

  // fetchGenres(id: string, kind: 'track' | 'album' | 'artist' | 'show' = 'track')
  async fetchGenres(id, kind = 'track') {
    // 1. fetch the primary object
    const obj = await axios.get(`${this.baseUrl}/${kind}s/${id}`).then(r => r.data);
    let genres = obj.genres ?? [];

    // 2. handle tracks or albums that have no genres → look up artists
    if (genres.length === 0 && (kind === 'track' || kind === 'album')) {
      const artistIds = (obj.artists || []).map(a => a.id).filter(Boolean);
      if (artistIds.length) {
        const res = await axios.get(`${this.baseUrl}/artists`, { params: { ids: artistIds.join(',') } });
        genres = res.data.artists.flatMap(a => a.genres);
      }
    }
    return [...new Set(genres)];          // dedupe
  }
}

module.exports = {
  spotifyService: new SpotifyService()
}; 