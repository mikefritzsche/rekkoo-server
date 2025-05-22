const express = require('express');
const YTMusic = require("ytmusic-api");

// Define action requirements
const actionRequirements = {
  // Actions that need a query parameter
  queryActions: [
    'getSearchSuggestions',
    'search',
    'searchSongs',
    'searchVideos',
    'searchArtists',
    'searchAlbums',
    'searchPlaylists'
  ],
  // Actions that need a resource ID
  resourceActions: [
    'getSong',
    'getUpNexts',
    'getVideo',
    'getLyrics',
    'getArtist',
    'getArtistSongs',
    'getArtistAlbums',
    'getAlbum',
    'getPlaylist',
    'getPlaylistVideos'
  ],
  // Actions that don't need additional parameters
  standardActions: [
    'getHomeSections'
  ]
};

// All allowed actions
const allowedActions = [
  ...actionRequirements.queryActions,
  ...actionRequirements.resourceActions,
  ...actionRequirements.standardActions
];

/**
 * Creates and returns a router with YouTube Music routes
 * @param {Object} ytMusicController - Controller with YouTube Music API methods
 * @returns {express.Router} Express router
 */
function createYTMusicRouter(ytMusicController) {
  const router = express.Router();

  /**
   * @route GET /:action
   * @desc Dynamic handler for YouTube Music API actions
   * @access Public
   */
  router.get('/:action', ytMusicController.handleAction);

  return router;
}

module.exports = createYTMusicRouter;