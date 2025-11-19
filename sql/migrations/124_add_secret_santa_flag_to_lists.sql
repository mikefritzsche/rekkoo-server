BEGIN;

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS secret_santa_enabled boolean NOT NULL DEFAULT FALSE;

COMMIT;
