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
   * Get Spotify player token with user permissions for Web Playback SDK
   */
  const getPlayerToken = async (req, res) => {
    try {
      const tokenData = await spotifyService.getPlayerToken();
      res.json(tokenData);
    } catch (error) {
      logger.error('Spotify player token error:', error);
      res.status(500).json({ error: 'Failed to get Spotify player token' });
    }
  };

  /**
   * Get Spotify OAuth authorization URL
   */
  const getAuthUrl = async (req, res) => {
    try {
      const state = req.query.state || Math.random().toString(36).substring(7);
      const authUrl = spotifyService.getAuthUrl(state);
      res.json({ authUrl, state });
    } catch (error) {
      logger.error('Spotify auth URL error:', error);
      res.status(500).json({ error: 'Failed to generate auth URL' });
    }
  };

  /**
   * Handle Spotify OAuth callback
   */
  const handleCallback = async (req, res) => {
    try {
      const { code, error } = req.query;
      
      if (error) {
        logger.error('Spotify OAuth error:', error);
        return res.status(400).json({ error: `Spotify authorization failed: ${error}` });
      }

      if (!code) {
        return res.status(400).json({ error: 'Authorization code is required' });
      }

      const tokenData = await spotifyService.exchangeCodeForToken(code);
      
      // In a real app, you'd store this token associated with a user session
      // For now, just return success
      res.json({ 
        success: true, 
        message: 'Spotify authorization successful',
        expires_in: tokenData.expires_in 
      });
    } catch (error) {
      logger.error('Spotify callback error:', error);
      res.status(500).json({ error: 'Failed to process Spotify callback' });
    }
  };

  /**
   * Search Spotify for artists, tracks, albums, etc.
   */
  const search = async (req, res) => {
    try {
      const { q: query, nextUrl, offset = 0, limit = 50, type, market } = req.query;

      // must supply either q (first page) or nextUrl (paging)
      if (!query && !nextUrl) {
        return res.status(400).json({ error: 'Either q or nextUrl is required' });
      }

      const result = nextUrl
        ? await spotifyService.searchWithNext(nextUrl)
        : await spotifyService.search(
            query,
            parseInt(offset),
            parseInt(limit),
            type,
            market
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
   * Supported type values: track | album | artist | show | episode | audiobook | playlist
   */
  const getDetail = async (req, res) => {
    const { type, id } = req.params;
    if (!type || !id) {
      return res.status(400).json({ error: 'type and id are required' });
    }

    // Map types to correct Spotify API endpoints
    const typeMapping = {
      'track': 'tracks',
      'album': 'albums', 
      'artist': 'artists',
      'show': 'shows',
      'episode': 'episodes',
      'audiobook': 'audiobooks',
      'playlist': 'playlists'
    };

    const endpoint = typeMapping[type];
    if (!endpoint) {
      return res.status(400).json({ error: `Unsupported type: ${type}` });
    }

    try {
      const token = await spotifyService.getToken();
      const axios = require('axios');
      
      logger.info(`[SpotifyController] Fetching ${type} details: ${id}`);
      
      // Build request URL with optional market parameter for certain types
      let url = `https://api.spotify.com/v1/${endpoint}/${id}`;
      const params = {};
      
      // Add market parameter for content that may be region-specific
      if (['track', 'album', 'show', 'episode'].includes(type)) {
        params.market = 'US'; // Default to US market
      }
      
      // For albums, get tracks; for shows, get episodes; for playlists, get tracks
      if (type === 'album') {
        params.limit = 50; // Get up to 50 tracks
      } else if (type === 'show') {
        params.limit = 50; // Get up to 50 episodes  
      } else if (type === 'playlist') {
        params.limit = 50; // Get up to 50 tracks
        params.fields = 'id,name,description,images,owner,tracks.items(track(id,name,artists,duration_ms,preview_url)),tracks.total';
      }
      
      const { data: obj } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: Object.keys(params).length > 0 ? params : undefined
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
      logger.error(`[SpotifyController] getDetail error for ${type}/${id}:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      
      const statusCode = error.response?.status || 500;
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to fetch detail from Spotify';
      
      return res.status(statusCode).json({ 
        error: 'Failed to fetch detail from Spotify',
        details: errorMessage,
        type,
        id
      });
    }
  };

  // Add more controller methods as needed
  // const getTrack = async (req, res) => { ... }
  // const getArtist = async (req, res) => { ... }
  // const getPlaylist = async (req, res) => { ... }

  // Return all controller methods
  return {
    getToken,
    getPlayerToken,
    getAuthUrl,
    handleCallback,
    search,
    getDetail
    // Add additional methods here when implemented
    // getTrack,
    // getArtist,
    // getPlaylist
  };
}

module.exports = spotifyControllerFactory; 