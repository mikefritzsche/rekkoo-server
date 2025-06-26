#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuration
const projectRoot = path.join(__dirname, '..');
const envFiles = [
  '.env',
  '.env.common',
  '.env.development',
  '.env.production',
  '.env.staging'
];

// Colors for console output
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

console.log(`${colors.bold}🔍 Watching .env files for changes...${colors.reset}`);
console.log(`${colors.blue}Press Ctrl+C to stop${colors.reset}\n`);

// Track last sync time to prevent duplicate syncs
let lastSyncTime = 0;
const SYNC_DEBOUNCE_MS = 2000; // Wait 2 seconds between syncs

// Function to sync environment variables
async function syncToCircleCI() {
  const now = Date.now();
  if (now - lastSyncTime < SYNC_DEBOUNCE_MS) {
    console.log(`${colors.yellow}⏳ Debouncing sync (too soon after last sync)${colors.reset}`);
    return;
  }
  
  lastSyncTime = now;
  
  console.log(`${colors.blue}🔄 Syncing environment variables to CircleCI...${colors.reset}`);
  
  try {
    const syncProcess = spawn('npm', ['run', 'sync:env'], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    
    syncProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`${colors.green}✅ Environment variables synced successfully${colors.reset}\n`);
      } else {
        console.log(`${colors.red}❌ Sync failed with exit code ${code}${colors.reset}\n`);
      }
    });
    
  } catch (error) {
    console.log(`${colors.red}❌ Error running sync: ${error.message}${colors.reset}\n`);
  }
}

// Set up file watchers
const watchers = [];

envFiles.forEach(envFile => {
  const filePath = path.join(projectRoot, envFile);
  
  // Check if file exists before watching
  if (fs.existsSync(filePath)) {
    console.log(`${colors.green}👁️  Watching: ${envFile}${colors.reset}`);
    
    const watcher = fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtime > prev.mtime) {
        console.log(`${colors.yellow}📝 Detected change in: ${envFile}${colors.reset}`);
        syncToCircleCI();
      }
    });
    
    watchers.push(() => fs.unwatchFile(filePath));
  } else {
    console.log(`${colors.yellow}⚠️  File not found: ${envFile} (will not watch)${colors.reset}`);
  }
});

if (watchers.length === 0) {
  console.log(`${colors.red}❌ No .env files found to watch${colors.reset}`);
  process.exit(1);
}

console.log(`\n${colors.green}✅ Watching ${watchers.length} .env files${colors.reset}`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${colors.yellow}🛑 Stopping .env file watcher...${colors.reset}`);
  
  // Clean up watchers
  watchers.forEach(cleanup => cleanup());
  
  console.log(`${colors.green}✅ Stopped watching .env files${colors.reset}`);
  process.exit(0);
});

// Keep the process alive
process.stdin.resume(); 