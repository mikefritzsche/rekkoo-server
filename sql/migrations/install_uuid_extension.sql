-- MANUAL UUID EXTENSION INSTALLATION
-- Run this script AS A SUPERUSER if the prerequisites script fails with UUID errors

-- Option 1: Try uuid-ossp (most common)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Option 2: If uuid-ossp doesn't work, try pgcrypto
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- After running one of the above, verify it worked:
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp') THEN
            'uuid-ossp extension installed successfully'
        WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
            'pgcrypto extension installed successfully'
        ELSE
            'No UUID extension found - installation may have failed'
    END as status;

-- Test UUID generation
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
            'uuid_generate_v4() function available: ' || uuid_generate_v4()::text
        WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
            'gen_random_uuid() function available: ' || gen_random_uuid()::text
        ELSE
            'No UUID generation function available'
    END as uuid_test;