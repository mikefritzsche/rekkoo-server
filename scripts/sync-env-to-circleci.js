#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');

// --------------------------------------------------
// 1. Load env files in layered order: .env.common then .env.<envName>
// --------------------------------------------------
const projectRoot = path.join(__dirname, '..');
const envName = process.env.APP_ENV || process.env.NODE_ENV || 'production';

const tryLoad = (file) => {
  const full = path.join(projectRoot, file);
  if (fs.existsSync(full)) {
    require('dotenv').config({ path: full, override: false });
  }
};

// Load environment files in order: .env.common, .env.<envName>, .env (last for secrets)
tryLoad('.env.common');
tryLoad(`.env.${envName}`);
tryLoad('.env');

// Configuration
const PROJECT_SLUG = 'github/mikefritzsche/rekkoo-server';
const CIRCLECI_TOKEN = process.env.CIRCLECI_TOKEN;

// Colors for console output
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

function log(message, color = colors.reset) {
  console.log(color + message + colors.reset);
}

function makeApiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    
    const options = {
      hostname: 'circleci.com',
      port: 443,
      path: `/api/v2/project/${PROJECT_SLUG}${path}`,
      method: method,
      headers: {
        'Circle-Token': CIRCLECI_TOKEN,
        'Content-Type': 'application/json',
      }
    };

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = body ? JSON.parse(body) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(response);
          } else {
            reject(new Error(`API Error: ${response.message || body}`));
          }
        } catch (error) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function parseEnvFile() {
  const envVars = {};

  const loadFile = (file) => {
    const envPath = path.join(projectRoot, file);
    if (!fs.existsSync(envPath)) return;

    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const [key, ...valParts] = trimmed.split('=');
      if (!key || valParts.length === 0) return;

      let value = valParts.join('=');
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      envVars[key.trim()] = value.trim();
    });
  };

  loadFile('.env.common');
  loadFile(`.env.${envName}`);
  loadFile('.env');

  if (Object.keys(envVars).length === 0) {
    throw new Error('No environment variables found in .env.common, .env.' + envName + ', or .env');
  }

  return envVars;
}

async function syncEnvToCircleCI() {
  if (!CIRCLECI_TOKEN) {
    throw new Error(`
${colors.red}CircleCI token not found!${colors.reset}

Please set your CircleCI token in your .env file:
${colors.yellow}CIRCLECI_TOKEN=your_token_here${colors.reset}

Get your token from: https://app.circleci.com/settings/user/tokens
    `);
  }

  log(`\n${colors.bold}🔄 Syncing .env to CircleCI Environment Variables${colors.reset}`);
  log('=======================================================');

  // Check for clean slate flag
  const cleanSlate = process.argv.includes('--clean') || process.argv.includes('--delete-existing');
  const deleteOnly = process.argv.includes('--delete-only');
  
  if (cleanSlate || deleteOnly) {
    const mode = deleteOnly ? 'delete-only' : 'clean slate';
    log(`\n${colors.yellow}🧹 ${mode} mode: Deleting existing CircleCI environment variables...${colors.reset}`);
    await deleteExistingVariables();
    
    if (deleteOnly) {
      log(`\n${colors.green}✅ All environment variables deleted from CircleCI${colors.reset}`);
      log(`${colors.blue}🌐 View in CircleCI:${colors.reset}`);
      log(`https://app.circleci.com/settings/project/${PROJECT_SLUG}/environment-variables`);
      return; // Exit without uploading new variables
    }
  }

  // Parse local .env file
  const envVars = parseEnvFile();
  const envKeys = Object.keys(envVars);
  
  log(`\n${colors.blue}Found ${envKeys.length} environment variables in .env file:${colors.reset}`);
  envKeys.forEach(key => {
    const value = envVars[key];
    const maskedValue = value.length > 10 ? `${value.substring(0, 6)}***` : '***';
    log(`  ${key}=${maskedValue}`);
  });

  log(`\n${colors.yellow}🚀 Uploading to CircleCI...${colors.reset}`);

  // Upload each environment variable
  let successCount = 0;
  let errorCount = 0;

  for (const [key, value] of Object.entries(envVars)) {
    try {
      await makeApiRequest('POST', '/envvar', {
        name: key,
        value: value
      });
      log(`${colors.green}✅ ${key}${colors.reset}`);
      successCount++;
    } catch (error) {
      // Variable might already exist, try to update it
      try {
        await makeApiRequest('PUT', `/envvar/${key}`, {
          name: key,
          value: value
        });
        log(`${colors.green}🔄 ${key} (updated)${colors.reset}`);
        successCount++;
      } catch (updateError) {
        log(`${colors.red}❌ ${key}: ${updateError.message}${colors.reset}`);
        errorCount++;
      }
    }
  }

  log(`\n${colors.bold}📊 Sync Complete!${colors.reset}`);
  log(`${colors.green}✅ Success: ${successCount}${colors.reset}`);
  if (errorCount > 0) {
    log(`${colors.red}❌ Errors: ${errorCount}${colors.reset}`);
  }
  
  log(`\n${colors.blue}🌐 View in CircleCI:${colors.reset}`);
  log(`https://app.circleci.com/settings/project/${PROJECT_SLUG}/environment-variables`);
}

async function deleteExistingVariables() {
  try {
    log(`${colors.blue}  Fetching existing environment variables...${colors.reset}`);
    
    // Get all existing environment variables
    const response = await makeApiRequest('GET', '/envvar');
    const existingVars = response.items || [];
    
    log(`${colors.blue}  API Response structure:${colors.reset}`);
    log(`  - Response keys: ${Object.keys(response).join(', ')}`);
    log(`  - Items array length: ${existingVars.length}`);
    
    if (existingVars.length === 0) {
      log(`${colors.blue}  No existing variables to delete${colors.reset}`);
      return;
    }
    
    log(`${colors.blue}  Found ${existingVars.length} existing variables to delete:${colors.reset}`);
    existingVars.forEach((variable, index) => {
      log(`    ${index + 1}. ${variable.name || 'UNKNOWN_NAME'}`);
    });
    
    // Delete each existing variable
    let deleteCount = 0;
    let failCount = 0;
    
    for (const variable of existingVars) {
      const varName = variable.name;
      if (!varName) {
        log(`${colors.red}❌ Skipping variable with no name: ${JSON.stringify(variable)}${colors.reset}`);
        failCount++;
        continue;
      }
      
      try {
        log(`${colors.yellow}🗑️  Attempting to delete: ${varName}${colors.reset}`);
        await makeApiRequest('DELETE', `/envvar/${varName}`);
        log(`${colors.green}✅ Deleted: ${varName}${colors.reset}`);
        deleteCount++;
      } catch (error) {
        log(`${colors.red}❌ Failed to delete ${varName}: ${error.message}${colors.reset}`);
        log(`${colors.red}   Error details: ${JSON.stringify(error)}${colors.reset}`);
        failCount++;
      }
    }
    
    log(`${colors.green}📊 Deletion Summary:${colors.reset}`);
    log(`  ✅ Successfully deleted: ${deleteCount}`);
    log(`  ❌ Failed to delete: ${failCount}`);
    log(`  📋 Total attempted: ${existingVars.length}`);
    
    if (failCount > 0) {
      log(`${colors.yellow}⚠️  Some deletions failed. This might be due to permissions or API limits.${colors.reset}`);
    }
    
  } catch (error) {
    log(`${colors.red}❌ Failed to fetch existing variables: ${error.message}${colors.reset}`);
    log(`${colors.red}   Full error: ${JSON.stringify(error)}${colors.reset}`);
    throw error;
  }
}

async function main() {
  try {
    await syncEnvToCircleCI();
  } catch (error) {
    log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// Show usage if --help is passed
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${colors.bold}🔄 Environment Variable Sync to CircleCI${colors.reset}

${colors.blue}USAGE:${colors.reset}
  npm run sync:env                    # Sync .env files to CircleCI (update existing)
  npm run sync:env -- --clean         # Delete all existing vars, then sync
  npm run sync:env -- --delete-existing  # Same as --clean

${colors.blue}DESCRIPTION:${colors.reset}
  Syncs environment variables from .env.common and .env.<environment> to CircleCI.
  
  Environment precedence:
  1. .env.common (loaded first - base config)
  2. .env.\${APP_ENV|NODE_ENV|production} (loaded second - overrides)

${colors.blue}OPTIONS:${colors.reset}
  --clean, --delete-existing    Delete all existing CircleCI env vars before sync
  --delete-only                Delete all existing vars without recreating
  --help, -h                   Show this help message

${colors.blue}ENVIRONMENT:${colors.reset}
  APP_ENV or NODE_ENV          Environment name (default: production)
  CIRCLECI_TOKEN              Required: Your CircleCI API token

${colors.blue}EXAMPLES:${colors.reset}
  # Regular sync (recommended for most cases)
  npm run sync:env
  
  # Clean slate sync (use when you've removed variables locally)
  npm run sync:env -- --clean
  
  # Sync development environment
  NODE_ENV=development npm run sync:env

${colors.blue}GET YOUR CIRCLECI TOKEN:${colors.reset}
  https://app.circleci.com/settings/user/tokens

${colors.blue}VIEW RESULTS:${colors.reset}
  https://app.circleci.com/settings/project/${PROJECT_SLUG}/environment-variables
  `);
  process.exit(0);
}

main(); 