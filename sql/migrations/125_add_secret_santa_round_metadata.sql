BEGIN;

ALTER TABLE public.secret_santa_rounds
  ADD COLUMN IF NOT EXISTS signup_cutoff_date timestamptz;

ALTER TABLE public.secret_santa_rounds
  ADD COLUMN IF NOT EXISTS auto_draw_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.secret_santa_rounds
  ADD COLUMN IF NOT EXISTS notify_via_push boolean NOT NULL DEFAULT true;

ALTER TABLE public.secret_santa_rounds
  ADD COLUMN IF NOT EXISTS notify_via_email boolean NOT NULL DEFAULT false;

COMMIT;
