const express = require('express');

/**
 * Creates and returns a router with Spotify routes
 * @param {Object} spotifyController - Controller with Spotify API methods
 * @returns {express.Router} Express router
 */
function createSpotifyRouter(spotifyController) {
  const router = express.Router();

  /**
   * @route POST /token
   * @desc Get Spotify access token
   * @access Public
   */
  router.post('/token', spotifyController.getToken);

  /**
   * @route POST /player-token
   * @desc Get Spotify access token for Web Playback SDK with user permissions
   * @access Public
   */
  router.post('/player-token', spotifyController.getPlayerToken);

  /**
   * @route GET /search
   * @desc Search Spotify for artists, tracks, albums, etc.
   * @access Public
   */
  router.get('/search', spotifyController.search);

  /**
   * @route GET /auth
   * @desc Get Spotify OAuth authorization URL
   * @access Public
   */
  router.get('/auth', spotifyController.getAuthUrl);

  /**
   * @route GET /callback
   * @desc Handle Spotify OAuth callback
   * @access Public
   */
  router.get('/callback', spotifyController.handleCallback);

  // generic detail route: /spotify/:type/:id  (type validated in controller)
  router.get('/:type/:id', spotifyController.getDetail);

  // Add more routes as needed
  // router.get('/tracks/:id', spotifyController.getTrack);
  // router.get('/artists/:id', spotifyController.getArtist);
  // router.get('/playlists/:id', spotifyController.getPlaylist);

  return router;
}

module.exports = createSpotifyRouter;