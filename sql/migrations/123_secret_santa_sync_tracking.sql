BEGIN;

-- Ensure Secret Santa changes flow through the generic change_log trigger
CREATE OR REPLACE FUNCTION public.track_changes() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
AS $$
DECLARE
  j JSONB;
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
  v_list_id UUID;
  v_round_id UUID;
  v_round_list_id UUID;
  v_round_owner UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSE
    v_operation := 'delete';
    j := to_jsonb(OLD.*);
    v_data := NULL;
  END IF;

  v_id := COALESCE(
    (j->>'id')::TEXT,
    (j->>'uuid')::TEXT,
    (j->>'pk')::TEXT,
    CASE WHEN (j ? 'item_id') AND (j ? 'tag_id') THEN (j->>'item_id') || ':' || (j->>'tag_id') ELSE NULL END,
    '-'
  );

  v_user := COALESCE(
    (j->>'user_id')::uuid,
    (j->>'owner_id')::uuid,
    CASE WHEN TG_TABLE_NAME = 'gift_reservations' THEN (j->>'reserved_by')::uuid ELSE NULL END,
    NULL
  );

  v_list_id := (j->>'list_id')::uuid;
  v_round_id := NULL;
  v_round_list_id := NULL;
  v_round_owner := NULL;

  IF TG_TABLE_NAME IN (
    'secret_santa_rounds',
    'secret_santa_round_participants',
    'secret_santa_pairings',
    'secret_santa_guest_invites'
  ) THEN
    IF TG_TABLE_NAME = 'secret_santa_rounds' THEN
      v_round_id := COALESCE((j->>'id')::uuid, (j->>'round_id')::uuid);
      v_round_list_id := (j->>'list_id')::uuid;
    ELSE
      v_round_id := (j->>'round_id')::uuid;
    END IF;

    IF v_round_list_id IS NULL AND v_round_id IS NOT NULL THEN
      SELECT list_id INTO v_round_list_id FROM public.secret_santa_rounds WHERE id = v_round_id;
    END IF;

    IF TG_TABLE_NAME = 'secret_santa_pairings' THEN
      v_user := COALESCE((j->>'giver_user_id')::uuid, v_user);
    ELSIF TG_TABLE_NAME = 'secret_santa_round_participants' THEN
      v_user := COALESCE((j->>'user_id')::uuid, v_user);
    END IF;

    IF v_list_id IS NULL THEN
      v_list_id := v_round_list_id;
    END IF;
  END IF;

  IF v_user IS NULL AND v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_user FROM public.lists WHERE id = v_list_id;
  END IF;

  IF v_user IS NULL AND TG_TABLE_NAME = 'gift_reservations' AND (j->>'item_id') IS NOT NULL THEN
    SELECT l.owner_id INTO v_user
    FROM public.list_items li
    JOIN public.lists l ON li.list_id = l.id
    WHERE li.id = (j->>'item_id')::uuid;
  END IF;

  IF v_round_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_round_owner FROM public.lists WHERE id = v_round_list_id;
  ELSIF v_list_id IS NOT NULL THEN
    SELECT owner_id INTO v_round_owner FROM public.lists WHERE id = v_list_id;
  END IF;

  IF v_user IS NOT NULL THEN
    INSERT INTO change_log(table_name, record_id, operation, change_data, user_id)
    VALUES (
      TG_TABLE_NAME,
      v_id,
      v_operation,
      v_data,
      v_user
    );
  END IF;

  IF v_round_owner IS NOT NULL AND (v_user IS NULL OR v_round_owner <> v_user) THEN
    INSERT INTO change_log(table_name, record_id, operation, change_data, user_id)
    VALUES (
      TG_TABLE_NAME,
      v_id,
      v_operation,
      v_data,
      v_round_owner
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Attach track_changes trigger to Secret Santa tables
DROP TRIGGER IF EXISTS trg_secret_santa_rounds_changes ON public.secret_santa_rounds;
CREATE TRIGGER trg_secret_santa_rounds_changes
AFTER INSERT OR DELETE OR UPDATE ON public.secret_santa_rounds
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

DROP TRIGGER IF EXISTS trg_secret_santa_participants_changes ON public.secret_santa_round_participants;
CREATE TRIGGER trg_secret_santa_participants_changes
AFTER INSERT OR DELETE OR UPDATE ON public.secret_santa_round_participants
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

DROP TRIGGER IF EXISTS trg_secret_santa_pairings_changes ON public.secret_santa_pairings;
CREATE TRIGGER trg_secret_santa_pairings_changes
AFTER INSERT OR DELETE OR UPDATE ON public.secret_santa_pairings
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

DROP TRIGGER IF EXISTS trg_secret_santa_invites_changes ON public.secret_santa_guest_invites;
CREATE TRIGGER trg_secret_santa_invites_changes
AFTER INSERT OR DELETE OR UPDATE ON public.secret_santa_guest_invites
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

COMMIT;
