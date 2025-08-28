-- 033_create_list_user_overrides.sql
-- Per-user role overrides for a specific list

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.list_user_overrides (
  list_id UUID NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  permissions JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT list_user_overrides_role_check CHECK (role IN ('viewer','commenter','editor','admin','reserver')),
  CONSTRAINT list_user_overrides_pk PRIMARY KEY (list_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_luo_list_id ON public.list_user_overrides(list_id);
CREATE INDEX IF NOT EXISTS idx_luo_user_id ON public.list_user_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_luo_deleted_at ON public.list_user_overrides(deleted_at);

DROP TRIGGER IF EXISTS trg_list_user_overrides_changes ON public.list_user_overrides;
CREATE TRIGGER trg_list_user_overrides_changes
AFTER INSERT OR UPDATE OR DELETE ON public.list_user_overrides
FOR EACH ROW EXECUTE FUNCTION track_changes();

DROP TRIGGER IF EXISTS update_list_user_overrides_updated_at ON public.list_user_overrides;
CREATE TRIGGER update_list_user_overrides_updated_at
BEFORE UPDATE ON public.list_user_overrides
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();






