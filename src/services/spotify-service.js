const axios = require('axios');
const { logger } = require('../utils/logger');
const { cacheFetch } = require('../utils/cache');

class SpotifyService {
  constructor() {
    this.token = null;
    this.clientId = process.env.SPOTIFY_CLIENT_ID;
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    this.baseUrl = 'https://api.spotify.com/v1';
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