#!/bin/bash

# Script to run the embedding dimension migration from 384 to 768
# This will delete all existing embeddings and update the vector columns

echo "========================================="
echo "Embedding Dimension Migration (384 → 768)"
echo "========================================="
echo ""
echo "⚠️  WARNING: This migration will:"
echo "   • Delete ALL existing embeddings"
echo "   • Update vector columns from 384 to 768 dimensions"
echo "   • Clear the embedding queue"
echo ""
echo "After this migration, you'll need to:"
echo "   1. Regenerate all embeddings"
echo "   2. Have users regenerate their preference embeddings"
echo ""
read -p "Do you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Migration cancelled."
    exit 1
fi

# Load environment variables
if [ -f "../.env" ]; then
    export $(cat ../.env | grep -v '^#' | xargs)
elif [ -f ".env" ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Database connection
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-rekkoo}
DB_USER=${DB_USER:-admin}

echo ""
echo "Connecting to database: $DB_NAME@$DB_HOST:$DB_PORT as $DB_USER"
echo ""

# Run the migration
PGPASSWORD=$DB_PASS psql \
    -h $DB_HOST \
    -p $DB_PORT \
    -U $DB_USER \
    -d $DB_NAME \
    -f ../sql/migrations/081_update_embedding_dimensions_to_768.sql

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migration completed successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Restart the server to ensure it uses the new dimensions"
    echo "2. Run: node scripts/generate-preference-embeddings.js"
    echo "3. Test preference-based suggestions"
else
    echo ""
    echo "❌ Migration failed! Check the error messages above."
    exit 1
fi