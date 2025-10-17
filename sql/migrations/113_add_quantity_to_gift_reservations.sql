-- Migration: Add quantity support to gift_reservations
-- Ensures each reservation tracks how many units have been claimed.

BEGIN;

ALTER TABLE gift_reservations
  ADD COLUMN IF NOT EXISTS quantity INTEGER;

UPDATE gift_reservations
   SET quantity = 1
 WHERE quantity IS NULL;

ALTER TABLE gift_reservations
  ALTER COLUMN quantity SET NOT NULL,
  ALTER COLUMN quantity SET DEFAULT 1;

COMMIT;
