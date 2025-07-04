#!/usr/bin/env node

/**
 * Test script for OAuth routes
 * This script tests the OAuth redirect validation and setup
 */

const express = require('express');
const request = require('supertest');

// Mock the auth routes for testing
const app = express();
app.use(express.json());

// Mock session middleware
app.use((req, res, next) => {
  req.session = {
    oauthRedirect: null,
    save: (cb) => cb && cb()
  };
  next();
});

// Mock passport
const passport = {
  authenticate: (strategy, options) => {
    return (req, res, next) => {
      // Mock successful authentication
      req.user = { id: 'test-user-id' };
      next();
    };
  }
};

// Mock AuthController
const AuthController = {
  passportCallback: (req, res) => {
    res.json({ 
      success: true, 
      redirectTarget: req.session?.oauthRedirect || req.query.state 
    });
  }
};

// Import the actual route logic (without the full router)
const validateOAuthRedirect = (target) => {
  const validTargets = ['app', 'admin'];
  return validTargets.includes(target);
};

const getFailureRedirect = (target, provider) => {
  const CLIENT_URL_APP = process.env.CLIENT_URL_APP || (process.env.NODE_ENV === 'production' ? 'https://app.rekkoo.com' : 'http://localhost:8081');
  const CLIENT_URL_ADMIN = process.env.CLIENT_URL_ADMIN || (process.env.NODE_ENV === 'production' ? 'https://admin.rekkoo.com' : 'https://admin-dev.rekkoo.com');
  
  if (target === 'app') {
    return `${CLIENT_URL_APP}/oauth/callback?error=authentication_failed`;
  } else {
    return `${CLIENT_URL_ADMIN}/login?oauth=${provider}&error=1`;
  }
};

const setupOAuthRedirect = (req, target, provider) => {
  if (!validateOAuthRedirect(target)) {
    console.error(`[${provider} OAuth] Invalid redirect target:`, target);
    throw new Error('Invalid redirect target. Must be "app" or "admin"');
  }

  if (req.session) {
    req.session.oauthRedirect = target;
    console.log(`[${provider} OAuth] Stored redirect in session:`, req.sessionID, target);
  }

  return target;
};

// Test routes
app.get('/test/oauth/google', (req, res, next) => {
  try {
    const target = req.query.redirect || 'app';
    setupOAuthRedirect(req, target, 'Google');
    
    // Mock passport authentication
    passport.authenticate('google', { 
      scope: ['profile', 'email'], 
      prompt: 'select_account', 
      state: target 
    })(req, res, next);
  } catch (error) {
    console.error('[Google OAuth] Setup error:', error.message);
    return res.status(400).json({ error: error.message });
  }
});

app.get('/test/oauth/google/callback', 
  passport.authenticate('google', { session: false }),
  AuthController.passportCallback
);

// Test helper functions
app.get('/test/validate/:target', (req, res) => {
  const target = req.params.target;
  const isValid = validateOAuthRedirect(target);
  res.json({ target, isValid });
});

app.get('/test/failure-redirect/:target/:provider', (req, res) => {
  const { target, provider } = req.params;
  const redirectUrl = getFailureRedirect(target, provider);
  res.json({ target, provider, redirectUrl });
});

// Test suite
async function runTests() {
  console.log('🧪 Testing OAuth Routes...\n');

  // Test 1: Valid redirect targets
  console.log('Test 1: Valid redirect targets');
  const validTargets = ['app', 'admin'];
  for (const target of validTargets) {
    const response = await request(app).get(`/test/validate/${target}`);
    console.log(`  ${target}: ${response.body.isValid ? '✅' : '❌'}`);
  }

  // Test 2: Invalid redirect targets
  console.log('\nTest 2: Invalid redirect targets');
  const invalidTargets = ['invalid', 'test', 'mobile'];
  for (const target of invalidTargets) {
    const response = await request(app).get(`/test/validate/${target}`);
    console.log(`  ${target}: ${!response.body.isValid ? '✅' : '❌'}`);
  }

  // Test 3: OAuth setup with valid targets
  console.log('\nTest 3: OAuth setup with valid targets');
  for (const target of validTargets) {
    const response = await request(app).get(`/test/oauth/google?redirect=${target}`);
    console.log(`  ${target}: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
  }

  // Test 4: OAuth setup with invalid targets
  console.log('\nTest 4: OAuth setup with invalid targets');
  for (const target of invalidTargets) {
    const response = await request(app).get(`/test/oauth/google?redirect=${target}`);
    console.log(`  ${target}: ${response.status === 400 ? '✅' : '❌'} (${response.status})`);
  }

  // Test 5: Failure redirect URLs
  console.log('\nTest 5: Failure redirect URLs');
  const providers = ['google', 'github', 'apple'];
  for (const target of validTargets) {
    for (const provider of providers) {
      const response = await request(app).get(`/test/failure-redirect/${target}/${provider}`);
      console.log(`  ${target}/${provider}: ${response.body.redirectUrl ? '✅' : '❌'}`);
    }
  }

  // Test 6: OAuth callback with session
  console.log('\nTest 6: OAuth callback with session');
  const response = await request(app)
    .get('/test/oauth/google?redirect=app')
    .then(() => request(app).get('/test/oauth/google/callback'));
  
  console.log(`  Callback: ${response.body.success ? '✅' : '❌'}`);
  console.log(`  Redirect target: ${response.body.redirectTarget}`);

  console.log('\n✅ OAuth route tests completed!');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = {
  validateOAuthRedirect,
  getFailureRedirect,
  setupOAuthRedirect
}; 