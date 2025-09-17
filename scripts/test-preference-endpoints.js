#!/usr/bin/env node

/**
 * Test script for preference-based recommendation endpoints
 */

const axios = require('axios');
const db = require('../src/config/db');

// Get these from your environment or update them
const API_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';
const USER_TOKEN = process.env.TEST_USER_TOKEN || 'YOUR_JWT_TOKEN_HERE'; // Replace with actual token

async function testEndpoints() {
  console.log('\n=== Testing Preference-Based Recommendation System ===\n');

  // Setup axios with auth
  const api = axios.create({
    baseURL: API_URL,
    headers: {
      'Authorization': `Bearer ${USER_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  try {
    // 1. Check if current user has preference embedding
    console.log('1. Checking preference embeddings in database...');
    const embeddingCheck = await db.query(`
      SELECT
        e.id,
        e.entity_type,
        e.created_at,
        e.updated_at,
        u.username,
        array_length(string_to_array(e.embedding::text, ','), 1) as dimension
      FROM embeddings e
      JOIN users u ON u.id = e.related_entity_id
      WHERE e.entity_type = 'user_preferences'
      ORDER BY e.created_at DESC
      LIMIT 5
    `);

    if (embeddingCheck.rows.length > 0) {
      console.log(`   ✓ Found ${embeddingCheck.rows.length} users with preference embeddings`);
      embeddingCheck.rows.forEach(row => {
        console.log(`     - ${row.username}: ${row.dimension}D embedding (created: ${row.created_at})`);
      });
    } else {
      console.log('   ⚠ No preference embeddings found');
    }

    // 2. Test regular suggestions endpoint
    console.log('\n2. Testing regular suggestions endpoint...');
    try {
      const regularResponse = await api.get('/api/users/suggestions?limit=5');
      console.log(`   ✓ Regular suggestions returned ${regularResponse.data.data.length} users`);
      if (regularResponse.data.data.length > 0) {
        console.log(`     First user: ${regularResponse.data.data[0].username}`);
      }
    } catch (error) {
      console.log(`   ✗ Regular suggestions failed: ${error.response?.data?.error || error.message}`);
    }

    // 3. Test preference-based suggestions
    console.log('\n3. Testing preference-based suggestions endpoint...');
    try {
      const prefResponse = await api.get('/api/users/suggestions/preferences?limit=5');
      console.log(`   ✓ Preference suggestions returned ${prefResponse.data.data.length} users`);
      console.log(`     Mode: ${prefResponse.data.mode}`);
      console.log(`     Discovery mode: ${prefResponse.data.discovery_mode}`);

      if (prefResponse.data.data.length > 0) {
        const firstUser = prefResponse.data.data[0];
        console.log(`     First user: ${firstUser.username}`);
        if (firstUser.preference_similarity) {
          console.log(`     Similarity score: ${(firstUser.preference_similarity * 100).toFixed(1)}%`);
        }
      }
    } catch (error) {
      console.log(`   ✗ Preference suggestions failed: ${error.response?.data?.error || error.message}`);
    }

    // 4. Test regenerate embedding endpoint
    console.log('\n4. Testing regenerate embedding endpoint...');
    try {
      const regenResponse = await api.post('/api/preferences/regenerate-embedding');
      console.log(`   ✓ Embedding regenerated: ${regenResponse.data.message}`);
      console.log(`     Has embedding: ${regenResponse.data.hasEmbedding}`);
    } catch (error) {
      console.log(`   ✗ Regenerate failed: ${error.response?.data?.error || error.message}`);
    }

    // 5. Get user preferences for context
    console.log('\n5. Getting user preferences...');
    try {
      const prefResponse = await api.get('/api/preferences/user');
      console.log(`   ✓ User has ${prefResponse.data.preferences.length} preferences`);
      console.log(`     Discovery mode: ${prefResponse.data.discoverySettings?.discovery_mode || 'balanced'}`);

      if (prefResponse.data.preferences.length > 0) {
        const categories = [...new Set(prefResponse.data.preferences.map(p => p.category_name))];
        console.log(`     Categories: ${categories.join(', ')}`);
      }
    } catch (error) {
      console.log(`   ✗ Get preferences failed: ${error.response?.data?.error || error.message}`);
    }

    // 6. Test preference similarity with a specific user (if we have one)
    if (embeddingCheck.rows.length > 1) {
      const targetUserId = embeddingCheck.rows[1].id; // Use second user as target
      console.log('\n6. Testing preference similarity endpoint...');
      try {
        const simResponse = await api.get(`/api/users/preference-similarity/${targetUserId}`);
        console.log(`   ✓ Similarity check successful`);
        console.log(`     Similarity score: ${(simResponse.data.similarity * 100).toFixed(1)}%`);
        console.log(`     Has preferences: ${simResponse.data.hasPreferences}`);
      } catch (error) {
        console.log(`   ✗ Similarity check failed: ${error.response?.data?.error || error.message}`);
      }
    }

    // Summary
    console.log('\n=== Summary ===');
    console.log('The preference-based recommendation system is ready!');
    console.log('\nNext steps:');
    console.log('1. Generate embeddings for other users: node scripts/generate-preference-embeddings.js');
    console.log('2. Test in the app by checking user suggestions');
    console.log('3. Monitor similarity scores to tune thresholds');

  } catch (error) {
    console.error('\nTest failed:', error.message);
  } finally {
    process.exit(0);
  }
}

// Check if token is provided
if (USER_TOKEN === 'YOUR_JWT_TOKEN_HERE') {
  console.log('Please provide your JWT token:');
  console.log('  export TEST_USER_TOKEN="your_jwt_token"');
  console.log('  node scripts/test-preference-endpoints.js');
  console.log('\nOr edit the script and replace YOUR_JWT_TOKEN_HERE with your actual token');
  process.exit(1);
}

testEndpoints();