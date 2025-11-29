const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { logger } = require('../utils/logger');
const NotificationService = require('./NotificationService');

const PARTICIPANT_STATUS = {
  INVITED: 'invited',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  REMOVED: 'removed',
};

const createHttpError = (status, message) => {
  const error = new Error(message);
  error.statusCode = status;
  return error;
};

const sanitizeCurrency = (currency) => {
  if (!currency) return 'USD';
  return currency.toUpperCase().slice(0, 8);
};

const parseExclusionInput = (value) => {
  if (!value && value !== 0) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
};

const normalizeExclusionPairs = (rawPairs = [], allowedParticipants = []) => {
  const allowedSet = new Set((allowedParticipants || []).map((id) => String(id)));
  const seen = new Set();
  const pairs = [];

  parseExclusionInput(rawPairs).forEach((entry) => {
    const userId = entry?.user_id || entry?.userId || entry?.giver_user_id;
    const excludedId =
      entry?.excluded_user_id ||
      entry?.excludedUserId ||
      entry?.recipient_user_id ||
      entry?.recipientUserId;

    if (!userId || !excludedId) return;
    const giver = String(userId);
    const recipient = String(excludedId);
    if (giver === recipient) return;
    if (allowedSet.size && (!allowedSet.has(giver) || !allowedSet.has(recipient))) return;

    const [first, second] = giver < recipient ? [giver, recipient] : [recipient, giver];
    const key = `${first}__${second}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ user_id: giver, excluded_user_id: recipient });
  });

  return pairs.sort((a, b) => `${a.user_id}${a.excluded_user_id}`.localeCompare(`${b.user_id}${b.excluded_user_id}`));
};

const areExclusionsEqual = (a = [], b = []) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].user_id !== b[i].user_id || a[i].excluded_user_id !== b[i].excluded_user_id) {
      return false;
    }
  }
  return true;
};

const mapUserDisplay = (row) => ({
  userId: row.user_id,
  displayName: row.full_name || row.username,
  email: row.email || null,
  avatarUrl: row.profile_image_url || null,
  status: row.status || PARTICIPANT_STATUS.INVITED,
  isOwner: row.is_owner || false,
  isCoOwner: row.is_co_owner || false,
  isCurrentUser: row.is_current_user || false,
});

let secretSantaSchemaReady = false;

const ensureSecretSantaSchema = async () => {
  if (secretSantaSchemaReady) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS public.secret_santa_rounds (
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
        created_by uuid NOT NULL REFERENCES public.users (id),
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_rounds_list_status
        ON public.secret_santa_rounds (list_id, status)`,
    `CREATE TABLE IF NOT EXISTS public.secret_santa_round_participants (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
        list_id uuid NOT NULL REFERENCES public.lists (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'confirmed',
        wishlist_list_id uuid,
        wishlist_type text,
        wishlist_share_consent boolean DEFAULT false,
        wishlist_share_consented_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (round_id, user_id)
      )`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_participants_round
        ON public.secret_santa_round_participants (round_id)`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_participants_list
        ON public.secret_santa_round_participants (list_id)`,
    `CREATE TABLE IF NOT EXISTS public.secret_santa_pairings (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
        giver_user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
        recipient_user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
        revealed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (round_id, giver_user_id)
      )`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_pairings_round
        ON public.secret_santa_pairings (round_id)`,
    `CREATE TABLE IF NOT EXISTS public.secret_santa_guest_invites (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        round_id uuid NOT NULL REFERENCES public.secret_santa_rounds (id) ON DELETE CASCADE,
        email text NOT NULL,
        invite_token uuid NOT NULL DEFAULT uuid_generate_v4(),
        status text NOT NULL DEFAULT 'pending',
        message text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (round_id, email)
      )`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_guest_invites_round
        ON public.secret_santa_guest_invites (round_id)`,
    `ALTER TABLE public.secret_santa_rounds
        ADD COLUMN IF NOT EXISTS exclusion_pairs jsonb DEFAULT '[]'::jsonb`,
    `ALTER TABLE public.secret_santa_round_participants
         ADD COLUMN IF NOT EXISTS wishlist_list_id uuid`,
    `ALTER TABLE public.secret_santa_round_participants
         ADD COLUMN IF NOT EXISTS wishlist_type text`,
    `ALTER TABLE public.secret_santa_round_participants
         ADD COLUMN IF NOT EXISTS wishlist_share_consent boolean DEFAULT false`,
    `ALTER TABLE public.secret_santa_round_participants
         ADD COLUMN IF NOT EXISTS wishlist_share_consented_at timestamptz`,
  ];

  for (const statement of statements) {
    await db.query(statement);
  }
  secretSantaSchemaReady = true;
};

class SecretSantaService {
  async getListAccess(listId, userId) {
    await ensureSecretSantaSchema();
    const { rows } = await db.query(
      `SELECT l.id,
              l.title,
              l.list_type,
              l.owner_id,
              l.deleted_at
         FROM lists l
        WHERE l.id = $1`,
      [listId]
    );

    if (rows.length === 0 || rows[0].deleted_at) {
      throw createHttpError(404, 'List not found');
    }

    const list = rows[0];

    if (list.list_type !== 'gifts') {
      throw createHttpError(400, 'Secret Santa is only available for gift lists');
    }

    const isOwner = String(list.owner_id) === String(userId);
    const collaboratorResult = await db.query(
      `SELECT permission
         FROM list_collaborators
        WHERE list_id = $1 AND user_id = $2`,
      [listId, userId]
    );
    const collaborator = collaboratorResult.rows[0] || null;

    const hasViewAccess = isOwner || Boolean(collaborator);
    if (!hasViewAccess) {
      throw createHttpError(403, 'You do not have access to this list');
    }

    const canManage =
      isOwner ||
      ['admin', 'edit'].includes(collaborator?.permission || '');

    return { list, canManage, isOwner };
  }

  async getRoundParticipants(roundId, viewerId = null) {
    await ensureSecretSantaSchema();
    const { rows } = await db.query(
      `SELECT rsp.user_id,
              rsp.status,
              rsp.wishlist_list_id,
              rsp.wishlist_type,
              rsp.wishlist_share_consent,
              rsp.wishlist_share_consented_at,
              u.full_name,
              u.username,
              u.email,
              u.profile_image_url,
              false AS is_owner,
              CASE WHEN rsp.user_id = $2 THEN true ELSE false END AS is_current_user,
              false AS is_co_owner
         FROM secret_santa_round_participants rsp
         JOIN users u ON u.id = rsp.user_id
        WHERE rsp.round_id = $1
          AND rsp.status <> $3
        ORDER BY u.full_name NULLS LAST, u.username ASC`,
      [roundId, viewerId, PARTICIPANT_STATUS.REMOVED]
    );
    return rows.map((row) => ({
      ...mapUserDisplay(row),
      wishlist_list_id: row.wishlist_list_id,
      wishlist_type: row.wishlist_type,
      wishlist_share_consent: row.wishlist_share_consent,
      wishlist_share_consented_at: row.wishlist_share_consented_at,
    }));
  }

  async getRoundPairings(roundId) {
    const { rows } = await db.query(
      `SELECT sp.id,
              sp.giver_user_id,
              sp.recipient_user_id,
              sp.revealed_at,
              sp.created_at,
              sp.updated_at,
              recipient.full_name AS recipient_name,
              recipient.username AS recipient_username
         FROM secret_santa_pairings sp
         JOIN users recipient ON recipient.id = sp.recipient_user_id
        WHERE sp.round_id = $1`,
      [roundId]
    );

    return rows.map((row) => ({
      id: row.id,
      roundId,
      giverUserId: row.giver_user_id,
      recipientUserId: row.recipient_user_id,
      recipientDisplayName: row.recipient_name || row.recipient_username,
      recipientAvatarUrl: null,
      recipientEmail: null,
      revealedAt: row.revealed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getCandidateParticipants(listId, viewerId = null) {
    await ensureSecretSantaSchema();
    const { rows } = await db.query(
      `WITH member_union AS (
          SELECT l.owner_id AS user_id,
                 'owner'::text AS permission,
                 true AS is_owner
            FROM lists l
           WHERE l.id = $1

          UNION ALL

          SELECT lc.user_id,
                 lc.permission,
                 false
            FROM list_collaborators lc
           WHERE lc.list_id = $1
        )
        SELECT DISTINCT ON (mu.user_id)
               mu.user_id,
               u.full_name,
               u.username,
               u.email,
               u.profile_image_url,
               mu.is_owner,
               CASE WHEN mu.permission = 'admin' THEN true ELSE false END AS is_co_owner,
               CASE WHEN mu.user_id = $2 THEN true ELSE false END AS is_current_user,
               $3::text AS status
          FROM member_union mu
          JOIN users u ON u.id = mu.user_id`,
      [listId, viewerId, PARTICIPANT_STATUS.ACCEPTED]
    );
    return rows.map(mapUserDisplay);
  }

  async getActiveRound(listId, userId) {
    await ensureSecretSantaSchema();
    const access = await this.getListAccess(listId, userId);
    const { rows } = await db.query(
      `SELECT *
         FROM secret_santa_rounds
        WHERE list_id = $1
          AND status IN ('draft','active')
        ORDER BY created_at DESC
        LIMIT 1`,
      [listId]
    );

    const round = rows[0]
      ? { ...rows[0], exclusion_pairs: rows[0].exclusion_pairs || [] }
      : null;
    let participants;
    let pairings = [];
    let viewerPairing = null;

    if (round) {
      participants = await this.getRoundParticipants(round.id, userId);
      pairings = await this.getRoundPairings(round.id);
      viewerPairing =
        pairings.find((pair) => String(pair.giverUserId) === String(userId)) ||
        null;
    } else {
      participants = await this.getCandidateParticipants(listId, userId);
    }

    return {
      round,
      participants,
      pairings,
      viewerPairing,
      metadata: { canManage: access.canManage },
    };
  }

  async ensureCanManage(roundId, userId) {
    await ensureSecretSantaSchema();
    const { rows } = await db.query(
      `SELECT r.*, l.list_type, l.owner_id
         FROM secret_santa_rounds r
         JOIN lists l ON l.id = r.list_id
        WHERE r.id = $1`,
      [roundId]
    );
    if (rows.length === 0) {
      throw createHttpError(404, 'Secret Santa round not found');
    }
    const round = rows[0];
    const access = await this.getListAccess(round.list_id, userId);
    if (!access.canManage) {
      throw createHttpError(
        403,
        'You do not have permission to manage this Secret Santa round'
      );
    }
    return { round, access };
  }

  validateParticipantIds(participantIds = []) {
    if (!Array.isArray(participantIds) || participantIds.length < 2) {
      throw createHttpError(
        400,
        'Select at least two participants'
      );
    }
  }

  async persistParticipants(round, participantIds = [], actorId = null) {
    if (!round) {
      throw createHttpError(400, 'Secret Santa round context is required');
    }
    const roundId = typeof round === 'string' ? round : round.id;
    let listId = typeof round === 'object' ? round.list_id : null;
    if (!listId) {
      const { rows } = await db.query(
        `SELECT list_id FROM secret_santa_rounds WHERE id = $1`,
        [roundId]
      );
      listId = rows[0]?.list_id || null;
    }
    if (!listId) {
      throw createHttpError(400, 'Unable to resolve list for Secret Santa round');
    }
    const normalizedParticipants = Array.from(
      new Set((participantIds || []).map((id) => String(id)))
    );

    const { rows: existingRows } = await db.query(
      `SELECT user_id, status
         FROM secret_santa_round_participants
        WHERE round_id = $1`,
      [roundId]
    );

    const existingMap = new Map(
      existingRows.map((row) => [String(row.user_id), row])
    );
    const desiredSet = new Set(normalizedParticipants);

    const removedUserIds = existingRows
      .filter(
        (row) =>
          row.status !== PARTICIPANT_STATUS.REMOVED &&
          !desiredSet.has(String(row.user_id))
      )
      .map((row) => String(row.user_id));

    if (removedUserIds.length > 0) {
      logger.info('[SecretSanta] Removing participants from round %s: %o', roundId, removedUserIds);
      await db.query(
        `UPDATE secret_santa_round_participants
            SET status = $3
          WHERE round_id = $1
            AND user_id = ANY($2::uuid[])`,
        [roundId, removedUserIds, PARTICIPANT_STATUS.REMOVED]
      );
    }

    const newUserIds = normalizedParticipants.filter((userId) => {
      const existing = existingMap.get(userId);
      return !existing || existing.status === PARTICIPANT_STATUS.REMOVED;
    });

    if (newUserIds.length > 0) {
      logger.info('[SecretSanta] Adding participants to round %s: %o', roundId, newUserIds);
      const values = [];
      const params = [];
      let paramIndex = 1;
      newUserIds.forEach((userId) => {
        values.push(
          `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`
        );
        const isActor = actorId && String(actorId) === String(userId);
        params.push(
          uuidv4(),
          roundId,
          listId,
          userId,
          isActor ? PARTICIPANT_STATUS.ACCEPTED : PARTICIPANT_STATUS.INVITED
        );
        paramIndex += 5;
      });

      await db.query(
        `INSERT INTO secret_santa_round_participants (id, round_id, list_id, user_id, status)
         VALUES ${values.join(', ')}
         ON CONFLICT (round_id, user_id)
         DO UPDATE SET status = EXCLUDED.status,
                       list_id = EXCLUDED.list_id`,
        params
      );
    }

    if (newUserIds.length > 0) {
      logger.info('[SecretSanta] Notifying participants invited: %o', newUserIds);
      await NotificationService.notifySecretSantaParticipants({
        event: 'participant_invited',
        listId,
        roundId,
        actorId,
        targetUserIds: newUserIds,
      });
    }

    if (removedUserIds.length > 0) {
      logger.info('[SecretSanta] Notifying participants removed: %o', removedUserIds);
      await NotificationService.notifySecretSantaParticipants({
        event: 'participant_removed',
        listId,
        roundId,
        actorId,
        targetUserIds: removedUserIds,
      });
    }

    if (newUserIds.length > 0 || removedUserIds.length > 0) {
      logger.info(
        '[SecretSanta] Participant change complete. added=%d removed=%d round=%s',
        newUserIds.length,
        removedUserIds.length,
        roundId
      );
      await db.query(
        `UPDATE secret_santa_rounds
            SET updated_at = NOW()
          WHERE id = $1`,
        [roundId]
      );

      const changeRecipients = normalizedParticipants
        .map((userId) => String(userId))
        .filter((userId, index, arr) => arr.indexOf(userId) === index)
        .filter((userId) => !actorId || String(userId) !== String(actorId));

      if (changeRecipients.length > 0) {
        try {
          const { rows } = await db.query(
            `SELECT to_jsonb(sr.*) AS round_data
               FROM secret_santa_rounds sr
              WHERE sr.id = $1`,
            [roundId]
          );
          const roundData = rows[0]?.round_data;

          if (roundData) {
            for (const recipientId of changeRecipients) {
              await db.query(
                `INSERT INTO change_log (table_name, record_id, operation, change_data, user_id)
                 VALUES ($1, $2, 'update', $3::jsonb, $4)`,
                ['secret_santa_rounds', roundId, roundData, recipientId]
              );
            }
          }
        } catch (error) {
          logger.warn('[SecretSanta] Failed to enqueue change_log rows for recipients %o on round %s: %s', changeRecipients, roundId, error?.message || error);
        }
      }
    }

    const affectedParticipants = [...newUserIds, ...removedUserIds];
    if (affectedParticipants.length > 0) {
      await this.enqueueParticipantChangeLogs({
        roundId,
        listId,
        participantUserIds: affectedParticipants,
        actorId,
      });
    }

    if (normalizedParticipants.length > 0) {
      await this.pruneExclusionsForRound(roundId, normalizedParticipants);
    }
  }

  async ensureParticipantsExist(participantIds = []) {
    if (!participantIds.length) {
      throw createHttpError(400, 'Select at least two participants');
    }
    const { rows } = await db.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [participantIds]
    );
    if (rows.length !== participantIds.length) {
      throw createHttpError(
        400,
        'One or more participants are not valid Rekkoo users'
      );
    }
  }

  async ensureParticipantsHaveAccess(listId, ownerId, participantIds = []) {
    const ownerString = ownerId ? String(ownerId) : null;
    const candidates = participantIds.filter(
      (id) => !ownerString || id !== ownerString
    );
    if (!candidates.length) {
      return;
    }

    const { rows } = await db.query(
      `SELECT user_id
         FROM list_collaborators
        WHERE list_id = $1
          AND user_id = ANY($2::uuid[])`,
      [listId, candidates]
    );
    const existing = new Set(rows.map((row) => String(row.user_id)));
    const missing = candidates.filter((id) => !existing.has(id));

    if (!missing.length) {
      return;
    }

    const values = [];
    const params = [];
    missing.forEach((userId, index) => {
      values.push(
        `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`
      );
      params.push(uuidv4(), listId, ownerId, userId, 'view');
    });

    await db.query(
      `INSERT INTO list_collaborators (id, list_id, owner_id, user_id, permission)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  async pruneExclusionsForRound(roundId, allowedParticipantIds = []) {
    if (!roundId) return [];
    let allowed = allowedParticipantIds && allowedParticipantIds.length ? allowedParticipantIds : [];
    if (!allowed.length) {
      const { rows } = await db.query(
        `SELECT user_id
           FROM secret_santa_round_participants
          WHERE round_id = $1
            AND status <> $2`,
        [roundId, PARTICIPANT_STATUS.REMOVED]
      );
      allowed = rows.map((row) => String(row.user_id));
    }

    const { rows: exclusionRows } = await db.query(
      `SELECT exclusion_pairs
         FROM secret_santa_rounds
        WHERE id = $1`,
      [roundId]
    );

    const normalizedCurrent = normalizeExclusionPairs(exclusionRows[0]?.exclusion_pairs || [], allowed);
    const storedNormalized = normalizeExclusionPairs(exclusionRows[0]?.exclusion_pairs || []);

    if (!areExclusionsEqual(normalizedCurrent, storedNormalized)) {
      await db.query(
        `UPDATE secret_santa_rounds
            SET exclusion_pairs = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [roundId, JSON.stringify(normalizedCurrent)]
      );
    }

    return normalizedCurrent;
  }

  async createRound(listId, userId, payload = {}) {
    await ensureSecretSantaSchema();
    const access = await this.getListAccess(listId, userId);
    if (!access.canManage) {
      throw createHttpError(
        403,
        'Only list owners or admins can start a Secret Santa round'
      );
    }

    const existingRound = await db.query(
      `SELECT id
         FROM secret_santa_rounds
        WHERE list_id = $1
          AND status IN ('draft','active')
        LIMIT 1`,
      [listId]
    );
    if (existingRound.rows.length > 0) {
      throw createHttpError(
        409,
        'A Secret Santa round already exists for this list'
      );
    }

    const participantIds = (payload.participantIds || []).map(String);
    this.validateParticipantIds(participantIds);
    await this.ensureParticipantsExist(participantIds);
    await this.ensureParticipantsHaveAccess(
      listId,
      access.list.owner_id,
      participantIds
    );
    const exclusions = normalizeExclusionPairs(payload.exclusions, participantIds);

    const roundId = payload.id || uuidv4();
    await db.query(
      `INSERT INTO secret_santa_rounds
         (id, list_id, status, budget_cents, currency, exchange_date, signup_cutoff_date, note, message, exclusion_pairs, auto_draw_enabled, notify_via_push, notify_via_email, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        roundId,
        listId,
        payload.budgetCents || null,
        sanitizeCurrency(payload.currency),
        payload.exchangeDate || null,
        payload.signupCutoffDate || null,
        payload.note || null,
        payload.message || null,
        JSON.stringify(exclusions),
        payload.autoDrawEnabled ?? false,
        payload.notifyViaPush ?? true,
        payload.notifyViaEmail ?? false,
        userId,
      ]
    );

    await this.persistParticipants(
      { id: roundId, list_id: listId },
      participantIds,
      userId
    );
    logger.info(`[SecretSanta] Round ${roundId} created for list ${listId}`);

    return this.getActiveRound(listId, userId);
  }

  async updateRound(roundId, userId, payload = {}) {
    await ensureSecretSantaSchema();
    const { round, access } = await this.ensureCanManage(roundId, userId);

    const updates = [];
    const params = [];
    let idx = 1;
    let participantIdsForExclusions = null;
    let participantIdsChanged = false;

    const fields = {
      budget_cents: payload.budgetCents,
      currency: payload.currency ? sanitizeCurrency(payload.currency) : undefined,
      exchange_date: payload.exchangeDate,
      note: payload.note,
      message: payload.message,
      status: payload.status,
      signup_cutoff_date: payload.signupCutoffDate,
      auto_draw_enabled:
        payload.autoDrawEnabled === undefined ? undefined : Boolean(payload.autoDrawEnabled),
      notify_via_push:
        payload.notifyViaPush === undefined ? undefined : Boolean(payload.notifyViaPush),
      notify_via_email:
        payload.notifyViaEmail === undefined ? undefined : Boolean(payload.notifyViaEmail),
    };

    Object.entries(fields).forEach(([column, value]) => {
      if (value !== undefined) {
        updates.push(`${column} = $${idx}`);
        params.push(value);
        idx += 1;
      }
    });

    if (Array.isArray(payload.participantIds)) {
      participantIdsChanged = true;
      this.validateParticipantIds(payload.participantIds);
      const normalized = payload.participantIds.map(String);
      participantIdsForExclusions = normalized;
      await this.ensureParticipantsExist(normalized);
      await this.ensureParticipantsHaveAccess(
        round.list_id,
        access.list.owner_id,
        normalized
      );
      await this.persistParticipants(round, normalized, userId);
    }

    if (!participantIdsForExclusions) {
      const { rows } = await db.query(
        `SELECT user_id
           FROM secret_santa_round_participants
          WHERE round_id = $1
            AND status <> $2`,
        [roundId, PARTICIPANT_STATUS.REMOVED]
      );
      participantIdsForExclusions = rows.map((row) => String(row.user_id));
    }

    const nextExclusions = normalizeExclusionPairs(
      payload.exclusions !== undefined ? payload.exclusions : round.exclusion_pairs || [],
      participantIdsForExclusions
    );
    const currentNormalized = normalizeExclusionPairs(
      round.exclusion_pairs || [],
      participantIdsForExclusions
    );
    const shouldUpdateExclusions =
      payload.exclusions !== undefined || participantIdsChanged || !areExclusionsEqual(currentNormalized, nextExclusions);

    if (shouldUpdateExclusions) {
      updates.push(`exclusion_pairs = $${idx}`);
      params.push(JSON.stringify(nextExclusions));
      idx += 1;
    }

    if (updates.length > 0 || participantIdsChanged) {
      updates.push('updated_at = NOW()');
      await db.query(
        `UPDATE secret_santa_rounds SET ${updates.join(', ')}
          WHERE id = $${idx}`,
        [...params, roundId]
      );
    }

    return this.getActiveRound(round.list_id, userId);
  }

  generatePairings(participantIds, exclusions = []) {
    if (participantIds.length < 2) {
      throw createHttpError(
        400,
        'Need at least two participants to publish assignments'
      );
    }

    const shuffled = [...participantIds.map(String)];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const forbidden = new Set();
    normalizeExclusionPairs(exclusions, participantIds).forEach((pair) => {
      forbidden.add(`${pair.user_id}__${pair.excluded_user_id}`);
      forbidden.add(`${pair.excluded_user_id}__${pair.user_id}`);
    });

    const pairings = [];
    const usedRecipients = new Set();

    const backtrack = (index) => {
      if (index >= shuffled.length) {
        return true;
      }
      const giver = shuffled[index];
      const candidates = shuffled.filter(
        (candidate) =>
          !usedRecipients.has(candidate) &&
          candidate !== giver &&
          !forbidden.has(`${giver}__${candidate}`)
      );

      for (let cIdx = 0; cIdx < candidates.length; cIdx += 1) {
        const recipient = candidates[cIdx];
        usedRecipients.add(recipient);
        pairings.push({ giver, recipient });
        if (backtrack(index + 1)) {
          return true;
        }
        usedRecipients.delete(recipient);
        pairings.pop();
      }
      return false;
    };

    const success = backtrack(0);
    if (!success) {
      throw createHttpError(
        400,
        'Unable to create Secret Santa assignments with the current exclusions. Try removing an exclusion or adding participants.'
      );
    }

    return pairings;
  }

  async publishRound(roundId, userId) {
    await ensureSecretSantaSchema();
    const { round } = await this.ensureCanManage(roundId, userId);
    const participantRows = await db.query(
      `SELECT user_id
         FROM secret_santa_round_participants
        WHERE round_id = $1
          AND status = $2`,
      [roundId, PARTICIPANT_STATUS.ACCEPTED]
    );
    const participantIds = participantRows.rows.map((row) => String(row.user_id));
    this.validateParticipantIds(participantIds);

    const exclusions = normalizeExclusionPairs(round.exclusion_pairs || [], participantIds);
    const pairings = this.generatePairings(participantIds, exclusions);

    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM secret_santa_pairings WHERE round_id = $1', [
        roundId,
      ]);

      const inserts = [];
      const params = [];
      pairings.forEach((pair, idx) => {
        inserts.push(
          `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`
        );
        params.push(uuidv4(), roundId, pair.giver, pair.recipient);
      });

      await db.query(
        `INSERT INTO secret_santa_pairings
           (id, round_id, giver_user_id, recipient_user_id)
         VALUES ${inserts.join(', ')}`,
        params
      );

      await db.query(
        `UPDATE secret_santa_rounds
            SET status = 'active',
                published_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [roundId]
      );

      await db.query('COMMIT');
      logger.info(`[SecretSanta] Round ${roundId} published`);
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }

    return this.getActiveRound(round.list_id, userId);
  }

  async respondToParticipantInvite(roundId, userId, payload = {}) {
    await ensureSecretSantaSchema();
    const normalizedDecision = (payload.decision || '').toLowerCase();
    if (!['accept', 'decline'].includes(normalizedDecision)) {
      throw createHttpError(400, 'Specify accept or decline');
    }
    const wishlistListId =
      payload.wishlistListId ||
      payload.wishlist_list_id ||
      payload.wishlistListID ||
      null;
    const wishlistType = payload.wishlistType || payload.wishlist_type || null;
    const wishlistShareConsent = Boolean(payload.wishlistShareConsent ?? payload.wishlist_share_consent);

    const { rows } = await db.query(
      `SELECT rsp.id,
              rsp.status,
              rsp.user_id,
              rsp.round_id,
              rsp.wishlist_list_id,
              rsp.wishlist_type,
              rsp.wishlist_share_consent,
              rsp.wishlist_share_consented_at,
              COALESCE(rsp.list_id, r.list_id) AS list_id
         FROM secret_santa_round_participants rsp
         JOIN secret_santa_rounds r ON r.id = rsp.round_id
        WHERE rsp.round_id = $1
          AND rsp.user_id = $2`,
      [roundId, userId]
    );
    if (rows.length === 0) {
      throw createHttpError(404, 'Secret Santa invite not found');
    }

    const participant = rows[0];
    if (participant.status === PARTICIPANT_STATUS.REMOVED) {
      throw createHttpError(410, 'You are no longer part of this Secret Santa round');
    }

    const nextStatus =
      normalizedDecision === 'accept'
        ? PARTICIPANT_STATUS.ACCEPTED
        : PARTICIPANT_STATUS.DECLINED;

    let wishlistColumns = {};
    if (normalizedDecision === 'accept' && wishlistListId) {
      const { rows: listRows } = await db.query(
        `SELECT id, owner_id
           FROM lists
          WHERE id = $1
            AND owner_id = $2`,
        [wishlistListId, userId]
      );
      if (listRows.length === 0) {
        throw createHttpError(400, 'Wishlist list not found or not owned by participant');
      }
      wishlistColumns = {
        wishlist_list_id: wishlistListId,
        wishlist_type: wishlistType || 'linked_list',
        wishlist_share_consent: wishlistShareConsent,
        wishlist_share_consented_at: wishlistShareConsent ? new Date() : null,
      };
    } else {
      wishlistColumns = {
        wishlist_list_id: null,
        wishlist_type: null,
        wishlist_share_consent: false,
        wishlist_share_consented_at: null,
      };
    }

    if (participant.status !== nextStatus || wishlistListId !== participant.wishlist_list_id || wishlistShareConsent !== participant.wishlist_share_consent) {
      const updateFields = [
        'status = $3',
        'wishlist_list_id = $4',
        'wishlist_type = $5',
        'wishlist_share_consent = $6',
        'wishlist_share_consented_at = $7',
      ];
      await db.query(
        `UPDATE secret_santa_round_participants
            SET ${updateFields.join(', ')},
                updated_at = NOW()
          WHERE round_id = $1
            AND user_id = $2`,
        [
          roundId,
          userId,
          nextStatus,
          wishlistColumns.wishlist_list_id,
          wishlistColumns.wishlist_type,
          wishlistColumns.wishlist_share_consent,
          wishlistColumns.wishlist_share_consented_at,
        ]
      );

      await NotificationService.notifySecretSantaParticipants({
        event:
          nextStatus === PARTICIPANT_STATUS.ACCEPTED
            ? 'participant_accepted'
            : 'participant_declined',
        listId: participant.list_id,
        roundId,
        actorId: userId,
        targetUserIds: [userId],
      });

      await this.enqueueParticipantChangeLogs({
        roundId,
        listId: participant.list_id,
        participantUserIds: [userId],
        actorId: userId,
      });
    }

    return this.getActiveRound(participant.list_id, userId);
  }

  async removeParticipant(roundId, actorId, participantId) {
    await ensureSecretSantaSchema();
    const { round } = await this.ensureCanManage(roundId, actorId);
    const targetId = String(participantId);
    const { rowCount } = await db.query(
      `UPDATE secret_santa_round_participants
          SET status = $3
        WHERE round_id = $1
          AND user_id = $2
          AND status <> $3`,
      [roundId, targetId, PARTICIPANT_STATUS.REMOVED]
    );

    if (rowCount === 0) {
      const { rows } = await db.query(
        `SELECT status
           FROM secret_santa_round_participants
          WHERE round_id = $1
            AND user_id = $2`,
        [roundId, targetId]
      );
      if (rows.length === 0) {
        throw createHttpError(404, 'Participant not found in this round');
      }
      if (rows[0].status !== PARTICIPANT_STATUS.REMOVED) {
        throw createHttpError(409, 'Unable to remove participant');
      }
    }

    await NotificationService.notifySecretSantaParticipants({
      event: 'participant_removed',
      listId: round.list_id,
      roundId,
      actorId,
      targetUserIds: [targetId],
    });

    await this.enqueueParticipantChangeLogs({
      roundId,
      listId: round.list_id,
      participantUserIds: [targetId],
      actorId,
    });

    await this.pruneExclusionsForRound(round.id);

    return this.getActiveRound(round.list_id, actorId);
  }

  async inviteGuests(listId, userId, payload = {}) {
    await ensureSecretSantaSchema();
    const access = await this.getListAccess(listId, userId);
    if (!access.canManage) {
      throw createHttpError(
        403,
        'Only list admins can invite guests to Secret Santa'
      );
    }

    const emails = (payload.emails || [])
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean);

    if (emails.length === 0) {
      return { invitationIds: [] };
    }

    const roundResult = await db.query(
      `SELECT id
         FROM secret_santa_rounds
        WHERE list_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [listId]
    );

    if (roundResult.rows.length === 0) {
      throw createHttpError(404, 'Create a Secret Santa round before inviting guests');
    }

    const roundId = roundResult.rows[0].id;
    const insertedIds = [];
    for (const email of emails) {
      try {
        const { rows } = await db.query(
          `INSERT INTO secret_santa_guest_invites (round_id, email, message)
             VALUES ($1,$2,$3)
             ON CONFLICT (round_id, email)
             DO UPDATE SET message = EXCLUDED.message, updated_at = NOW()
             RETURNING id`,
          [roundId, email, payload.message || null]
        );
        insertedIds.push(rows[0].id);
      } catch (error) {
        logger.warn(`[SecretSanta] Failed to store invite for ${email}`, error);
      }
    }

    return { invitationIds: insertedIds };
  }

  async getListManagerIds(listId) {
    if (!listId) {
      return [];
    }
    const { rows } = await db.query(
      `WITH manager_ids AS (
         SELECT owner_id AS user_id
           FROM lists
          WHERE id = $1
         UNION
         SELECT lc.user_id
           FROM list_collaborators lc
          WHERE lc.list_id = $1
            AND lc.permission IN ('admin','edit')
       )
       SELECT DISTINCT user_id FROM manager_ids`,
      [listId]
    );
    return rows.map((row) => String(row.user_id));
  }

  async enqueueParticipantChangeLogs({
    roundId,
    listId = null,
    participantUserIds = [],
    actorId = null,
  }) {
    if (!roundId || !Array.isArray(participantUserIds) || participantUserIds.length === 0) {
      return;
    }

    const normalizedParticipants = Array.from(
      new Set(participantUserIds.map((id) => String(id)).filter(Boolean))
    );
    if (!normalizedParticipants.length) {
      return;
    }

    const { rows } = await db.query(
      `SELECT rsp.*,
              COALESCE(rsp.list_id, sr.list_id) AS resolved_list_id
         FROM secret_santa_round_participants rsp
         JOIN secret_santa_rounds sr ON sr.id = rsp.round_id
        WHERE rsp.round_id = $1
          AND rsp.user_id = ANY($2::uuid[])`,
      [roundId, normalizedParticipants]
    );

    if (!rows.length) {
      return;
    }

    const resolvedListId = listId || rows[0].resolved_list_id;
    const managerIds = await this.getListManagerIds(resolvedListId);

    const recipientSet = new Set(managerIds);
    rows.forEach((row) => recipientSet.add(String(row.user_id)));
    if (actorId) {
      recipientSet.add(String(actorId));
    }

    const recipients = Array.from(recipientSet).filter(Boolean);
    if (!recipients.length) {
      return;
    }

    const values = [];
    const params = [];
    let paramIndex = 1;

    rows.forEach((row) => {
      const payload = JSON.stringify({
        ...row,
        list_id: resolvedListId,
      });
      recipients.forEach((userId) => {
        values.push(
          `('secret_santa_round_participants', $${paramIndex}, 'update', $${paramIndex + 1}::jsonb, $${paramIndex + 2})`
        );
        params.push(row.id, payload, userId);
        paramIndex += 3;
      });
    });

    if (!values.length) {
      return;
    }

    try {
      await db.query(
        `INSERT INTO change_log (table_name, record_id, operation, change_data, user_id)
         VALUES ${values.join(', ')}`,
        params
      );
    } catch (error) {
      logger.warn(
        '[SecretSanta] Failed to enqueue participant change_log entries for round %s: %s',
        roundId,
        error?.message || error
      );
    }
  }
}

module.exports = new SecretSantaService();
