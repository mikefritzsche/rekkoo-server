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
      const { q: query, offset = 0, limit = 50, type } = req.query;
      
      if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
      }

      const result = await spotifyService.search(
        query,
        parseInt(offset),
        parseInt(limit),
        type // pass through; may be undefined
      );

      await safeStoreSearchEmbedding(req, query);

      res.json(result);
    } catch (error) {
      logger.error('Spotify search error:', error);
      res.status(500).json({ error: 'Failed to search Spotify' });
    }
  };

  /**
   * Generic detail fetch: /v1.0/spotify/:type/:id
   * Supported type values: track | album | artist | show
   */
  const getDetail = async (req, res) => {
    const { type, id } = req.params;
    if (!type || !id) {
      return res.status(400).json({ error: 'type and id are required' });
    }

    try {
      const token = await spotifyService.getToken();
      const axios = require('axios');
      const { data: obj } = await axios.get(`https://api.spotify.com/v1/${type}s/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // If track/album lacks genres, derive from its artists
      if ((type === 'track' || type === 'album') && (!obj.genres || obj.genres.length === 0)) {
        const artistIds = (obj.artists || []).map(a => a.id).filter(Boolean);
        if (artistIds.length) {
          const { data } = await axios.get('https://api.spotify.com/v1/artists', { params: { ids: artistIds.join(',') }, headers: { Authorization: `Bearer ${token}` } });
          const genres = (data.artists || []).flatMap(a => a.genres);
          obj.genres = [...new Set(genres)];
        }
      }

      return res.json(obj);
    } catch (error) {
      logger.error('[SpotifyController] getDetail error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch detail from Spotify' });
    }
  };

  // Add more controller methods as needed
  // const getTrack = async (req, res) => { ... }
  // const getArtist = async (req, res) => { ... }
  // const getPlaylist = async (req, res) => { ... }

  // Return all controller methods
  return {
    getToken,
    search,
    getDetail
    // Add additional methods here when implemented
    // getTrack,
    // getArtist,
    // getPlaylist
  };
}

module.exports = spotifyControllerFactory; 