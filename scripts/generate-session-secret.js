#!/usr/bin/env node

/**
 * Generates a cryptographically-secure random string that can be used as the
 * SESSION_SECRET for express-session.
 *
 * Usage:
 *   node scripts/generate-session-secret.js            # prints the secret
 *   node scripts/generate-session-secret.js --env      # appends/updates .env
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const secret = crypto.randomBytes(48).toString('base64');

const shouldWriteEnv = process.argv.includes('--env');

if (shouldWriteEnv) {
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    // Remove any existing SESSION_SECRET line
    envContent = envContent.replace(/^SESSION_SECRET=.*$/m, '');
    envContent = envContent.trimEnd() + '\n';
  }
  envContent += `SESSION_SECRET=${secret}\n`;
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`SESSION_SECRET written to ${envPath}`);
} else {
  console.log(secret);
} 