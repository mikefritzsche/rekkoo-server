COMMIT;
BEGIN;

-- Ensure table exists for environments that missed the earlier Secret Santa migration
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'secret_santa_rounds'
  ) THEN
    CREATE TABLE public.secret_santa_rounds (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      list_id uuid NOT NULL REFERENCES public.lists (id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
      budget_cents integer,
      currency varchar(16) DEFAULT 'USD',
      exchange_date timestamptz,
      signup_cutoff_date timestamptz,
      note text,
      message text,
      exclusion_pairs jsonb DEFAULT '[]'::jsonb,
      auto_draw_enabled boolean NOT NULL DEFAULT false,
      notify_via_push boolean NOT NULL DEFAULT true,
      notify_via_email boolean NOT NULL DEFAULT false,
      created_by uuid REFERENCES public.users (id),
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_secret_santa_rounds_list_status
      ON public.secret_santa_rounds (list_id, status);
  END IF;
END$$;

ALTER TABLE public.secret_santa_rounds
  ADD COLUMN IF NOT EXISTS exclusion_pairs jsonb DEFAULT '[]'::jsonb;

UPDATE public.secret_santa_rounds
   SET exclusion_pairs = '[]'::jsonb
 WHERE exclusion_pairs IS NULL;

COMMIT;
