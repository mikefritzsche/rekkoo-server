const { spotifyService } = require('../services/spotify-service');
const { logger } = require('../utils/logger');

class SpotifyController {
  async getToken(req, res) {
    try {
      const token = await spotifyService.getToken();
      res.json({ access_token: token });
    } catch (error) {
      logger.error('Spotify authentication error:', error);
      res.status(500).json({ error: 'Failed to authenticate with Spotify' });
    }
  }

  async search(req, res) {
    try {
      const { q: query, offset = 0, limit = 24 } = req.query;
      
      if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
      }

      const result = await spotifyService.search(
        query,
        parseInt(offset),
        parseInt(limit)
      );

      res.json(result);
    } catch (error) {
      logger.error('Spotify search error:', error);
      res.status(500).json({ error: 'Failed to search Spotify' });
    }
  }

  // Add more controller methods as needed
  // async getTrack(req, res) { ... }
  // async getArtist(req, res) { ... }
  // async getPlaylist(req, res) { ... }
}

module.exports = new SpotifyController(); 