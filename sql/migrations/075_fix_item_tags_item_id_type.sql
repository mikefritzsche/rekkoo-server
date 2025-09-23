-- Migration: Fix item_tags item_id column type
-- This migration ensures item_tags.item_id is properly typed as UUID to match items.id

-- Start transaction
BEGIN;

-- Check if item_id column exists and is not already UUID
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'item_tags'
        AND column_name = 'item_id'
        AND data_type != 'uuid'
    ) THEN
        -- Add a temporary UUID column
        ALTER TABLE item_tags ADD COLUMN IF NOT EXISTS item_id_temp UUID;

        -- Copy data from old column to new, converting item_id to UUID format
        -- Since items.id should already be UUID, we need to cast properly
        UPDATE item_tags
        SET item_id_temp = items.id::uuid
        FROM items
        WHERE item_tags.item_id = items.id::text;

        -- Drop the old column and rename the new one
        ALTER TABLE item_tags DROP COLUMN item_id;
        ALTER TABLE item_tags RENAME COLUMN item_id_temp TO item_id;

        -- Recreate the foreign key constraint
        ALTER TABLE item_tags
        ADD CONSTRAINT fk_item_tags_item_id
        FOREIGN KEY (item_id) REFERENCES items(id);

        -- Recreate the primary key
        ALTER TABLE item_tags
        DROP CONSTRAINT IF EXISTS item_tags_pkey;
        ALTER TABLE item_tags
        ADD PRIMARY KEY (item_id, tag_id);

        -- Add index for item_id
        CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id);
    END IF;
END $$;

-- Commit the transaction
COMMIT;