-- 035_create_list_group_user_roles.sql
-- Per-group, per-user roles on a specific list

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.list_group_user_roles (
  list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES public.collaboration_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  permissions JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT list_group_user_roles_role_check CHECK (role IN ('viewer','commenter','editor','admin','reserver')),
  CONSTRAINT list_group_user_roles_pk PRIMARY KEY (list_id, group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_lgur_list ON public.list_group_user_roles(list_id);
CREATE INDEX IF NOT EXISTS idx_lgur_group ON public.list_group_user_roles(group_id);
CREATE INDEX IF NOT EXISTS idx_lgur_user ON public.list_group_user_roles(user_id);

DROP TRIGGER IF EXISTS trg_list_group_user_roles_changes ON public.list_group_user_roles;
CREATE TRIGGER trg_list_group_user_roles_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_group_user_roles
FOR EACH ROW EXECUTE FUNCTION track_changes();

DROP TRIGGER IF EXISTS update_list_group_user_roles_updated_at ON public.list_group_user_roles;
CREATE TRIGGER update_list_group_user_roles_updated_at
BEFORE UPDATE ON public.list_group_user_roles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();





