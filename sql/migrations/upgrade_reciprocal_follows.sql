-- Optional: Upgrade reciprocal following relationships to mutual connections
-- Run this AFTER migration 045 if you want to convert reciprocal follows to mutual connections
-- This is when User A follows User B AND User B follows User A

BEGIN;

-- Step 1: Count reciprocal relationships before upgrade
DO $$
DECLARE
    reciprocal_count INTEGER;
    reciprocal_users INTEGER;
BEGIN
    SELECT COUNT(*) / 2 INTO reciprocal_count
    FROM connections c1
    JOIN connections c2 ON c1.user_id = c2.connection_id
                       AND c1.connection_id = c2.user_id
    WHERE c1.connection_type = 'following'
      AND c2.connection_type = 'following'
      AND c1.user_id < c1.connection_id;

    SELECT COUNT(DISTINCT user_id) INTO reciprocal_users
    FROM connections c1
    WHERE connection_type = 'following'
      AND EXISTS (
          SELECT 1 FROM connections c2
          WHERE c2.user_id = c1.connection_id
            AND c2.connection_id = c1.user_id
            AND c2.connection_type = 'following'
      );

    RAISE NOTICE '=== Reciprocal Following Analysis ===';
    RAISE NOTICE 'Found % reciprocal following pairs', reciprocal_count;
    RAISE NOTICE 'Affecting % unique users', reciprocal_users;
    RAISE NOTICE '';
    RAISE NOTICE 'These will be upgraded to mutual connections...';
END $$;

-- Step 2: Show sample of relationships to be upgraded (for review)
DO $$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE 'Sample of relationships to be upgraded:';
    FOR r IN
        SELECT
            u1.username as user1,
            u2.username as user2,
            c1.created_at as follow1_date,
            c2.created_at as follow2_date
        FROM connections c1
        JOIN connections c2 ON c1.user_id = c2.connection_id
                           AND c1.connection_id = c2.user_id
        JOIN users u1 ON u1.id = c1.user_id
        JOIN users u2 ON u2.id = c1.connection_id
        WHERE c1.connection_type = 'following'
          AND c2.connection_type = 'following'
          AND c1.user_id < c1.connection_id
        LIMIT 5
    LOOP
        RAISE NOTICE '  @% ↔️ @% (followed each other on % and %)',
            r.user1, r.user2, r.follow1_date::date, r.follow2_date::date;
    END LOOP;
END $$;

-- Step 3: Perform the upgrade
UPDATE connections c1
SET
    connection_type = 'mutual',
    status = 'accepted',
    -- Use the earlier of the two follow dates as the accepted date
    accepted_at = LEAST(
        c1.created_at,
        (SELECT c2.created_at FROM connections c2
         WHERE c2.user_id = c1.connection_id
           AND c2.connection_id = c1.user_id
           AND c2.connection_type = 'following')
    ),
    updated_at = CURRENT_TIMESTAMP
FROM connections c2
WHERE c1.user_id = c2.connection_id
  AND c1.connection_id = c2.user_id
  AND c1.connection_type = 'following'
  AND c2.connection_type = 'following';

-- Step 4: Report results
DO $$
DECLARE
    rows_updated INTEGER;
    pairs_upgraded INTEGER;
    remaining_following INTEGER;
    total_mutual INTEGER;
BEGIN
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    pairs_upgraded := rows_updated / 2;

    SELECT COUNT(*) INTO remaining_following
    FROM connections
    WHERE connection_type = 'following';

    SELECT COUNT(*) INTO total_mutual
    FROM connections
    WHERE connection_type = 'mutual';

    RAISE NOTICE '';
    RAISE NOTICE '=== Upgrade Complete ===';
    RAISE NOTICE '✅ Upgraded % reciprocal pairs to mutual connections', pairs_upgraded;
    RAISE NOTICE '   (% total rows updated)', rows_updated;
    RAISE NOTICE '';
    RAISE NOTICE 'Current Statistics:';
    RAISE NOTICE '  Mutual connections: %', total_mutual;
    RAISE NOTICE '  Following connections: %', remaining_following;
END $$;

-- Step 5: Verify no reciprocal follows remain
DO $$
DECLARE
    remaining_reciprocal INTEGER;
BEGIN
    SELECT COUNT(*) / 2 INTO remaining_reciprocal
    FROM connections c1
    JOIN connections c2 ON c1.user_id = c2.connection_id
                       AND c1.connection_id = c2.user_id
    WHERE c1.connection_type = 'following'
      AND c2.connection_type = 'following'
      AND c1.user_id < c1.connection_id;

    IF remaining_reciprocal = 0 THEN
        RAISE NOTICE '';
        RAISE NOTICE '✅ Verification: No reciprocal following relationships remain';
    ELSE
        RAISE WARNING '⚠️  Warning: % reciprocal following relationships still exist', remaining_reciprocal;
    END IF;
END $$;

COMMIT;

-- To view the upgraded connections:
/*
SELECT
    c.user_id,
    u1.username as user,
    c.connection_id,
    u2.username as connected_to,
    c.connection_type,
    c.status,
    c.accepted_at
FROM connections c
JOIN users u1 ON u1.id = c.user_id
JOIN users u2 ON u2.id = c.connection_id
WHERE c.connection_type = 'mutual'
  AND c.updated_at >= NOW() - INTERVAL '5 minutes'
ORDER BY c.updated_at DESC
LIMIT 20;
*/