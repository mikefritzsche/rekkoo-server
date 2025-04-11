const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

router.post('/token', async (req, res) => {
  console.log(`spotify token: `, process.env.SPOTIFY_CLIENT_ID)
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error('Failed to authenticate with Spotify');
    }

    const data = await response.json();

    // Only send the access token to the client
    res.json({ access_token: data.access_token });
  } catch (error) {
    console.error('Spotify authentication error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Spotify' });
  }
});

module.exports = router;