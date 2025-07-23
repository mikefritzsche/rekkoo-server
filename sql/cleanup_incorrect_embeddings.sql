-- This script removes duplicate embeddings that were created with incorrect, non-standard entity_type labels.
-- Please back up your database before running this script.

BEGIN;

-- Deleting records with incorrect, pluralized, or hyphenated entity types
-- These were created by previous versions of the backfill script.
DELETE FROM public.embeddings
WHERE entity_type IN ('list-items', 'lists', 'users', 'favorites', 'reviews');

COMMIT;

-- After running this, please re-run the backfill script:
-- python scripts/backfill_embeddings.py 