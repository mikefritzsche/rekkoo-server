-- TEST SCRIPT: Verify connection system migrations
-- Description: Tests the connection system tables and triggers
-- Run this after applying migrations 040-043

-- Test 1: Verify tables exist
SELECT 'Test 1: Checking if tables exist' as test;
SELECT tablename,
       CASE WHEN tablename IS NOT NULL THEN '✓ Table exists' ELSE '✗ Table missing' END as status
FROM pg_tables
WHERE schemaname = 'public'
AND tablename IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations');

-- Test 2: Verify table structures
SELECT 'Test 2: Checking connections table structure' as test;
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'connections'
ORDER BY ordinal_position;

-- Test 3: Verify indexes exist
SELECT 'Test 3: Checking indexes' as test;
SELECT indexname,
       CASE WHEN indexname IS NOT NULL THEN '✓ Index exists' ELSE '✗ Index missing' END as status
FROM pg_indexes
WHERE schemaname = 'public'
AND tablename IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations');

-- Test 4: Verify functions exist
SELECT 'Test 4: Checking functions' as test;
SELECT routine_name,
       CASE WHEN routine_name IS NOT NULL THEN '✓ Function exists' ELSE '✗ Function missing' END as status
FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name IN (
    'generate_invitation_code',
    'set_invitation_code',
    'generate_connection_code',
    'set_user_connection_code',
    'check_connection_before_group_invite',
    'accept_group_invitation'
);

-- Test 5: Test privacy settings default insertion for existing users
SELECT 'Test 5: Checking privacy settings for existing users' as test;
SELECT COUNT(*) as users_with_privacy_settings
FROM public.user_privacy_settings;

-- Test 6: Test connection code generation
SELECT 'Test 6: Testing connection code generation' as test;
SELECT public.generate_connection_code() as sample_code_1,
       public.generate_connection_code() as sample_code_2,
       public.generate_connection_code() as sample_code_3;

-- Test 7: Test invitation code generation
SELECT 'Test 7: Testing invitation code generation' as test;
SELECT public.generate_invitation_code() as sample_invitation_1,
       public.generate_invitation_code() as sample_invitation_2,
       public.generate_invitation_code() as sample_invitation_3;

-- Test 8: Verify constraints
SELECT 'Test 8: Checking constraints' as test;
SELECT conname as constraint_name,
       pg_get_constraintdef(oid) as definition
FROM pg_constraint
WHERE conrelid IN (
    'public.connections'::regclass,
    'public.connection_invitations'::regclass,
    'public.user_privacy_settings'::regclass,
    'public.group_invitations'::regclass
)
ORDER BY conrelid, conname;

-- Test 9: Verify triggers
SELECT 'Test 9: Checking triggers' as test;
SELECT trigger_name, event_object_table,
       CASE WHEN trigger_name IS NOT NULL THEN '✓ Trigger exists' ELSE '✗ Trigger missing' END as status
FROM information_schema.triggers
WHERE trigger_schema = 'public'
AND event_object_table IN ('connections', 'connection_invitations', 'user_privacy_settings', 'group_invitations')
ORDER BY event_object_table, trigger_name;

-- Summary
SELECT 'Test Summary' as test;
SELECT
    'Connection System Migration Test Complete' as message,
    'Please review the results above and verify all components are working correctly' as note;