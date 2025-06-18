const { spotifyService } = require('../services/spotify-service');
const { logger } = require('../utils/logger');
const { safeStoreSearchEmbedding } = require('../utils/searchEmbeddingUtils');

/**
 * Factory function that creates a SpotifyController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with Spotify API methods
 */
function spotifyControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };
  
  /**
   * Get Spotify access token
   */
  const getToken = async (req, res) => {
    try {
      const token = await spotifyService.getToken();
      res.json({ access_token: token });
    } catch (error) {
      logger.error('Spotify authentication error:', error);
      res.status(500).json({ error: 'Failed to authenticate with Spotify' });
    }
  };

  /**
   * Search Spotify for artists, tracks, albums, etc.
   */
  const search = async (req, res) => {
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

      await safeStoreSearchEmbedding(req, query);

      res.json(result);
    } catch (error) {
      logger.error('Spotify search error:', error);
      res.status(500).json({ error: 'Failed to search Spotify' });
    }
  };

  // Add more controller methods as needed
  // const getTrack = async (req, res) => { ... }
  // const getArtist = async (req, res) => { ... }
  // const getPlaylist = async (req, res) => { ... }

  // Return all controller methods
  return {
    getToken,
    search
    // Add additional methods here when implemented
    // getTrack,
    // getArtist,
    // getPlaylist
  };
}

module.exports = spotifyControllerFactory; 