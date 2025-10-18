const db = require('../config/db');
const GroupAccessService = require('../services/groupAccessService');
const NotificationService = require('../services/NotificationService');

const ACTIVE_GROUP_STATUSES = new Set(['open', 'locked']);
const LOCKABLE_STATUSES = new Set(['open', 'locked']);
const TERMINAL_GROUP_STATUSES = new Set(['completed', 'abandoned']);
const ACTIVE_CONTRIBUTION_STATUSES = new Set(['pledged', 'fulfilled']);

const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error('Value must be a number'), { status: 400 });
  }
  const intValue = Math.floor(parsed);
  return intValue;
};

const ensurePositiveInt = (value, fieldName, { allowZero = false } = {}) => {
  const parsed = toIntOrNull(value);
  if (parsed === null) return null;
  if (allowZero ? parsed < 0 : parsed <= 0) {
    throw Object.assign(new Error(`${fieldName} must be ${allowZero ? 'zero or greater' : 'greater than zero'}`), { status: 400 });
  }
  return parsed;
};

const sanitizeCurrencyCode = (code) => {
  if (!code) return null;
  const upper = String(code).trim().toUpperCase();
  if (upper.length !== 3) {
    throw Object.assign(new Error('currency must be a 3-letter ISO code'), { status: 400 });
  }
  return upper;
};

const runQuery = (client, text, params = []) => {
  if (client) {
    return client.query(text, params);
  }
  return db.query(text, params);
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

const mapContributor = (row) => {
  if (!row.contributor_id) {
    return null;
  }
  return {
    id: row.contributor_id,
    displayName: row.full_name || null,
    username: row.username || null,
    avatarUrl: row.avatar_url || null,
  };
};

const mapContributionRow = (row) => ({
  id: row.id,
  groupId: row.group_id,
  itemId: row.item_id,
  listId: row.list_id,
  contributorId: row.contributor_id,
  amountCents: row.contribution_cents,
  quantity: row.contribution_quantity,
  status: row.status,
  note: row.note,
  isExternal: row.is_external,
  externalContributorName: row.external_contributor_name,
  fulfilledAt: row.fulfilled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  contributor: mapContributor(row),
});

const fetchItemContext = async (client, itemId) => {
  const { rows } = await runQuery(
    client,
    `
      SELECT 
        li.id,
        li.list_id,
        li.title AS item_title,
        l.owner_id,
        l.title AS list_title
      FROM list_items li
      JOIN lists l ON li.list_id = l.id
      WHERE li.id = $1
        AND li.deleted_at IS NULL
        AND l.deleted_at IS NULL
      LIMIT 1
    `,
    [itemId]
  );

  if (rows.length === 0) {
    throw httpError(404, 'Item not found');
  }

  return rows[0];
};

const fetchActiveGroupForItem = async (client, itemId, { forUpdate = false } = {}) => {
  const lock = forUpdate ? 'FOR UPDATE' : '';
  const { rows } = await runQuery(
    client,
    `
      SELECT *
      FROM gift_purchase_groups
      WHERE item_id = $1
        AND deleted_at IS NULL
        AND status IN ('open', 'locked')
      ORDER BY created_at DESC
      LIMIT 1
      ${lock}
    `,
    [itemId]
  );
  return rows[0] || null;
};

const fetchGroupById = async (client, groupId, { forUpdate = false } = {}) => {
  const lock = forUpdate ? 'FOR UPDATE' : '';
  const { rows } = await runQuery(
    client,
    `
      SELECT *
      FROM gift_purchase_groups
      WHERE id = $1
        AND deleted_at IS NULL
      LIMIT 1
      ${lock}
    `,
    [groupId]
  );
  return rows[0] || null;
};

const hydrateGroup = async (client, groupRow, viewerId) => {
  if (!groupRow) return null;

  const { rows: contributionRows } = await runQuery(
    client,
    `
      SELECT 
        gc.*,
        u.username,
        u.full_name,
        u.profile_image_url AS avatar_url
      FROM gift_contributions gc
      LEFT JOIN users u ON gc.contributor_id = u.id
      WHERE gc.group_id = $1
        AND gc.deleted_at IS NULL
      ORDER BY gc.created_at ASC
    `,
    [groupRow.id]
  );

  const contributions = contributionRows.map(mapContributionRow);
  const activeContributions = contributions.filter((contribution) =>
    ACTIVE_CONTRIBUTION_STATUSES.has(contribution.status)
  );
  const contributedCents = activeContributions.reduce(
    (sum, contribution) => sum + (contribution.amountCents || 0),
    0
  );
  const contributedQuantity = activeContributions.reduce(
    (sum, contribution) => sum + (contribution.quantity || 0),
    0
  );

  const remainingCents =
    groupRow.target_cents == null
      ? null
      : Math.max(groupRow.target_cents - contributedCents, 0);

  const remainingQuantity =
    !groupRow.is_quantity_based || groupRow.target_quantity == null
      ? null
      : Math.max(groupRow.target_quantity - contributedQuantity, 0);

  const viewerContribution =
    viewerId == null
      ? null
      : contributions.find(
          (contribution) =>
            contribution.contributorId &&
            String(contribution.contributorId) === String(viewerId)
        ) || null;

  return {
    id: groupRow.id,
    itemId: groupRow.item_id,
    listId: groupRow.list_id,
    status: groupRow.status,
    targetCents: groupRow.target_cents,
    targetQuantity: groupRow.target_quantity,
    currency: groupRow.currency_code,
    isQuantityBased: groupRow.is_quantity_based,
    notes: groupRow.notes,
    createdBy: groupRow.created_by,
    createdAt: groupRow.created_at,
    updatedAt: groupRow.updated_at,
    lockedAt: groupRow.locked_at,
    completedAt: groupRow.completed_at,
    abandonedAt: groupRow.abandoned_at,
    reminderScheduledAt: groupRow.reminder_scheduled_at,
    contributedCents,
    contributedQuantity,
    remainingCents,
    remainingQuantity,
    contributions,
    viewerContribution,
  };
};

const ensureCollaboratorAccess = async (item, userId) => {
  if (String(item.owner_id) === String(userId)) {
    throw httpError(403, 'List owners cannot start a shared purchase');
  }

  const access = await GroupAccessService.checkGroupAccess(userId, item.list_id);
  if (!access.hasAccess || access.accessType === 'no_access' || access.accessType === 'error') {
    throw httpError(403, 'You do not have permission to create a shared purchase for this item');
  }
};

const ensureParticipationAccess = async (item, userId) => {
  if (String(item.owner_id) === String(userId)) {
    throw httpError(403, 'List owners cannot participate in shared purchases');
  }
  const access = await GroupAccessService.checkGroupAccess(userId, item.list_id);
  if (!access.hasAccess || access.accessType === 'no_access' || access.accessType === 'error') {
    throw httpError(403, 'You do not have permission to contribute to this gift');
  }
};

const recalcGroupStatus = async (client, groupId) => {
  const groupRow = await fetchGroupById(client, groupId, { forUpdate: true });
  if (!groupRow) {
    throw httpError(404, 'Shared purchase group not found');
  }

  if (TERMINAL_GROUP_STATUSES.has(groupRow.status)) {
    return groupRow;
  }

  const { rows } = await runQuery(
    client,
    `
      SELECT contribution_cents, contribution_quantity, status
      FROM gift_contributions
      WHERE group_id = $1
        AND deleted_at IS NULL
    `,
    [groupId]
  );

  const active = rows.filter((row) => ACTIVE_CONTRIBUTION_STATUSES.has(row.status));
  const totalCents = active.reduce(
    (sum, row) => sum + (row.contribution_cents || 0),
    0
  );
  const totalQuantity = active.reduce(
    (sum, row) => sum + (row.contribution_quantity || 0),
    0
  );

  const meetsCurrencyGoal =
    groupRow.target_cents != null && totalCents >= groupRow.target_cents;
  const meetsQuantityGoal =
    groupRow.is_quantity_based &&
    groupRow.target_quantity != null &&
    totalQuantity >= groupRow.target_quantity;

  let nextStatus = groupRow.status;
  let lockedAt = groupRow.locked_at;

  if (meetsCurrencyGoal || meetsQuantityGoal) {
    if (groupRow.status !== 'locked') {
      nextStatus = 'locked';
      lockedAt = groupRow.locked_at || new Date();
    }
  } else if (LOCKABLE_STATUSES.has(groupRow.status)) {
    nextStatus = 'open';
    lockedAt = null;
  }

  if (nextStatus !== groupRow.status || lockedAt !== groupRow.locked_at) {
    const { rows: updated } = await runQuery(
      client,
      `
        UPDATE gift_purchase_groups
           SET status = $2,
               locked_at = $3,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *
      `,
      [groupId, nextStatus, lockedAt]
    );
    return updated[0];
  }

  return groupRow;
};

const emitSharedPurchaseEvent = (listId, excludeUserId, data) =>
  NotificationService.notifyGroupMembers({
    listId,
    excludeUserId,
    type: 'shared_purchase_update',
    data,
  });

const SharedPurchaseController = {
  getSharedPurchase: async (req, res) => {
    const { itemId } = req.params;
    try {
      await fetchItemContext(null, itemId); // Ensure item exists
      let groupRow = await fetchActiveGroupForItem(null, itemId);
      if (!groupRow) {
        const { rows } = await db.query(
          `
            SELECT *
            FROM gift_purchase_groups
            WHERE item_id = $1
              AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [itemId]
        );
        groupRow = rows[0] || null;
      }
      if (!groupRow) {
        return res.status(404).json({ error: 'Shared purchase not found' });
      }
      const group = await hydrateGroup(null, groupRow, req.user.id);
      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] getSharedPurchase error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  createSharedPurchase: async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.id;

    try {
      const item = await fetchItemContext(null, itemId);
      await ensureCollaboratorAccess(item, userId);

      const payload = req.body || {};
      const isQuantityBased = Boolean(payload.isQuantityBased);
      const targetQuantity = ensurePositiveInt(
        payload.targetQuantity != null ? payload.targetQuantity : 1,
        'targetQuantity'
      ) || 1;
      const targetCents = ensurePositiveInt(payload.targetCents, 'targetCents');
      const currency = sanitizeCurrencyCode(payload.currency);
      const notes = payload.notes ? String(payload.notes).trim() : null;

      if (!isQuantityBased && targetCents === null) {
        throw httpError(400, 'targetCents is required when not quantity based');
      }
      if (!isQuantityBased && !currency) {
        throw httpError(400, 'currency is required when not quantity based');
      }

      const group = await db.transaction(async (client) => {
        const existing = await fetchActiveGroupForItem(client, itemId, { forUpdate: true });
        if (existing) {
          throw httpError(409, 'An active shared purchase already exists for this item');
        }

        const { rows } = await client.query(
          `
            INSERT INTO gift_purchase_groups (
              item_id,
              list_id,
              created_by,
              target_cents,
              target_quantity,
              currency_code,
              status,
              is_quantity_based,
              notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
            RETURNING *
          `,
          [
            item.id,
            item.list_id,
            userId,
            targetCents,
            targetQuantity,
            currency,
            isQuantityBased,
            notes,
          ]
        );

        return hydrateGroup(client, rows[0], userId);
      });

      await emitSharedPurchaseEvent(item.list_id, userId, {
        action: 'group_created',
        item_id: item.id,
        item_title: item.item_title,
        list_id: item.list_id,
        list_title: item.list_title,
        actor_id: userId,
        group,
      });

      return res.status(201).json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] createSharedPurchase error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  upsertContribution: async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.id;

    try {
      const item = await fetchItemContext(null, itemId);
      await ensureParticipationAccess(item, userId);

      const payload = req.body || {};
      const amountCents = ensurePositiveInt(payload.amountCents, 'amountCents', { allowZero: false });
      const markFulfilled = Boolean(payload.markFulfilled);
      const note = payload.note ? String(payload.note).trim() : null;

      const group = await db.transaction(async (client) => {
        const groupRow = await fetchActiveGroupForItem(client, itemId, { forUpdate: true });
        if (!groupRow) {
          throw httpError(404, 'Shared purchase not found');
        }

        if (TERMINAL_GROUP_STATUSES.has(groupRow.status)) {
          throw httpError(409, 'Shared purchase is no longer accepting contributions');
        }

        if (groupRow.status === 'locked' && String(item.owner_id) !== String(userId)) {
          throw httpError(409, 'Shared purchase is locked pending completion');
        }

        const contributionQuantity = groupRow.is_quantity_based
          ? ensurePositiveInt(payload.quantity, 'quantity', { allowZero: false }) || 0
          : 0;

        if (!groupRow.is_quantity_based && amountCents === null) {
          throw httpError(400, 'amountCents is required for monetary contributions');
        }
        if (groupRow.is_quantity_based && contributionQuantity === 0 && amountCents === null) {
          throw httpError(400, 'quantity is required for quantity-based contributions');
        }

        const status = markFulfilled ? 'fulfilled' : 'pledged';

        const { rows: existing } = await client.query(
          `
            SELECT *
            FROM gift_contributions
            WHERE group_id = $1
              AND contributor_id = $2
              AND deleted_at IS NULL
            LIMIT 1
            FOR UPDATE
          `,
          [groupRow.id, userId]
        );

        if (existing.length > 0) {
          await client.query(
            `
              UPDATE gift_contributions
                 SET contribution_cents = $1,
                     contribution_quantity = $2,
                 status = $3,
                 note = $4,
                 is_external = FALSE,
                 external_contributor_name = NULL,
                 fulfilled_at = CASE WHEN $3 = 'fulfilled'::contribution_status THEN CURRENT_TIMESTAMP ELSE NULL END,
                 updated_at = CURRENT_TIMESTAMP,
                 deleted_at = NULL
           WHERE id = $5
            `,
            [
              amountCents,
              contributionQuantity,
              status,
              note,
              existing[0].id,
            ]
          );
        } else {
          await client.query(
            `
              INSERT INTO gift_contributions (
                group_id,
                item_id,
                list_id,
                contributor_id,
                contribution_cents,
                contribution_quantity,
                status,
                note,
                is_external,
                external_contributor_name,
                fulfilled_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, FALSE, NULL,
                CASE WHEN $7 = 'fulfilled'::contribution_status THEN CURRENT_TIMESTAMP ELSE NULL END
              )
            `,
            [
              groupRow.id,
              groupRow.item_id,
              groupRow.list_id,
              userId,
              amountCents,
              contributionQuantity,
              status,
              note,
            ]
          );
        }

        await recalcGroupStatus(client, groupRow.id);
        const freshGroup = await fetchGroupById(client, groupRow.id);
        return hydrateGroup(client, freshGroup, userId);
      });

      await emitSharedPurchaseEvent(item.list_id, userId, {
        action: 'contribution_saved',
        item_id: item.id,
        item_title: item.item_title,
        list_id: item.list_id,
        list_title: item.list_title,
        actor_id: userId,
        group,
      });

      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] upsertContribution error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  manageGroup: async (req, res) => {
    const { groupId } = req.params;
    const userId = req.user.id;
    const payload = req.body || {};

    try {
      const { group, item: itemContext } = await db.transaction(async (client) => {
        const groupRow = await fetchGroupById(client, groupId, { forUpdate: true });
        if (!groupRow) {
          throw httpError(404, 'Shared purchase group not found');
        }

        const item = await fetchItemContext(client, groupRow.item_id);
        await ensureCollaboratorAccess(item, userId);

        if (payload.status === 'completed') {
          const { rows: summaryRows } = await client.query(
            `
              SELECT
                COALESCE(SUM(CASE WHEN status IN ('pledged','fulfilled') THEN contribution_cents ELSE 0 END), 0) AS contributed_cents,
                COALESCE(SUM(CASE WHEN status IN ('pledged','fulfilled') THEN contribution_quantity ELSE 0 END), 0) AS contribution_quantity
              FROM gift_contributions
              WHERE group_id = $1
                AND deleted_at IS NULL
            `,
            [groupId]
          );

          const totals = summaryRows[0] || {};
          const contributedCents = Number(totals.contributed_cents) || 0;
          const contributedQuantity = Number(totals.contribution_quantity) || 0;

          const meetsCurrencyGoal = groupRow.target_cents != null && contributedCents >= groupRow.target_cents;
          const meetsQuantityGoal = groupRow.is_quantity_based && groupRow.target_quantity != null && contributedQuantity >= groupRow.target_quantity;

          if (!meetsCurrencyGoal && !meetsQuantityGoal) {
            throw httpError(409, 'Shared purchase goal has not been met yet');
          }
        }

        const updates = [];
        const values = [];
        let idx = 1;

        if (payload.notes !== undefined) {
          updates.push(`notes = $${idx++}`);
          values.push(payload.notes ? String(payload.notes).trim() : null);
        }

        if (payload.targetCents !== undefined) {
          const targetCents = ensurePositiveInt(payload.targetCents, 'targetCents');
          updates.push(`target_cents = $${idx++}`);
          values.push(targetCents);
        }

        if (payload.targetQuantity !== undefined) {
          const targetQuantity = ensurePositiveInt(payload.targetQuantity, 'targetQuantity');
          updates.push(`target_quantity = $${idx++}`);
          values.push(targetQuantity);
        }

        if (payload.currency !== undefined) {
          updates.push(`currency_code = $${idx++}`);
          values.push(sanitizeCurrencyCode(payload.currency));
        }

        let statusOverride = null;
        if (payload.status) {
          statusOverride = String(payload.status);
        }
        if (payload.lock === true) {
          statusOverride = 'locked';
        } else if (payload.unlock === true) {
          statusOverride = 'open';
        } else if (payload.abandon === true) {
          statusOverride = 'abandoned';
        }

        if (statusOverride) {
          if (!['open', 'locked', 'completed', 'abandoned'].includes(statusOverride)) {
            throw httpError(400, 'Invalid status value');
          }

          updates.push(`status = $${idx++}`);
          values.push(statusOverride);

          if (statusOverride === 'locked') {
            updates.push(`locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)`);
          } else if (statusOverride === 'open') {
            updates.push(`locked_at = NULL`);
            updates.push(`completed_at = NULL`);
            updates.push(`abandoned_at = NULL`);
            updates.push(`deleted_at = NULL`);
          } else if (statusOverride === 'completed') {
            updates.push(`completed_at = CURRENT_TIMESTAMP`);
            updates.push(`locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP)`);
          } else if (statusOverride === 'abandoned') {
            updates.push(`abandoned_at = CURRENT_TIMESTAMP`);
          }
        }

        if (updates.length === 0) {
          const hydrated = await hydrateGroup(client, groupRow, userId);
          return { group: hydrated, item: item };
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        const updateSql = `
          UPDATE gift_purchase_groups
             SET ${updates.join(', ')}
           WHERE id = $${idx}
           RETURNING *
        `;
        values.push(groupId);

        const { rows: updatedRows } = await client.query(updateSql, values);
        let updatedGroup = updatedRows[0];

        if (!TERMINAL_GROUP_STATUSES.has(updatedGroup.status)) {
          updatedGroup = await recalcGroupStatus(client, updatedGroup.id);
        }

        const hydrated = await hydrateGroup(client, updatedGroup, userId);
        return { group: hydrated, item };
      });

      await emitSharedPurchaseEvent(itemContext.list_id, userId, {
        action: 'group_updated',
        item_id: itemContext.id,
        item_title: itemContext.item_title,
        list_id: itemContext.list_id,
        list_title: itemContext.list_title,
        actor_id: userId,
        group,
      });

      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] manageGroup error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  deleteGroup: async (req, res) => {
    const { groupId } = req.params;
    const userId = req.user.id;

    try {
      const { group, item: itemContext } = await db.transaction(async (client) => {
        const groupRow = await fetchGroupById(client, groupId, { forUpdate: true });
        if (!groupRow) {
          throw httpError(404, 'Shared purchase group not found');
        }

        const item = await fetchItemContext(client, groupRow.item_id);
        await ensureCollaboratorAccess(item, userId);

        await client.query(
          `
            UPDATE gift_purchase_groups
               SET status = 'abandoned',
                   abandoned_at = COALESCE(abandoned_at, CURRENT_TIMESTAMP),
                   deleted_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
          `,
          [groupId]
        );

        await client.query(
          `
            UPDATE gift_contributions
               SET status = 'cancelled',
                   deleted_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
             WHERE group_id = $1
               AND deleted_at IS NULL
          `,
          [groupId]
        );

        await client.query(
          `
            UPDATE gift_reservations
               SET active_purchase_group_id = NULL
             WHERE active_purchase_group_id = $1
          `,
          [groupId]
        );

        const freshGroup = await fetchGroupById(client, groupId);
        const hydrated = await hydrateGroup(client, freshGroup, userId);
        return { group: hydrated, item };
      });

      await emitSharedPurchaseEvent(itemContext.list_id, userId, {
        action: 'group_deleted',
        item_id: itemContext.id,
        item_title: itemContext.item_title,
        list_id: itemContext.list_id,
        list_title: itemContext.list_title,
        actor_id: userId,
        group,
      });

      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] deleteGroup error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  updateContribution: async (req, res) => {
    const { groupId, contributionId } = req.params;
    const userId = req.user.id;
    const payload = req.body || {};

    try {
      const { group, item } = await db.transaction(async (client) => {
        const groupRow = await fetchGroupById(client, groupId, { forUpdate: true });
        if (!groupRow) {
          throw httpError(404, 'Shared purchase group not found');
        }

        const item = await fetchItemContext(client, groupRow.item_id);
        await ensureCollaboratorAccess(item, userId);

        const { rows } = await client.query(
          `
            SELECT *
            FROM gift_contributions
            WHERE id = $1
              AND group_id = $2
            LIMIT 1
            FOR UPDATE
          `,
          [contributionId, groupId]
        );

        if (rows.length === 0) {
          throw httpError(404, 'Contribution not found');
        }

        const existing = rows[0];
        const isSelf = existing.contributor_id && String(existing.contributor_id) === String(userId);
        if (!isSelf) {
          throw httpError(403, 'You do not have permission to modify this contribution');
        }

        let amountCents = existing.contribution_cents;
        if (payload.amountCents !== undefined) {
          amountCents =
            payload.amountCents === null
              ? null
              : ensurePositiveInt(payload.amountCents, 'amountCents');
        }

        let quantity = existing.contribution_quantity;
        if (payload.quantity !== undefined) {
          quantity = ensurePositiveInt(payload.quantity, 'quantity', { allowZero: false }) || 0;
        }

        let note = existing.note;
        if (payload.note !== undefined) {
          note = payload.note ? String(payload.note).trim() : null;
        }

        let status = existing.status;
        if (payload.status) {
          if (!['pledged', 'fulfilled', 'cancelled', 'expired'].includes(payload.status)) {
            throw httpError(400, 'Invalid contribution status');
          }
          status = payload.status;
        } else if (payload.markFulfilled !== undefined) {
          status = payload.markFulfilled ? 'fulfilled' : 'pledged';
        }

        let isExternal = existing.is_external;
        if (payload.isExternal !== undefined) {
          isExternal = Boolean(payload.isExternal);
        }

        let externalName = existing.external_contributor_name;
        if (payload.externalContributorName !== undefined) {
          externalName = payload.externalContributorName
            ? String(payload.externalContributorName).trim()
            : null;
        }
        if (!isExternal) {
          externalName = null;
        }

        if (!groupRow.is_quantity_based && amountCents === null) {
          throw httpError(400, 'amountCents is required for monetary contributions');
        }
        if (groupRow.is_quantity_based && amountCents === null && quantity === 0) {
          throw httpError(400, 'quantity is required for quantity-based contributions');
        }

        const fulfilledAt =
          status === 'fulfilled'
            ? existing.fulfilled_at || new Date()
            : status === 'cancelled'
              ? null
              : existing.fulfilled_at;

        await client.query(
          `
            UPDATE gift_contributions
               SET contribution_cents = $1,
                   contribution_quantity = $2,
                   status = $3,
                   note = $4,
                   is_external = $5,
                   external_contributor_name = $6,
                   fulfilled_at = $7,
                   updated_at = CURRENT_TIMESTAMP,
                   deleted_at = CASE WHEN $3 = 'cancelled' THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE id = $8
          `,
          [
            amountCents,
            quantity,
            status,
            note,
            isExternal,
            externalName,
            fulfilledAt,
            contributionId,
          ]
        );

        await recalcGroupStatus(client, groupId);
        const freshGroup = await fetchGroupById(client, groupId);
        const hydrated = await hydrateGroup(client, freshGroup, userId);
        return { group: hydrated, item };
      });

      await emitSharedPurchaseEvent(item.list_id, userId, {
        action: 'contribution_updated',
        item_id: item.id,
        item_title: item.item_title,
        list_id: item.list_id,
        list_title: item.list_title,
        actor_id: userId,
        group,
      });

      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] updateContribution error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  deleteContribution: async (req, res) => {
    const { groupId, contributionId } = req.params;
    const userId = req.user.id;

    try {
      const { group, item } = await db.transaction(async (client) => {
        const groupRow = await fetchGroupById(client, groupId, { forUpdate: true });
        if (!groupRow) {
          throw httpError(404, 'Shared purchase group not found');
        }

        const { rows } = await client.query(
          `
            SELECT *
            FROM gift_contributions
            WHERE id = $1
              AND group_id = $2
              AND deleted_at IS NULL
            LIMIT 1
            FOR UPDATE
          `,
          [contributionId, groupId]
        );

        if (rows.length === 0) {
          throw httpError(404, 'Contribution not found');
        }

        const contribution = rows[0];
        const item = await fetchItemContext(client, groupRow.item_id);

        const isSelf = contribution.contributor_id && String(contribution.contributor_id) === String(userId);

        if (!isSelf) {
          throw httpError(403, 'You do not have permission to remove this contribution');
        }

        await client.query(
          `
            UPDATE gift_contributions
               SET status = 'cancelled',
                   deleted_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
          `,
          [contributionId]
        );

        await recalcGroupStatus(client, groupId);
        const freshGroup = await fetchGroupById(client, groupId);
        const hydrated = await hydrateGroup(client, freshGroup, userId);
        return { group: hydrated, item };
      });

      await emitSharedPurchaseEvent(item.list_id, userId, {
        action: 'contribution_removed',
        item_id: item.id,
        item_title: item.item_title,
        list_id: item.list_id,
        list_title: item.list_title,
        actor_id: userId,
        group,
      });

      return res.json({ group });
    } catch (error) {
      const status = error.status || 500;
      if (status !== 500) {
        return res.status(status).json({ error: error.message });
      }
      console.error('[SharedPurchaseController] deleteContribution error', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
};

module.exports = SharedPurchaseController;
