#!/bin/bash

echo "🔍 Environment Files Debug Script"
echo "================================="

echo "📁 Current directory: $(pwd)"
echo "📂 Directory contents:"
ls -la

echo ""
echo "🗂️  Environment files in current directory:"
ls -la .env* 2>/dev/null || echo "No .env files found"

echo ""
echo "📋 Contents of .env.common (if exists):"
if [ -f .env.common ]; then
    echo "✅ .env.common found"
    echo "  Lines: $(wc -l < .env.common)"
    echo "  Size: $(du -h .env.common | cut -f1)"
    echo "  Apple OAuth variables:"
    grep -c "^APPLE_" .env.common 2>/dev/null || echo "  No Apple variables found"
    echo "  Sample variables (first 5):"
    grep -E '^[A-Z_]+=.*' .env.common | head -5 | sed 's/=.*/=***/' | sed 's/^/    /'
else
    echo "❌ .env.common NOT found"
fi

echo ""
echo "📋 Contents of .env (if exists):"
if [ -f .env ]; then
    echo "✅ .env found"
    echo "  Lines: $(wc -l < .env)"
    echo "  Size: $(du -h .env | cut -f1)"
    echo "  Apple OAuth variables:"
    grep -c "^APPLE_" .env 2>/dev/null || echo "  No Apple variables found"
else
    echo "ℹ️  .env not found"
fi

echo ""
echo "🐳 Docker Compose configuration check:"
if [ -f docker-compose.prod.yml ]; then
    echo "✅ docker-compose.prod.yml found"
    echo "  env_file configuration:"
    grep -A 5 "env_file:" docker-compose.prod.yml || echo "  No env_file section found"
else
    echo "❌ docker-compose.prod.yml NOT found"
fi

echo ""
echo "🔧 Docker Compose config resolution:"
if command -v docker compose &> /dev/null; then
    echo "Checking resolved environment variables..."
    docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -A 10 -B 5 "APPLE_" || echo "No Apple variables found in resolved config"
else
    echo "Docker Compose not available"
fi

echo "================================="
echo "✅ Debug script completed"