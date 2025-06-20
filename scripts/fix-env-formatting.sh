#!/bin/bash

echo "🔧 Fixing .env.common formatting for Docker Compose compatibility"
echo "================================================================="

# Create a backup
cp .env.common .env.common.backup
echo "✅ Created backup: .env.common.backup"

# Fix the APPLE_PRIVATE_KEY formatting by putting it all on one line
echo "🔍 Fixing APPLE_PRIVATE_KEY formatting..."

# Read the file and fix the multiline private key
awk '
BEGIN { in_private_key = 0; private_key_line = "" }
/^APPLE_PRIVATE_KEY=/ { 
    in_private_key = 1
    private_key_line = $0
    # Remove the trailing quote if present
    gsub(/"$/, "", private_key_line)
    next
}
in_private_key && /-----END PRIVATE KEY-----"/ {
    # This is the end of the private key, add it and close the quote
    private_key_line = private_key_line $0
    print private_key_line
    in_private_key = 0
    private_key_line = ""
    next
}
in_private_key {
    # This is a continuation line of the private key
    private_key_line = private_key_line $0
    next
}
!in_private_key {
    # Regular line, print as-is
    print $0
}
' .env.common.backup > .env.common

echo "✅ Fixed APPLE_PRIVATE_KEY formatting"
echo "📋 Verifying Apple OAuth variables:"
grep -c "^APPLE_" .env.common | xargs echo "  Found Apple variables:"
echo "🎯 Private key is now on a single line"

echo "================================================================="
echo "🎉 .env.common formatting fixed!" 