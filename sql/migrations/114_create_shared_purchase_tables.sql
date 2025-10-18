-- 114_create_shared_purchase_tables.sql
-- Introduces shared gift purchase groups and contribution tracking.

-- ============================================================================
-- Enum definitions use DO blocks for compatibility with older Postgres versions

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'purchase_group_status'
  ) THEN
    CREATE TYPE purchase_group_status AS ENUM ('open', 'locked', 'completed', 'abandoned');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'contribution_status'
  ) THEN
    CREATE TYPE contribution_status AS ENUM ('pledged', 'fulfilled', 'cancelled', 'expired');
  END IF;
END $$;

-- ============================================================================
-- Core tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.gift_purchase_groups
(
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  item_id uuid NOT NULL REFERENCES public.list_items(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  target_cents integer,
  target_quantity integer NOT NULL DEFAULT 1 CHECK (target_quantity >= 0),
  currency_code character(3),
  status purchase_group_status NOT NULL DEFAULT 'open',
  is_quantity_based boolean NOT NULL DEFAULT false,
  notes text,
  locked_at timestamp with time zone,
  completed_at timestamp with time zone,
  abandoned_at timestamp with time zone,
  reminder_scheduled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamp with time zone,
  CONSTRAINT gift_purchase_groups_currency_required CHECK (
    is_quantity_based OR currency_code IS NOT NULL
  ),
  CONSTRAINT gift_purchase_groups_target_required CHECK (
    is_quantity_based OR target_cents IS NOT NULL
  ),
  CONSTRAINT gift_purchase_groups_target_cents_positive CHECK (
    target_cents IS NULL OR target_cents >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_gift_purchase_groups_list_id
  ON public.gift_purchase_groups (list_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gift_purchase_groups_status
  ON public.gift_purchase_groups (status)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_gift_purchase_groups_item_active
  ON public.gift_purchase_groups (item_id)
  WHERE deleted_at IS NULL AND status IN ('open', 'locked');

CREATE TABLE IF NOT EXISTS public.gift_contributions
(
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  group_id uuid NOT NULL REFERENCES public.gift_purchase_groups(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.list_items(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  contributor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  contribution_cents integer,
  contribution_quantity integer NOT NULL DEFAULT 0 CHECK (contribution_quantity >= 0),
  status contribution_status NOT NULL DEFAULT 'pledged',
  note text,
  is_external boolean NOT NULL DEFAULT false,
  external_contributor_name text,
  fulfilled_at timestamp with time zone,
  source_reservation_id uuid REFERENCES public.gift_reservations(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamp with time zone,
  CONSTRAINT gift_contributions_amount_or_quantity CHECK (
    contribution_cents IS NOT NULL OR contribution_quantity > 0
  ),
  CONSTRAINT gift_contributions_cents_positive CHECK (
    contribution_cents IS NULL OR contribution_cents >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_gift_contributions_group
  ON public.gift_contributions (group_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gift_contributions_contributor
  ON public.gift_contributions (contributor_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gift_contributions_status
  ON public.gift_contributions (status)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_gift_contributions_group_contributor
  ON public.gift_contributions (group_id, contributor_id)
  WHERE deleted_at IS NULL AND contributor_id IS NOT NULL;

-- ============================================================================
-- gift_reservations linkage
-- ============================================================================

ALTER TABLE public.gift_reservations
  ADD COLUMN IF NOT EXISTS active_purchase_group_id uuid;

ALTER TABLE public.gift_reservations
  DROP CONSTRAINT IF EXISTS fk_gift_reservations_active_group;

ALTER TABLE public.gift_reservations
  ADD CONSTRAINT fk_gift_reservations_active_group
  FOREIGN KEY (active_purchase_group_id)
  REFERENCES public.gift_purchase_groups(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gift_reservations_active_group
  ON public.gift_reservations (active_purchase_group_id)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- Updated_at triggers
-- ============================================================================

DROP TRIGGER IF EXISTS update_gift_purchase_groups_updated_at ON public.gift_purchase_groups;
CREATE TRIGGER update_gift_purchase_groups_updated_at
BEFORE UPDATE ON public.gift_purchase_groups
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_gift_contributions_updated_at ON public.gift_contributions;
CREATE TRIGGER update_gift_contributions_updated_at
BEFORE UPDATE ON public.gift_contributions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- track_changes integration
-- ============================================================================

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'track_changes') THEN
    RAISE EXCEPTION 'track_changes() function is missing. Run core migrations first.';
  END IF;
END $mig$;

DROP TRIGGER IF EXISTS trg_gift_purchase_groups_changes ON public.gift_purchase_groups;
CREATE TRIGGER trg_gift_purchase_groups_changes
AFTER INSERT OR DELETE OR UPDATE ON public.gift_purchase_groups
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

DROP TRIGGER IF EXISTS trg_gift_contributions_changes ON public.gift_contributions;
CREATE TRIGGER trg_gift_contributions_changes
AFTER INSERT OR DELETE OR UPDATE ON public.gift_contributions
FOR EACH ROW EXECUTE FUNCTION public.track_changes();

-- ============================================================================
-- track_changes enhancements for new tables
-- ============================================================================

CREATE OR REPLACE FUNCTION track_changes()
RETURNS TRIGGER AS $$
DECLARE
  j JSONB;
  v_data JSONB;
  v_operation TEXT;
  v_id TEXT;
  v_user UUID;
  v_list_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_operation := 'create';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'UPDATE' THEN
    v_operation := 'update';
    j := to_jsonb(NEW.*);
    v_data := j;
  ELSIF TG_OP = 'DELETE' THEN
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
    (j->>'created_by')::uuid,
    (j->>'contributor_id')::uuid,
    CASE WHEN TG_TABLE_NAME = 'gift_reservations' THEN (j->>'reserved_by')::uuid ELSE NULL END,
    NULL
  );

  v_list_id := (j->>'list_id')::uuid;

  IF v_list_id IS NULL AND TG_TABLE_NAME = 'gift_contributions' AND (j->>'group_id') IS NOT NULL THEN
    SELECT list_id INTO v_list_id
    FROM public.gift_purchase_groups
    WHERE id = (j->>'group_id')::uuid;
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

  INSERT INTO change_log(table_name, record_id, operation, change_data, user_id)
  VALUES (TG_TABLE_NAME, v_id, v_operation, v_data, v_user);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
