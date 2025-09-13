-- UUID STATUS CHECK
-- Run this to diagnose UUID issues in your database

-- 1. Check what extensions are installed
SELECT 'Installed Extensions:' as info;
SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('uuid-ossp', 'pgcrypto', 'uuid')
ORDER BY extname;

-- 2. Check if UUID functions exist
SELECT 'UUID Functions Available:' as info;
SELECT n.nspname as schema, p.proname as function_name
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname IN ('uuid_generate_v4', 'gen_random_uuid', 'uuid_generate_v1')
ORDER BY n.nspname, p.proname;

-- 3. Check current user privileges
SELECT 'Current User Info:' as info;
SELECT current_user, session_user,
       has_database_privilege(current_user, current_database(), 'CREATE') as can_create,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) as is_superuser;

-- 4. Try to generate a UUID using different methods
SELECT 'UUID Generation Test:' as info;
DO $$
DECLARE
    test_uuid UUID;
    method_used TEXT;
BEGIN
    -- Try method 1: uuid_generate_v4 (from uuid-ossp)
    BEGIN
        test_uuid := public.uuid_generate_v4();
        method_used := 'uuid_generate_v4() from uuid-ossp';
        RAISE NOTICE 'Success with %: %', method_used, test_uuid;
        RETURN;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Failed with uuid_generate_v4(): %', SQLERRM;
    END;

    -- Try method 2: gen_random_uuid (from pgcrypto)
    BEGIN
        test_uuid := gen_random_uuid();
        method_used := 'gen_random_uuid() from pgcrypto';
        RAISE NOTICE 'Success with %: %', method_used, test_uuid;
        RETURN;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Failed with gen_random_uuid(): %', SQLERRM;
    END;

    -- Try method 3: manual generation (fallback)
    BEGIN
        test_uuid := md5(random()::text || clock_timestamp()::text)::uuid;
        method_used := 'Manual MD5-based generation';
        RAISE NOTICE 'Success with %: %', method_used, test_uuid;
        RETURN;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Failed with manual generation: %', SQLERRM;
    END;

    RAISE WARNING 'All UUID generation methods failed!';
END $$;

-- 5. Recommendation
SELECT 'Recommendation:' as info;
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
            'UUID support is available. You can proceed with migrations.'
        WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
            'pgcrypto UUID support is available. Run the prerequisites to create uuid_generate_v4 wrapper.'
        WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
            'You are a superuser. Run: CREATE EXTENSION "uuid-ossp";'
        ELSE
            'No UUID support. Ask your DBA to run: CREATE EXTENSION "uuid-ossp";'
    END as recommendation;