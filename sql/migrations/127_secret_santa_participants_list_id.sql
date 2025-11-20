BEGIN;

ALTER TABLE public.secret_santa_round_participants
  ADD COLUMN IF NOT EXISTS list_id uuid;

UPDATE public.secret_santa_round_participants rsp
   SET list_id = sr.list_id
  FROM public.secret_santa_rounds sr
 WHERE rsp.round_id = sr.id
   AND (rsp.list_id IS NULL OR rsp.list_id <> sr.list_id);

ALTER TABLE public.secret_santa_round_participants
  ALTER COLUMN list_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE constraint_name = 'fk_secret_santa_participants_list'
       AND table_name = 'secret_santa_round_participants'
       AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.secret_santa_round_participants
      ADD CONSTRAINT fk_secret_santa_participants_list
          FOREIGN KEY (list_id)
          REFERENCES public.lists (id)
          ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_secret_santa_participants_list
  ON public.secret_santa_round_participants (list_id);

COMMIT;
