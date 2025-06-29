// Test script to verify environment loading
const dotenv = require('dotenv');
const path = require('path');

console.log('🔧 Testing environment loading...\n');

// Load environment variables from multiple files
// Load .env first (base configuration)
dotenv.config();
console.log('✓ Loaded .env');

// Load .env.common (contains OAuth credentials and other shared config)
dotenv.config({ path: path.resolve(process.cwd(), '.env.common') });
console.log('✓ Loaded .env.common');

// Load environment-specific file if it exists
const envFile = `.env.${process.env.NODE_ENV || 'development'}`;
dotenv.config({ path: path.resolve(process.cwd(), envFile) });
console.log(`✓ Loaded ${envFile}\n`);

// Log environment loading for debugging
console.log('🔧 Environment variables loaded:');
console.log('  NODE_ENV:', process.env.NODE_ENV);
console.log('  PORT:', process.env.PORT);
console.log('  GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? '✓ Set (' + process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...)' : '✗ Missing');
console.log('  GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? '✓ Set (' + process.env.GOOGLE_CLIENT_SECRET.substring(0, 10) + '...)' : '✗ Missing');
console.log('  GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL || '✗ Missing');
console.log('  CLIENT_URL_APP:', process.env.CLIENT_URL_APP);
console.log('  CLIENT_URL_ADMIN:', process.env.CLIENT_URL_ADMIN);

// Test OAuth URL generation
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  console.log('\n✅ OAuth credentials are properly loaded!');
  console.log('   The OAuth flow should work correctly now.');
} else {
  console.log('\n❌ OAuth credentials are missing!');
  console.log('   Check that .env.common contains the Google OAuth credentials.');
} 