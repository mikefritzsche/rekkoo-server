#!/bin/bash

# Setup Git Hooks for Environment Variable Sync
# This script creates git hooks that track .env file changes using file hashes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
HASH_TRACKING_FILE="$PROJECT_ROOT/.git/env-hashes"

echo "🔧 Setting up Git hooks for automatic env var sync..."

# Create pre-push hook with hash-based tracking
cat > "$GIT_HOOKS_DIR/pre-push" << 'EOF'
#!/bin/bash

# Pre-push hook to sync environment variables to CircleCI
# Uses file hashes to detect .env changes (works with gitignored files)

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HASH_FILE="$PROJECT_ROOT/.git/env-hashes"

echo -e "${BLUE}🔍 Checking for .env file changes...${NC}"

# Environment files to check
ENV_FILES=(".env" ".env.common" ".env.development" ".env.production" ".env.staging")

# Function to calculate file hash
calculate_hash() {
    local file="$1"
    if [[ -f "$file" ]]; then
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$file" | cut -d' ' -f1
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$file" | cut -d' ' -f1
        else
            # Fallback to md5 if sha256 not available
            md5sum "$file" 2>/dev/null | cut -d' ' -f1 || md5 -q "$file" 2>/dev/null
        fi
    else
        echo "FILE_NOT_FOUND"
    fi
}

# Read previous hashes into temp file
OLD_HASH_TEMP=$(mktemp)
if [[ -f "$HASH_FILE" ]]; then
    cp "$HASH_FILE" "$OLD_HASH_TEMP"
fi

# Calculate current hashes and check for changes
NEW_HASH_TEMP=$(mktemp)
files_changed=false

cd "$PROJECT_ROOT"
for env_file in "${ENV_FILES[@]}"; do
    current_hash=$(calculate_hash "$env_file")
    echo "$env_file=$current_hash" >> "$NEW_HASH_TEMP"
    
    # Get old hash for this file
    old_hash=""
    if [[ -f "$OLD_HASH_TEMP" ]]; then
        old_hash=$(grep "^$env_file=" "$OLD_HASH_TEMP" 2>/dev/null | cut -d'=' -f2)
    fi
    
    if [[ "$old_hash" != "$current_hash" ]]; then
        if [[ -f "$env_file" ]]; then
            echo -e "${YELLOW}📝 Detected change in: $env_file${NC}"
            files_changed=true
        elif [[ "$old_hash" != "FILE_NOT_FOUND" && -n "$old_hash" ]]; then
            echo -e "${YELLOW}🗑️  Detected deletion of: $env_file${NC}"
            files_changed=true
        fi
    fi
done

if [[ "$files_changed" == true ]]; then
    echo -e "${BLUE}🔄 Syncing environment variables to CircleCI...${NC}"
    
    # Check if sync script exists
    if [[ -f "scripts/sync-env-to-circleci.js" ]]; then
        if npm run sync:env; then
            echo -e "${GREEN}✅ Environment variables successfully synced to CircleCI${NC}"
            
            # Update hash file with new hashes
            cp "$NEW_HASH_TEMP" "$HASH_FILE"
        else
            echo -e "${YELLOW}⚠️  Failed to sync environment variables to CircleCI${NC}"
            echo -e "${YELLOW}   Continuing with push, but you may need to sync manually${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Sync script not found at scripts/sync-env-to-circleci.js${NC}"
    fi
else
    echo -e "${GREEN}✅ No .env file changes detected${NC}"
fi

# Clean up temp files
rm -f "$OLD_HASH_TEMP" "$NEW_HASH_TEMP"

# Continue with push
exit 0
EOF

# Make the hook executable
chmod +x "$GIT_HOOKS_DIR/pre-push"

# Initialize hash tracking file
echo "🔧 Initializing .env file hash tracking..."
cd "$PROJECT_ROOT"
HASH_FILE="$PROJECT_ROOT/.git/env-hashes"
: > "$HASH_FILE"  # Create/clear file

ENV_FILES=(".env" ".env.common" ".env.development" ".env.production" ".env.staging")

for env_file in "${ENV_FILES[@]}"; do
    if [[ -f "$env_file" ]]; then
        if command -v sha256sum >/dev/null 2>&1; then
            hash=$(sha256sum "$env_file" | cut -d' ' -f1)
        elif command -v shasum >/dev/null 2>&1; then
            hash=$(shasum -a 256 "$env_file" | cut -d' ' -f1)
        else
            hash=$(md5sum "$env_file" 2>/dev/null | cut -d' ' -f1 || md5 -q "$env_file" 2>/dev/null)
        fi
        echo "$env_file=$hash" >> "$HASH_FILE"
        echo "📋 Tracking: $env_file"
    fi
done

# Create pre-commit hook (warns about .env changes)
cat > "$GIT_HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash

# Pre-commit hook to provide .env sync reminders

# Colors for output
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}💡 Reminder: .env files are gitignored but will auto-sync on push${NC}"
echo ""

# Continue with commit
exit 0
EOF

# Make the hook executable
chmod +x "$GIT_HOOKS_DIR/pre-commit"

echo "✅ Git hooks installed successfully!"
echo ""
echo "📋 Installed hooks:"
echo "  • pre-push:   Auto-syncs .env changes to CircleCI (hash-based detection)"
echo "  • pre-commit: Provides sync reminders"
echo ""
echo "🚀 Usage:"
echo "  - Modify your .env files"
echo "  - Push to remote → hooks will detect changes and sync to CircleCI"
echo ""
echo "🔧 Manual sync: npm run sync:env"
echo "📁 Hash tracking: .git/env-hashes" 