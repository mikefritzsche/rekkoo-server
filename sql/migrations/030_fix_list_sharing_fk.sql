-- 030_fix_list_sharing_fk.sql
-- Point list_sharing.shared_with_group_id to collaboration_groups instead of legacy user_groups

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'list_sharing_shared_with_group_id_fk' 
      AND table_name = 'list_sharing'
  ) THEN
    -- Nothing to drop
    NULL;
  ELSE
    ALTER TABLE public.list_sharing DROP CONSTRAINT list_sharing_shared_with_group_id_fk;
  END IF;
END $$;

ALTER TABLE public.list_sharing
  ADD CONSTRAINT list_sharing_shared_with_group_id_fk
  FOREIGN KEY (shared_with_group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;

-- Optional: ensure existing orphaned rows are safe (soft delete them)
-- UPDATE public.list_sharing ls
-- SET deleted_at = CURRENT_TIMESTAMP
-- WHERE shared_with_group_id IS NOT NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM public.collaboration_groups cg WHERE cg.id = ls.shared_with_group_id
--   );





