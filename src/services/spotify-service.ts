import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface SpotifyToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
}

class SpotifyService {
  private token: SpotifyToken | null = null;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl = 'https://api.spotify.com/v1';

  constructor() {
    this.clientId = config.spotify.clientId;
    this.clientSecret = config.spotify.clientSecret;
  }

  private async getToken(): Promise<string> {
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

  async search(query: string, offset: number = 0, limit: number = 50) {
    try {
      const token = await this.getToken();
      const types = ['album', 'artist', 'playlist', 'track', 'show', 'episode', 'audiobook'];
      
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          q: query,
          type: types.join(','),
          market: 'US',
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

export const spotifyService = new SpotifyService(); 