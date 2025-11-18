const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { logger } = require('../utils/logger');

const createHttpError = (status, message) => {
  const error = new Error(message);
  error.statusCode = status;
  return error;
};

const sanitizeCurrency = (currency) => {
  if (!currency) return 'USD';
  return currency.toUpperCase().slice(0, 8);
};

const mapUserDisplay = (row) => ({
  userId: row.user_id,
  displayName: row.full_name || row.username,
  email: row.email || null,
  avatarUrl: row.profile_image_url || null,
  status: row.status || 'confirmed',
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
        exchange_date date,
        note text,
        message text,
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
        user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'confirmed',
        created_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (round_id, user_id)
      )`,
    `CREATE INDEX IF NOT EXISTS idx_secret_santa_participants_round
        ON public.secret_santa_round_participants (round_id)`,
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
        ORDER BY u.full_name NULLS LAST, u.username ASC`,
      [roundId, viewerId]
    );
    return rows.map(mapUserDisplay);
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
               'confirmed' AS status
          FROM member_union mu
          JOIN users u ON u.id = mu.user_id`,
      [listId, viewerId]
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

    const round = rows[0] || null;
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
        'Select at least two confirmed participants'
      );
    }
  }

  async persistParticipants(roundId, participantIds) {
    await db.query(
      'DELETE FROM secret_santa_round_participants WHERE round_id = $1',
      [roundId]
    );
    const inserts = [];
    const params = [];
    participantIds.forEach((participantId, idx) => {
      inserts.push(
        `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`
      );
      params.push(uuidv4(), roundId, participantId, 'confirmed');
    });
    await db.query(
      `INSERT INTO secret_santa_round_participants (id, round_id, user_id, status)
       VALUES ${inserts.join(', ')}`,
      params
    );
  }

  async ensureParticipantsExist(participantIds = []) {
    if (!participantIds.length) {
      throw createHttpError(400, 'Select at least two confirmed participants');
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

    const roundId = payload.id || uuidv4();
    await db.query(
      `INSERT INTO secret_santa_rounds
         (id, list_id, status, budget_cents, currency, exchange_date, note, message, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8)`,
      [
        roundId,
        listId,
        payload.budgetCents || null,
        sanitizeCurrency(payload.currency),
        payload.exchangeDate || null,
        payload.note || null,
        payload.message || null,
        userId,
      ]
    );

    await this.persistParticipants(roundId, participantIds);
    logger.info(`[SecretSanta] Round ${roundId} created for list ${listId}`);

    return this.getActiveRound(listId, userId);
  }

  async updateRound(roundId, userId, payload = {}) {
    await ensureSecretSantaSchema();
    const { round, access } = await this.ensureCanManage(roundId, userId);

    const updates = [];
    const params = [];
    let idx = 1;

    const fields = {
      budget_cents: payload.budgetCents,
      currency: payload.currency ? sanitizeCurrency(payload.currency) : undefined,
      exchange_date: payload.exchangeDate,
      note: payload.note,
      message: payload.message,
      status: payload.status,
    };

    Object.entries(fields).forEach(([column, value]) => {
      if (value !== undefined) {
        updates.push(`${column} = $${idx}`);
        params.push(value);
        idx += 1;
      }
    });

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      await db.query(
        `UPDATE secret_santa_rounds SET ${updates.join(', ')}
          WHERE id = $${idx}`,
        [...params, roundId]
      );
    }

    if (Array.isArray(payload.participantIds)) {
      this.validateParticipantIds(payload.participantIds);
      const normalized = payload.participantIds.map(String);
      await this.ensureParticipantsExist(normalized);
      await this.ensureParticipantsHaveAccess(
        round.list_id,
        access.list.owner_id,
        normalized
      );
      await this.persistParticipants(roundId, normalized);
    }

    return this.getActiveRound(round.list_id, userId);
  }

  generatePairings(participantIds) {
    if (participantIds.length < 2) {
      throw createHttpError(
        400,
        'Need at least two participants to publish assignments'
      );
    }

    const shuffled = [...participantIds];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const pairings = [];
    for (let idx = 0; idx < shuffled.length; idx += 1) {
      const giver = shuffled[idx];
      const recipient = shuffled[(idx + 1) % shuffled.length];
      if (giver === recipient) {
        return this.generatePairings(participantIds);
      }
      pairings.push({ giver, recipient });
    }
    return pairings;
  }

  async publishRound(roundId, userId) {
    await ensureSecretSantaSchema();
    const { round } = await this.ensureCanManage(roundId, userId);
    const participantRows = await db.query(
      `SELECT user_id
         FROM secret_santa_round_participants
        WHERE round_id = $1`,
      [roundId]
    );
    const participantIds = participantRows.rows.map((row) => String(row.user_id));
    this.validateParticipantIds(participantIds);

    const pairings = this.generatePairings(participantIds);

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
}

module.exports = new SecretSantaService();
