#!/bin/bash

# Script to deploy favorites feature database changes
# This script assumes you have PostgreSQL installed and configured

echo "Deploying favorites feature database changes..."

# Get database credentials from environment or use defaults
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-rekkoo}
DB_USER=${DB_USER:-admin}
DB_PASSWORD=${DB_PASSWORD:-admin}

# Apply database migrations
echo "Applying database migrations..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f ../sql/migrations/favorite_feature.sql

if [ $? -eq 0 ]; then
  echo "Migration applied successfully!"
else
  echo "Error applying migration. Please check the SQL file and database connection."
  exit 1
fi

# Add tables to sync_tracking system tables list if needed
echo "Adding favorites tables to sync_tracking..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME << EOF
INSERT INTO public.sync_tracking_tables (table_name, created_at) 
VALUES 
  ('favorites', CURRENT_TIMESTAMP),
  ('favorite_categories', CURRENT_TIMESTAMP),
  ('favorite_sharing', CURRENT_TIMESTAMP),
  ('favorite_notification_preferences', CURRENT_TIMESTAMP)
ON CONFLICT (table_name) DO NOTHING;
EOF

if [ $? -eq 0 ]; then
  echo "Tables added to sync_tracking successfully!"
else
  echo "Error adding tables to sync_tracking. Please check if the sync_tracking_tables table exists."
  exit 1
fi

echo "Favorites feature database deployment completed successfully!" 