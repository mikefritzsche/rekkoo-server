const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const session = require('express-session');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const PINTEREST_CLIENT_ID = process.env.PINTEREST_CLIENT_ID;
const PINTEREST_CLIENT_SECRET = process.env.PINTEREST_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/pinterest/callback';
const SCOPES = 'boards:read,pins:read,user_accounts:read'; // Adjust scopes as needed

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'pinterest-oauth-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Routes
app.get('/', (req, res) => {
  res.send(`
    <h1>Pinterest OAuth Example</h1>
    <a href="/auth/pinterest">Login with Pinterest</a>
    ${req.session.pinterestToken ?
    `<p>You are logged in!</p>
       <a href="/profile">View Profile</a>
       <a href="/auth/logout">Logout</a>` : ''}
  `);
});

// Step 1: Redirect to Pinterest's authorization page
app.get('/auth/pinterest', (req, res) => {
  const authUrl = 'https://www.pinterest.com/oauth/';

  const queryParams = querystring.stringify({
    client_id: PINTEREST_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES
  });

  res.redirect(`${authUrl}?${queryParams}`);
});

// Step 2: Handle the callback from Pinterest
app.get('/auth/pinterest/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Authorization code is missing');
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await axios.post('https://api.pinterest.com/v5/oauth/token', querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${PINTEREST_CLIENT_ID}:${PINTEREST_CLIENT_SECRET}`).toString('base64')}`
      }
    });

    // Store the token in session
    req.session.pinterestToken = tokenResponse.data.access_token;

    res.redirect('/');
  } catch (error) {
    console.error('Error exchanging code for token:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

// Example protected route to fetch user profile
app.get('/profile', async (req, res) => {
  if (!req.session.pinterestToken) {
    return res.redirect('/auth/pinterest');
  }

  try {
    // Fetch user information
    const userResponse = await axios.get('https://api.pinterest.com/v5/user_account', {
      headers: {
        'Authorization': `Bearer ${req.session.pinterestToken}`
      }
    });

    res.json(userResponse.data);
  } catch (error) {
    console.error('Error fetching user profile:', error.response?.data || error.message);

    // If token is invalid, clear session and redirect to login
    if (error.response?.status === 401) {
      req.session.destroy();
      return res.redirect('/auth/pinterest');
    }

    res.status(500).send('Failed to fetch user profile');
  }
});

// Logout route
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;