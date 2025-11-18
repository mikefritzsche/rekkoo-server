-- Secret Santa feature tables
-- Run this migration to create core tables for gift-list Secret Santa rounds

CREATE TABLE IF NOT EXISTS public.secret_santa_rounds (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    list_id uuid NOT NULL REFERENCES public.lists (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
    budget_cents integer,
    currency varchar(16) DEFAULT 'USD',
    exchange_date date,
    note text,
    message text,
    created_by uuid NOT NULL REFERENCES public.users (id),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secret_santa_rounds_list_status
  ON public.secret_santa_rounds (list_id, status);

CREATE TABLE IF NOT EXISTS public.secret_santa_round_participants (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'confirmed',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (round_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_secret_santa_participants_round
  ON public.secret_santa_round_participants (round_id);

CREATE TABLE IF NOT EXISTS public.secret_santa_pairings (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
    giver_user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    recipient_user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    revealed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (round_id, giver_user_id)
);

CREATE INDEX IF NOT EXISTS idx_secret_santa_pairings_round
  ON public.secret_santa_pairings (round_id);

CREATE TABLE IF NOT EXISTS public.secret_santa_guest_invites (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
    email text NOT NULL,
    invite_token uuid NOT NULL DEFAULT uuid_generate_v4(),
    status text NOT NULL DEFAULT 'pending',
    message text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (round_id, email)
);

CREATE INDEX IF NOT EXISTS idx_secret_santa_guest_invites_round
  ON public.secret_santa_guest_invites (round_id);
