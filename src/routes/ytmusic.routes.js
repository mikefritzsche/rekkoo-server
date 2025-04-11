const express = require('express');
const router = express.Router();
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

router.get('/:action', async (req, res) => {
  try {
    // Extract parameters
    const { action } = req.params;
    const { q: query, resource, limit, options } = req.query;

    // Validate action
    if (!allowedActions.includes(action)) {
      return res.status(400).json({
        error: "Invalid action",
        allowedActions
      });
    }

    // Initialize YTMusic
    const ytmusic = new YTMusic();
    await ytmusic.initialize(/* Optional: Custom cookies */);

    // Validate required parameters based on action type
    if (actionRequirements.queryActions.includes(action) && !query) {
      return res.status(400).json({ error: "Query parameter 'q' is required for this action" });
    }

    if (actionRequirements.resourceActions.includes(action) && !resource) {
      return res.status(400).json({ error: "Resource parameter is required for this action" });
    }

    // Parse options if provided
    let parsedOptions = {};
    if (options) {
      try {
        parsedOptions = JSON.parse(options);
      } catch (e) {
        return res.status(400).json({ error: "Invalid options format. Must be valid JSON" });
      }
    }

    // Execute the appropriate action with the correct parameters
    let results;

    if (actionRequirements.queryActions.includes(action)) {
      // Handle query-based actions
      results = await ytmusic[action](query, parsedOptions);
    } else if (actionRequirements.resourceActions.includes(action)) {
      // Handle resource-based actions
      results = await ytmusic[action](resource, parsedOptions);
    } else {
      // Handle standard actions with no required parameters
      results = await ytmusic[action](parsedOptions);
    }

    // Apply limit if provided
    if (limit && !isNaN(parseInt(limit)) && results) {
      // Handle different result structures
      if (Array.isArray(results)) {
        results = results.slice(0, parseInt(limit));
      } else if (results.content && Array.isArray(results.content)) {
        results.content = results.content.slice(0, parseInt(limit));
      } else if (results.items && Array.isArray(results.items)) {
        results.items = results.items.slice(0, parseInt(limit));
      } else if (results.results && Array.isArray(results.results)) {
        results.results = results.results.slice(0, parseInt(limit));
      }
    }

    // Return results
    return res.json(results);

  } catch (error) {
    console.error('Error with YouTube Music API:', error);
    res.status(500).json({
      error: 'API request failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;