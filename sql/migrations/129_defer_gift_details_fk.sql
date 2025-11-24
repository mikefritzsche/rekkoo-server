BEGIN;

-- Allow maintain_gift_details trigger to insert the child row before the parent
-- by deferring the FK check until the end of the transaction.
ALTER TABLE public.gift_details
  ALTER CONSTRAINT gift_details_list_item_id_fkey
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
