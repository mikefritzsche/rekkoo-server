const axios = require('axios');
const { logger } = require('../utils/logger');

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

  async search(query, offset = 0, limit = 24) {
    try {
      const token = await this.getToken();
      console.log('spotify token :>> ', token);
      const types = ['album', 'artist', 'playlist', 'track', 'show', 'episode', 'audiobook'];
      
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          q: query,
          type: types.join(','),
          limit,
          offset,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      return {
        items: response.data,
        next: response.data.tracks?.next || response.data.artists?.next || null,
      };
    } catch (error) {
      logger.error('Spotify search error:', error);
      throw new Error('Failed to search Spotify');
    }
  }
}

module.exports = {
  spotifyService: new SpotifyService()
}; 