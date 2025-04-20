const express = require('express');
const router = express.Router();
const spotifyController = require('../controllers/spotify.controller');

// Token endpoint
router.post('/token', spotifyController.getToken);

// Search endpoint
router.get('/search', spotifyController.search);

// Add more routes as needed
// router.get('/tracks/:id', spotifyController.getTrack);
// router.get('/artists/:id', spotifyController.getArtist);
// router.get('/playlists/:id', spotifyController.getPlaylist);

module.exports = router;