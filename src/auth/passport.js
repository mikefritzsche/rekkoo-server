const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const AppleStrategy = require('passport-apple').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const EXPIRES_IN = '1h';
const generateRefreshToken = () => uuidv4();

/**
 * Helper that ensures roles array is returned for JWT payload / client.
 */
async function fetchUserRoles(client, userId) {
  const res = await client.query(
    `SELECT r.name FROM roles r JOIN user_roles ur ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId]
  );
  return res.rows.map(r => r.name);
}

/**
 * Upserts an oauth provider row (google, github) into oauth_providers and returns its id.
 */
async function getProviderId(client, providerName) {
  const existing = await client.query(
    `SELECT id FROM oauth_providers WHERE provider_name = $1`,
    [providerName]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const insert = await client.query(
    `INSERT INTO oauth_providers (provider_name) VALUES ($1) RETURNING id`,
    [providerName]
  );
  return insert.rows[0].id;
}

/**
 * Core verify callback shared by all strategies
 */
function makeVerify(provider) {
  return async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails.length ? profile.emails[0].value : null;
      const emailVerified = !!email; // most providers verify email; adjust if needed
      const providerUserId = profile.id;
      const displayName = profile.displayName || (email ? email.split('@')[0] : 'user');
      const avatar = profile.photos && profile.photos.length ? profile.photos[0].value : null;

      const user = await db.transaction(async (client) => {
        // 1. Look up by provider user id
        let res = await client.query(
          `SELECT u.*
             FROM users u
             JOIN user_oauth_connections c ON u.id = c.user_id
            WHERE c.provider_user_id = $1
              AND c.deleted_at IS NULL`,
          [providerUserId]
        );
        let userRow = res.rows[0];

        // 2. If not exists, look up by verified email
        if (!userRow && emailVerified) {
          res = await client.query(`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
          userRow = res.rows[0];
        }

        // 3. Create user if new
        if (!userRow) {
          const newUserRes = await client.query(
            `INSERT INTO users (username, email, email_verified, profile_image_url, created_at, updated_at)
             VALUES ($1,$2,$3,$4,NOW(),NOW()) RETURNING *`,
            [displayName.replace(/\s+/g, '').toLowerCase(), email, emailVerified, avatar]
          );
          userRow = newUserRes.rows[0];
          // default role "user"
          await client.query(
            `INSERT INTO user_roles (user_id, role_id)
               VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))
               ON CONFLICT DO NOTHING`,
            [userRow.id]
          );
        }

        // 4. Upsert into user_oauth_connections
        const providerId = await getProviderId(client, provider);
        // Remove existing connection row for this user & provider (if any)
        await client.query(
          `DELETE FROM user_oauth_connections WHERE user_id = $1 AND provider_id = $2`,
          [userRow.id, providerId]
        );

        await client.query(
          `INSERT INTO user_oauth_connections (user_id, provider_id, provider_user_id, access_token, refresh_token, token_expires_at, profile_data, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '1 hour', $6, NOW(), NOW())`,
          [userRow.id, providerId, providerUserId, accessToken, refreshToken, JSON.stringify(profile)]
        );

        return userRow;
      });

      // Attach minimal user info to req.user via done()
      done(null, {
        id: user.id,
        username: user.username,
        email: user.email,
      });
    } catch (err) {
      console.error(`[passport ${provider}] verify error`, err);
      done(err);
    }
  };
}

// Strategy registrations --------------------------------------------------
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/v1.0/auth/oauth/google/callback',
        scope: ['profile', 'email'],
      },
      makeVerify('google')
    )
  );
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.GITHUB_CALLBACK_URL || '/v1.0/auth/oauth/github/callback',
        scope: ['user:email'],
      },
      makeVerify('github')
    )
  );
}

// Facebook (web) -----------------------------------------------------------
const FB_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID || process.env.FACEBOOK_APP_ID;
const FB_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET || process.env.FACEBOOK_APP_SECRET;
console.log('FB_CLIENT_ID', FB_CLIENT_ID);
console.log('FB_CLIENT_SECRET', FB_CLIENT_SECRET);
if (FB_CLIENT_ID && FB_CLIENT_SECRET) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: FB_CLIENT_ID,
        clientSecret: FB_CLIENT_SECRET,
        callbackURL: process.env.FACEBOOK_CALLBACK_URL || '/v1.0/auth/oauth/facebook/callback',
        profileFields: ['id', 'displayName', 'emails', 'photos'],
      },
      makeVerify('facebook')
    )
  );
}

// Apple (web) -------------------------------------------------------------
if (
  process.env.APPLE_CLIENT_ID &&
  process.env.APPLE_TEAM_ID &&
  process.env.APPLE_KEY_ID &&
  process.env.APPLE_PRIVATE_KEY
) {
  passport.use(
    new AppleStrategy(
      {
        clientID: process.env.APPLE_CLIENT_ID,
        teamID: process.env.APPLE_TEAM_ID,
        keyID: process.env.APPLE_KEY_ID,
        privateKeyString: process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        callbackURL: process.env.APPLE_CALLBACK_URL || '/v1.0/auth/oauth/apple/callback',
        scope: ['name', 'email'],
      },
      makeVerify('apple')
    )
  );
}

// Passport session setup (not storing sessions; JWT will be used)
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

module.exports = passport; 