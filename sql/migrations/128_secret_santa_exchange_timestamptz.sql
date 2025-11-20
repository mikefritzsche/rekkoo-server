BEGIN;

ALTER TABLE public.secret_santa_rounds
  ALTER COLUMN exchange_date TYPE timestamptz
  USING
    CASE
      WHEN exchange_date IS NULL THEN NULL
      ELSE exchange_date::timestamptz
    END;

COMMIT;
