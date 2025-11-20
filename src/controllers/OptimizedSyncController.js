const db = require('../config/db');
const { logger } = require('../utils/logger');
const syncOptimization = require('../config/sync-optimization');
const { normalizeReservationQuantity, buildReservationResponse } = require('../utils/giftReservationUtils');

function optimizedSyncControllerFactory(socketService) {

  /**
   * Pre-fetch all accessible list IDs for a user
   * This reduces permission checks to a single query
   */
  const getUserAccessibleListIds = async (userId) => {
    const query = `
      SELECT DISTINCT list_id FROM (
        -- Lists owned by user
        SELECT id as list_id FROM public.lists
        WHERE owner_id = $1 AND deleted_at IS NULL

        UNION

        -- Lists shared with user through groups
        SELECT DISTINCT lgr.list_id
        FROM list_group_roles lgr
        JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
        WHERE cgm.user_id = $1
          AND lgr.deleted_at IS NULL
          AND cgm.deleted_at IS NULL

        UNION

        -- Lists shared directly with user
        SELECT DISTINCT luo.list_id
        FROM list_user_overrides luo
        WHERE luo.user_id = $1
          AND luo.deleted_at IS NULL
          AND luo.role NOT IN ('blocked', 'inherit')

        UNION

        -- Lists with Secret Santa participation
        SELECT DISTINCT sr.list_id
        FROM secret_santa_round_participants rsp
        JOIN secret_santa_rounds sr ON rsp.round_id = sr.id
        WHERE rsp.user_id = $1
      ) as accessible_lists
    `;

    const result = await db.query(query, [userId]);
    return new Set(result.rows.map(row => row.list_id));
  };

  /**
   * Optimized pull changes using batch fetching strategy
   * Reduces from N+1 queries to ~10 batch queries
   */
  const handleGetChangesOptimized = async (req, res) => {
    const lastPulledAtString = req.query.last_pulled_at;
    let lastPulledAt = 0;

    if (lastPulledAtString) {
      const parsedDate = Date.parse(lastPulledAtString);
      if (!isNaN(parsedDate)) {
        lastPulledAt = parsedDate;
      }
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      // Step 1: Pre-fetch accessible list IDs (single query)
      const accessibleListIds = await getUserAccessibleListIds(userId);
      const listIdsArray = Array.from(accessibleListIds);

      // Step 2: Get change log entries (lightweight, no subqueries)
      // Skip change log entirely for initial sync since we fetch baseline data separately
      let changeLogResult = { rows: [] };

      if (lastPulledAt > 0) {
        // Convert milliseconds timestamp to ISO string for better index usage
        const lastPulledDate = new Date(lastPulledAt).toISOString();

        // Use optimized query with proper timestamp format
        const changesQuery = `
          SELECT
            cl.table_name,
            cl.record_id,
            cl.operation,
            cl.created_at,
            cl.change_data
          FROM public.change_log cl
          WHERE cl.user_id = $1
            AND cl.created_at > $2::timestamptz
          ORDER BY cl.created_at ASC
          LIMIT 1000
        `;

        changeLogResult = await db.query(changesQuery, [userId, lastPulledDate]);

        if (changeLogResult.rows.length === 1000) {
          logger.warn(`[OptimizedSyncController] Hit 1000 row limit for user ${userId} - may need pagination`);
        }
      } else {
        logger.info(`[OptimizedSyncController] Initial sync for user ${userId}: skipping change log, using baseline data only`);
      }

      // Step 3: Group record IDs by table for batch fetching
      const recordIdsByTable = {
        lists: new Set(),
        list_items: new Set(),
        favorites: new Set(),
        users: new Set(),
        followers: new Set(),
        notifications: new Set(),
        list_categories: new Set(),
        item_tags: new Set(),
        gift_reservations: new Set(),
        gift_purchase_groups: new Set(),
        gift_contributions: new Set(),
        secret_santa_rounds: new Set(),
        secret_santa_round_participants: new Set(),
        secret_santa_pairings: new Set(),
        secret_santa_guest_invites: new Set()
      };

      // Collect all record IDs that need fetching
      for (const change of changeLogResult.rows) {
        if (change.operation !== 'delete' && recordIdsByTable[change.table_name]) {
          // Pre-validate UUID format to avoid regex in queries
          if (change.record_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
            recordIdsByTable[change.table_name].add(change.record_id);
          }
          if (change.table_name === 'secret_santa_round_participants' && change.change_data) {
            const payload = typeof change.change_data === 'string'
              ? (() => {
                  try {
                    return JSON.parse(change.change_data);
                  } catch {
                    return null;
                  }
                })()
              : change.change_data;
            const roundId = payload?.round_id || payload?.roundId;
            if (
              typeof roundId === 'string' &&
              roundId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
            ) {
              recordIdsByTable.secret_santa_rounds.add(roundId);
            }
          }
        }
      }

      // Step 4: Batch fetch all data
      const fetchedData = {};

      // Fetch lists (with permission check using pre-fetched list IDs)
      if (recordIdsByTable.lists.size > 0) {
        const listIds = Array.from(recordIdsByTable.lists);
        const listsQuery = `
          SELECT * FROM public.lists
          WHERE id = ANY($1::uuid[])
            AND deleted_at IS NULL
            AND (owner_id = $2 OR id = ANY($3::uuid[]))
        `;
        const listsResult = await db.query(listsQuery, [listIds, userId, listIdsArray]);
        fetchedData.lists = {};
        for (const row of listsResult.rows) {
          fetchedData.lists[row.id] = row;
        }
      }

      // Fetch list items (with permission check using pre-fetched list IDs)
      if (recordIdsByTable.list_items.size > 0) {
        const itemIds = Array.from(recordIdsByTable.list_items);
        const itemsQuery = `
          SELECT
            li.id,
            li.list_id,
            li.title,
            li.description,
            li.status,
            li.priority,
            li.image_url,
            li.link,
            li.custom_fields,
            li.owner_id,
            li.created_at,
            li.updated_at,
            li.deleted_at,
            li.price,
            li.api_metadata,
            li.gift_detail_id,
            gd.quantity,
            gd.where_to_buy,
            gd.amazon_url,
            gd.web_link,
            gd.rating
          FROM public.list_items li
          LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id
          WHERE li.id = ANY($1::uuid[])
            AND li.deleted_at IS NULL
            AND (li.owner_id = $2 OR li.list_id = ANY($3::uuid[]))
        `;
        const itemsResult = await db.query(itemsQuery, [itemIds, userId, listIdsArray]);
        fetchedData.list_items = {};
        for (const row of itemsResult.rows) {
          fetchedData.list_items[row.id] = row;
        }
      }

      // Fetch favorites
      if (recordIdsByTable.favorites.size > 0) {
        const favIds = Array.from(recordIdsByTable.favorites);
        const favsQuery = `
          SELECT * FROM public.favorites
          WHERE id = ANY($1::uuid[])
            AND user_id = $2
            AND deleted_at IS NULL
        `;
        const favsResult = await db.query(favsQuery, [favIds, userId]);
        fetchedData.favorites = {};
        for (const row of favsResult.rows) {
          fetchedData.favorites[row.id] = row;
        }
      }

      // Fetch user settings (special case - no array needed)
      const hasUserSettings = changeLogResult.rows.some(
        c => c.table_name === 'user_settings' && c.operation !== 'delete'
      );
      if (hasUserSettings) {
        const settingsQuery = `SELECT * FROM public.user_settings WHERE user_id = $1`;
        const settingsResult = await db.query(settingsQuery, [userId]);
        if (settingsResult.rows.length > 0) {
          fetchedData.user_settings = settingsResult.rows[0];
        }
      }

      // Fetch users
      if (recordIdsByTable.users.size > 0) {
        const userIds = Array.from(recordIdsByTable.users);
        const usersQuery = `SELECT * FROM public.users WHERE id = ANY($1::uuid[])`;
        const usersResult = await db.query(usersQuery, [userIds]);
        fetchedData.users = {};
        for (const row of usersResult.rows) {
          fetchedData.users[row.id] = row;
        }
      }

      // Fetch followers
      if (recordIdsByTable.followers.size > 0) {
        const followerIds = Array.from(recordIdsByTable.followers);
        const followersQuery = `
          SELECT * FROM public.followers
          WHERE id = ANY($1::uuid[])
            AND (follower_id = $2 OR followed_id = $2)
            AND deleted_at IS NULL
        `;
        const followersResult = await db.query(followersQuery, [followerIds, userId]);
        fetchedData.followers = {};
        for (const row of followersResult.rows) {
          fetchedData.followers[row.id] = row;
        }
      }

      // Fetch notifications
      if (recordIdsByTable.notifications.size > 0) {
        const notifIds = Array.from(recordIdsByTable.notifications);
        const notifsQuery = `
          SELECT * FROM public.notifications
          WHERE id = ANY($1::uuid[])
            AND user_id = $2
            AND deleted_at IS NULL
        `;
        const notifsResult = await db.query(notifsQuery, [notifIds, userId]);
        fetchedData.notifications = {};
        for (const row of notifsResult.rows) {
          fetchedData.notifications[row.id] = row;
        }
      }

      // Fetch list categories
      if (recordIdsByTable.list_categories.size > 0) {
        const catIds = Array.from(recordIdsByTable.list_categories);
        const catsQuery = `
          SELECT * FROM public.list_categories
          WHERE id = ANY($1::uuid[])
            AND deleted_at IS NULL
        `;
        const catsResult = await db.query(catsQuery, [catIds]);
        fetchedData.list_categories = {};
        for (const row of catsResult.rows) {
          fetchedData.list_categories[row.id] = row;
        }
      }

      // Fetch gift reservations
      if (recordIdsByTable.gift_reservations.size > 0) {
        const reservationIds = Array.from(recordIdsByTable.gift_reservations);
        const reservationsQuery = `
          SELECT gr.*
          FROM public.gift_reservations gr
          JOIN public.list_items li ON gr.item_id = li.id
          WHERE gr.id = ANY($1::uuid[])
            AND gr.deleted_at IS NULL
            AND (
              li.owner_id = $2
              OR gr.reserved_by = $2
              OR gr.reserved_for = $2
              OR li.list_id = ANY($3::uuid[])
            )
        `;
        const reservationsResult = await db.query(reservationsQuery, [reservationIds, userId, listIdsArray]);
        fetchedData.gift_reservations = {};
        for (const row of reservationsResult.rows) {
          fetchedData.gift_reservations[row.id] = row;
        }
      }

      // Fetch gift purchase groups
      if (recordIdsByTable.gift_purchase_groups.size > 0) {
        const groupIds = Array.from(recordIdsByTable.gift_purchase_groups);
        const groupsQuery = `
          SELECT *
          FROM public.gift_purchase_groups
          WHERE id = ANY($1::uuid[])
            AND deleted_at IS NULL
            AND (
              created_by = $2
              OR list_id = ANY($3::uuid[])
            )
        `;
        const groupsResult = await db.query(groupsQuery, [groupIds, userId, listIdsArray]);
        fetchedData.gift_purchase_groups = {};
        for (const row of groupsResult.rows) {
          fetchedData.gift_purchase_groups[row.id] = row;
        }
      }

      // Fetch gift contributions
      if (recordIdsByTable.gift_contributions.size > 0) {
        const contributionIds = Array.from(recordIdsByTable.gift_contributions);
        const contributionsQuery = `
          SELECT gc.*
          FROM public.gift_contributions gc
          JOIN public.gift_purchase_groups gpg ON gc.group_id = gpg.id
          WHERE gc.id = ANY($1::uuid[])
            AND gc.deleted_at IS NULL
            AND gpg.deleted_at IS NULL
            AND (
              gc.contributor_id = $2
              OR gpg.created_by = $2
              OR gpg.list_id = ANY($3::uuid[])
            )
        `;
        const contributionsResult = await db.query(contributionsQuery, [contributionIds, userId, listIdsArray]);
        fetchedData.gift_contributions = {};
        for (const row of contributionsResult.rows) {
          fetchedData.gift_contributions[row.id] = row;
        }
      }

      if (recordIdsByTable.secret_santa_rounds.size > 0) {
        const roundIds = Array.from(recordIdsByTable.secret_santa_rounds);
        const roundsQuery = `
          SELECT *
          FROM public.secret_santa_rounds
          WHERE id = ANY($1::uuid[])
        `;
        const roundsResult = await db.query(roundsQuery, [roundIds]);
        fetchedData.secret_santa_rounds = {};
        for (const row of roundsResult.rows) {
          fetchedData.secret_santa_rounds[row.id] = row;
        }
      }

      if (recordIdsByTable.secret_santa_round_participants.size > 0) {
        const participantIds = Array.from(recordIdsByTable.secret_santa_round_participants);
        const participantsQuery = `
          SELECT sp.*,
                 sr.list_id AS round_list_id
          FROM public.secret_santa_round_participants sp
          JOIN public.secret_santa_rounds sr ON sp.round_id = sr.id
          JOIN public.lists l ON sr.list_id = l.id
          WHERE sp.id = ANY($1::uuid[])
            AND (
              sp.user_id = $2
              OR l.owner_id = $2
              OR sr.list_id = ANY($3::uuid[])
            )
        `;
        const participantsResult = await db.query(participantsQuery, [participantIds, userId, listIdsArray]);
        fetchedData.secret_santa_round_participants = {};
        for (const row of participantsResult.rows) {
          const normalizedRow = {
            ...row,
            list_id: row.list_id || row.round_list_id,
          };
          delete normalizedRow.round_list_id;
          fetchedData.secret_santa_round_participants[row.id] = normalizedRow;
        }
      }

      if (recordIdsByTable.secret_santa_pairings.size > 0) {
        const pairingIds = Array.from(recordIdsByTable.secret_santa_pairings);
        const pairingsQuery = `
          SELECT sp.*
          FROM public.secret_santa_pairings sp
          JOIN public.secret_santa_rounds sr ON sp.round_id = sr.id
          JOIN public.lists l ON sr.list_id = l.id
          WHERE sp.id = ANY($1::uuid[])
            AND (
              sp.giver_user_id = $2
              OR l.owner_id = $2
            )
            AND (sr.list_id = ANY($3::uuid[]) OR l.owner_id = $2 OR sr.created_by = $2)
        `;
        const pairingsResult = await db.query(pairingsQuery, [pairingIds, userId, listIdsArray]);
        fetchedData.secret_santa_pairings = {};
        for (const row of pairingsResult.rows) {
          fetchedData.secret_santa_pairings[row.id] = row;
        }
      }

      if (recordIdsByTable.secret_santa_guest_invites.size > 0) {
        const inviteIds = Array.from(recordIdsByTable.secret_santa_guest_invites);
        const invitesQuery = `
          SELECT gi.*
          FROM public.secret_santa_guest_invites gi
          JOIN public.secret_santa_rounds sr ON gi.round_id = sr.id
          JOIN public.lists l ON sr.list_id = l.id
          WHERE gi.id = ANY($1::uuid[])
            AND gi.deleted_at IS NULL
            AND (l.owner_id = $2 OR sr.list_id = ANY($3::uuid[]) OR sr.created_by = $2)
        `;
        const invitesResult = await db.query(invitesQuery, [inviteIds, userId, listIdsArray]);
        fetchedData.secret_santa_guest_invites = {};
        for (const row of invitesResult.rows) {
          fetchedData.secret_santa_guest_invites[row.id] = row;
        }
      }

      // Step 5: Process changes with fetched data
      const changes = {
        list_items: { created: [], updated: [], deleted: [] },
        lists: { created: [], updated: [], deleted: [] },
        user_settings: { created: [], updated: [], deleted: [] },
        users: { created: [], updated: [], deleted: [] },
        favorites: { created: [], updated: [], deleted: [] },
        followers: { created: [], updated: [], deleted: [] },
        notifications: { created: [], updated: [], deleted: [] },
        list_categories: { created: [], updated: [], deleted: [] },
        item_tags: { created: [], updated: [], deleted: [] },
        gift_reservations: { created: [], updated: [], deleted: [] },
        gift_purchase_groups: { created: [], updated: [], deleted: [] },
        gift_contributions: { created: [], updated: [], deleted: [] },
        secret_santa_rounds: { created: [], updated: [], deleted: [] },
        secret_santa_round_participants: { created: [], updated: [], deleted: [] },
        secret_santa_pairings: { created: [], updated: [], deleted: [] },
        secret_santa_guest_invites: { created: [], updated: [], deleted: [] }
      };

      // Map change log entries to actual data
      for (const change of changeLogResult.rows) {
        const { table_name, record_id, operation } = change;

        if (!changes[table_name]) continue;

        if (operation === 'delete') {
          changes[table_name].deleted.push(record_id);
        } else {
          // Get data from pre-fetched results
          let current_data = null;

          if (table_name === 'user_settings') {
            current_data = fetchedData.user_settings;
          } else if (fetchedData[table_name] && fetchedData[table_name][record_id]) {
            current_data = fetchedData[table_name][record_id];
          } else if (operation !== 'delete' && change.change_data) {
            // Fallback to change_data if not found (shouldn't happen often)
            try {
              current_data = typeof change.change_data === 'string'
                ? JSON.parse(change.change_data)
                : change.change_data;
            } catch (e) {
              logger.warn(`[OptimizedSyncController] Failed to parse change_data for ${table_name}:${record_id}`);
            }
          }

          if (current_data) {
            // Convert timestamps to milliseconds for client compatibility
            if (current_data.created_at) {
              current_data.created_at = new Date(current_data.created_at).getTime();
            }
            if (current_data.updated_at) {
              current_data.updated_at = new Date(current_data.updated_at).getTime();
            }
            if (table_name === 'gift_purchase_groups') {
              for (const field of ['locked_at', 'completed_at', 'abandoned_at', 'reminder_scheduled_at']) {
                if (current_data[field]) {
                  current_data[field] = new Date(current_data[field]).getTime();
                }
              }
            }
            if (table_name === 'gift_contributions') {
              if (current_data.fulfilled_at) {
                current_data.fulfilled_at = new Date(current_data.fulfilled_at).getTime();
              }
            }
            if (table_name === 'secret_santa_rounds') {
              if (current_data.exchange_date) {
                current_data.exchange_date = new Date(current_data.exchange_date).getTime();
              }
            }

            if (operation === 'create') {
              changes[table_name].created.push(current_data);
            } else {
              changes[table_name].updated.push(current_data);
            }
          }
        }
      }

      // Ensure list metadata is available for Secret Santa invitees
      const referencedListIds = new Set(
        [...changes.secret_santa_rounds.created, ...changes.secret_santa_rounds.updated]
          .map((round) => round?.list_id)
          .filter(Boolean)
      );
      if (referencedListIds.size > 0) {
        const knownListIds = new Set([
          ...changes.lists.created.map((list) => String(list.id)),
          ...changes.lists.updated.map((list) => String(list.id)),
        ]);
        const missingListIds = Array.from(referencedListIds).filter(
          (listId) => !knownListIds.has(String(listId))
        );
        if (missingListIds.length > 0) {
          const { rows: invitedLists } = await db.query(
            `SELECT *
               FROM public.lists
              WHERE id = ANY($1::uuid[])`,
            [missingListIds]
          );
          invitedLists.forEach((listRow) => {
            if (listRow.created_at) listRow.created_at = new Date(listRow.created_at).getTime();
            if (listRow.updated_at) listRow.updated_at = new Date(listRow.updated_at).getTime();
            listRow.shared_with_me = true;
            if (!listRow.share_type) {
              listRow.share_type = 'individual_shared';
            }
            listRow.shared_by_owner =
              typeof listRow.shared_by_owner === 'boolean'
                ? listRow.shared_by_owner
                : true;
            listRow.access_type = listRow.access_type || 'shared';
            listRow.type_shared = listRow.share_type;
            changes.lists.updated.push(listRow);
          });
        }
      }

      // Step 6: Batch fetch gift status for non-owned gift lists
      const allListIds = new Set();
      [...changes.lists.created, ...changes.lists.updated].forEach(list => {
        if (list && list.list_type === 'gifts' && list.owner_id !== userId) {
          allListIds.add(list.id);
        }
      });

      if (allListIds.size > 0) {
        const giftListIds = Array.from(allListIds);
        const reservationsQuery = `
          SELECT
            gr.*,
            u.username as reserved_by_username,
            u.full_name as reserved_by_full_name
          FROM gift_reservations gr
          LEFT JOIN users u ON gr.reserved_by = u.id
          WHERE gr.deleted_at IS NULL
            AND gr.item_id IN (
              SELECT id FROM list_items
              WHERE list_id = ANY($1::uuid[])
            )
        `;
        const reservationsResult = await db.query(reservationsQuery, [giftListIds]);

        const reservationsByItem = new Map();
        for (const row of reservationsResult.rows) {
          const normalizedRow = {
            ...row,
            quantity: normalizeReservationQuantity(row.quantity),
          };
          const existing = reservationsByItem.get(row.item_id) || [];
          existing.push(normalizedRow);
          reservationsByItem.set(row.item_id, existing);
        }

        [...changes.list_items.created, ...changes.list_items.updated].forEach(item => {
          if (!item || !giftListIds.includes(item.list_id)) return;
          const reservations = reservationsByItem.get(item.id);
          if (!reservations || reservations.length === 0) {
            return;
          }

          const itemForStatus = {
            ...item,
            gift_quantity: item.gift_quantity ?? item.quantity ?? 1,
          };

          const status = buildReservationResponse({
            item: itemForStatus,
            reservations,
            userId,
            isListOwner: false,
          });

          item.giftStatus = status;
        });
      }

      // Step 7: Handle initial sync (baseline data)
      if (lastPulledAt === 0) {
        try {
          logger.info(`[OptimizedSyncController] Starting baseline data fetch for user ${userId}`);
          logger.info(`[OptimizedSyncController] Accessible list IDs count: ${listIdsArray.length}`);

          // Include all tags
          const catRes = await db.query(`SELECT * FROM public.tags WHERE deleted_at IS NULL`);
          for (const row of catRes.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.tags = changes.tags || { created: [], updated: [], deleted: [] };
            changes.tags.created.push(row);
          }

          // Include all accessible lists
          // Fix: Ensure we fetch owned lists even if listIdsArray is empty
          const listsQuery = listIdsArray.length > 0
            ? `SELECT * FROM public.lists
               WHERE deleted_at IS NULL
                 AND (owner_id = $1 OR id = ANY($2::uuid[]))`
            : `SELECT * FROM public.lists
               WHERE deleted_at IS NULL
                 AND owner_id = $1`;

          const listsQueryParams = listIdsArray.length > 0
            ? [userId, listIdsArray]
            : [userId];

          const listsRes = await db.query(listsQuery, listsQueryParams);
          logger.info(`[OptimizedSyncController] Found ${listsRes.rows.length} lists for initial sync`);

          for (const row of listsRes.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.lists.created.push(row);
          }

          // Include all items from accessible lists
          // Fix: Ensure we fetch owned items even if listIdsArray is empty
          const itemsQuery = listIdsArray.length > 0
            ? `SELECT
                 li.*,
                 gd.quantity,
                 gd.where_to_buy,
                 gd.amazon_url,
                 gd.web_link,
                 gd.rating
               FROM public.list_items li
               LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id
               WHERE li.deleted_at IS NULL
                 AND (li.owner_id = $1 OR li.list_id = ANY($2::uuid[]))`
            : `SELECT
                 li.*,
                 gd.quantity,
                 gd.where_to_buy,
                 gd.amazon_url,
                 gd.web_link,
                 gd.rating
               FROM public.list_items li
               LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id
               WHERE li.deleted_at IS NULL
                 AND li.owner_id = $1`;

          const itemsQueryParams = listIdsArray.length > 0
            ? [userId, listIdsArray]
            : [userId];

          const itemsRes = await db.query(itemsQuery, itemsQueryParams);
          logger.info(`[OptimizedSyncController] Found ${itemsRes.rows.length} items for initial sync`);
          for (const row of itemsRes.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.list_items.created.push(row);
          }

          // Include gift reservations for accessible items
          const reservationsBaselineQuery = `
            SELECT
              gr.*,
              u.username as reserved_by_username,
              u.full_name as reserved_by_full_name,
              li.list_id
            FROM gift_reservations gr
            JOIN list_items li ON gr.item_id = li.id
            LEFT JOIN users u ON gr.reserved_by = u.id
            WHERE gr.deleted_at IS NULL
              AND (
                li.owner_id = $1
                OR li.list_id = ANY($2::uuid[])
                OR gr.reserved_by = $1
                OR gr.reserved_for = $1
              )
          `;
          const reservationsBaselineResult = await db.query(reservationsBaselineQuery, [userId, listIdsArray]);
          const reservationsRows = reservationsBaselineResult.rows || [];
          for (const row of reservationsRows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.gift_reservations.created.push(row);
          }

          // Include shared purchase groups for accessible lists
          const groupsBaselineQuery = `
            SELECT *
            FROM public.gift_purchase_groups
            WHERE deleted_at IS NULL
              AND (
                created_by = $1
                OR list_id = ANY($2::uuid[])
              )
          `;
          const groupsBaselineResult = await db.query(groupsBaselineQuery, [userId, listIdsArray]);
          const groupTimestampFields = ['created_at', 'updated_at', 'locked_at', 'completed_at', 'abandoned_at', 'reminder_scheduled_at'];
          for (const row of groupsBaselineResult.rows) {
            for (const field of groupTimestampFields) {
              if (row[field]) {
                row[field] = new Date(row[field]).getTime();
              }
            }
            changes.gift_purchase_groups.created.push(row);
          }

          // Include gift contributions related to accessible groups or made by the user
          const contributionsBaselineQuery = `
            SELECT gc.*
            FROM public.gift_contributions gc
            JOIN public.gift_purchase_groups gpg ON gc.group_id = gpg.id
            WHERE gc.deleted_at IS NULL
              AND gpg.deleted_at IS NULL
              AND (
                gc.contributor_id = $1
                OR gpg.created_by = $1
                OR gpg.list_id = ANY($2::uuid[])
              )
          `;
          const contributionsBaselineResult = await db.query(contributionsBaselineQuery, [userId, listIdsArray]);
          const contributionTimestampFields = ['created_at', 'updated_at', 'fulfilled_at'];
          for (const row of contributionsBaselineResult.rows) {
            for (const field of contributionTimestampFields) {
              if (row[field]) {
                row[field] = new Date(row[field]).getTime();
              }
            }
            changes.gift_contributions.created.push(row);
          }

          const secretSantaRoundsBaselineQuery = `
            SELECT sr.*
            FROM public.secret_santa_rounds sr
            JOIN public.lists l ON sr.list_id = l.id
            WHERE (
              sr.list_id = ANY($1::uuid[])
              OR l.owner_id = $2
              OR sr.created_by = $2
              OR EXISTS (
                SELECT 1
                FROM public.secret_santa_round_participants rsp
                WHERE rsp.round_id = sr.id
                  AND rsp.user_id = $2
              )
            )
          `;
          const secretSantaRoundsBaselineResult = await db.query(secretSantaRoundsBaselineQuery, [listIdsArray, userId]);
          for (const row of secretSantaRoundsBaselineResult.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            if (row.exchange_date) row.exchange_date = new Date(row.exchange_date).getTime();
            changes.secret_santa_rounds.created.push(row);
          }

          const secretSantaParticipantsBaselineQuery = `
            SELECT sp.*,
                   sr.list_id AS round_list_id
            FROM public.secret_santa_round_participants sp
            JOIN public.secret_santa_rounds sr ON sp.round_id = sr.id
            JOIN public.lists l ON sr.list_id = l.id
            WHERE (
                sp.user_id = $2
                OR l.owner_id = $2
                OR sr.list_id = ANY($1::uuid[])
              )
          `;
          const secretSantaParticipantsBaselineResult = await db.query(secretSantaParticipantsBaselineQuery, [listIdsArray, userId]);
          for (const row of secretSantaParticipantsBaselineResult.rows) {
            if (!row.list_id && row.round_list_id) {
              row.list_id = row.round_list_id;
            }
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            delete row.round_list_id;
            changes.secret_santa_round_participants.created.push(row);
          }

          const secretSantaPairingsBaselineQuery = `
            SELECT sp.*
            FROM public.secret_santa_pairings sp
            JOIN public.secret_santa_rounds sr ON sp.round_id = sr.id
            JOIN public.lists l ON sr.list_id = l.id
            WHERE (
                sp.giver_user_id = $2
                OR l.owner_id = $2
              )
              AND (sr.list_id = ANY($1::uuid[]) OR l.owner_id = $2 OR sr.created_by = $2)
          `;
          const secretSantaPairingsBaselineResult = await db.query(secretSantaPairingsBaselineQuery, [listIdsArray, userId]);
          for (const row of secretSantaPairingsBaselineResult.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            if (row.revealed_at) row.revealed_at = new Date(row.revealed_at).getTime();
            changes.secret_santa_pairings.created.push(row);
          }

          const secretSantaInvitesBaselineQuery = `
            SELECT gi.*
            FROM public.secret_santa_guest_invites gi
            JOIN public.secret_santa_rounds sr ON gi.round_id = sr.id
            JOIN public.lists l ON sr.list_id = l.id
            WHERE gi.deleted_at IS NULL
              AND (l.owner_id = $2 OR sr.list_id = ANY($1::uuid[]) OR sr.created_by = $2)
          `;
          const secretSantaInvitesBaselineResult = await db.query(secretSantaInvitesBaselineQuery, [listIdsArray, userId]);
          for (const row of secretSantaInvitesBaselineResult.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.secret_santa_guest_invites.created.push(row);
          }

          // Add gift status for initial sync
          const giftListsNotOwned = listsRes.rows.filter(l => l.list_type === 'gifts' && l.owner_id !== userId);
          if (giftListsNotOwned.length > 0) {
            const giftListIds = giftListsNotOwned.map(l => l.id);
            const reservationsByItem = new Map();
            const giftListIdSet = new Set(giftListIds.map(String));
            for (const row of reservationsRows) {
              if (!row.list_id || !giftListIdSet.has(String(row.list_id))) {
                continue;
              }
              const normalizedRow = {
                ...row,
                quantity: normalizeReservationQuantity(row.quantity),
              };
              const existing = reservationsByItem.get(row.item_id) || [];
              existing.push(normalizedRow);
              reservationsByItem.set(row.item_id, existing);
            }

            changes.list_items.created.forEach(item => {
              if (!giftListIds.includes(item.list_id)) return;
              const reservations = reservationsByItem.get(item.id);
              if (!reservations || reservations.length === 0) {
                return;
              }

              const itemForStatus = {
                ...item,
                gift_quantity: item.gift_quantity ?? item.quantity ?? 1,
              };

              const status = buildReservationResponse({
                item: itemForStatus,
                reservations,
                userId,
                isListOwner: false,
              });

              item.giftStatus = status;
            });
          }

          // Include user settings for initial sync
          const settingsRes = await db.query(
            `SELECT * FROM public.user_settings WHERE user_id = $1`,
            [userId]
          );
          if (settingsRes.rows.length > 0) {
            const settings = settingsRes.rows[0];
            if (settings.created_at) settings.created_at = new Date(settings.created_at).getTime();
            if (settings.updated_at) settings.updated_at = new Date(settings.updated_at).getTime();
            changes.user_settings.created.push(settings);
            logger.info(`[OptimizedSyncController] Including user_settings in initial sync for user ${userId}`);
          }

          logger.info(`[OptimizedSyncController] Initial sync for user ${userId}: ${listsRes.rows.length} lists, ${itemsRes.rows.length} items, ${settingsRes.rows.length} user_settings`);
        } catch (err) {
          logger.error('[OptimizedSyncController] Failed to fetch baseline data:', err);
        }
      }

      res.status(200).json({
        changes: changes,
        timestamp: Date.now(),
        optimization: 'v2_batch_fetch',
        records_processed: changeLogResult.rows.length
      });

    } catch (error) {
      logger.error('[OptimizedSyncController] Error pulling changes:', error);
      res.status(500).json({
        error: 'Server error pulling changes',
        details: error.message
      });
    }
  };

  /**
   * Get sync statistics for monitoring
   */
  const getSyncStats = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const statsQuery = `
        SELECT
          table_name,
          operation,
          COUNT(*) as change_count,
          MAX(created_at) as latest_change
        FROM public.change_log
        WHERE user_id = $1
          AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
        GROUP BY table_name, operation
        ORDER BY table_name, operation
      `;

      const result = await db.query(statsQuery, [userId]);

      res.status(200).json({
        user_id: userId,
        stats: result.rows,
        total_changes_24h: result.rows.reduce((sum, row) => sum + parseInt(row.change_count), 0)
      });

    } catch (error) {
      logger.error('[OptimizedSyncController] Error getting sync stats:', error);
      res.status(500).json({ error: 'Server error getting sync stats' });
    }
  };

  /**
   * Health check endpoint with performance metrics
   */
  const getHealthCheck = async (req, res) => {
    try {
      // Test database connection
      const dbResult = await db.query('SELECT 1 as healthy');

      // Get cache stats
      const cacheStats = syncOptimization.getStats();

      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: {
          connected: dbResult.rows.length > 0,
          status: 'healthy'
        },
        cache: {
          type: cacheStats.type,
          connected: cacheStats.connected,
          stats: cacheStats.stats,
          size: cacheStats.cacheSize,
          locks: cacheStats.lockCount
        },
        optimization: 'v2_batch_fetch'
      });

    } catch (error) {
      logger.error('[OptimizedSyncController] Health check failed:', error);
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  };

  return {
    handleGetChangesOptimized,
    getSyncStats,
    getHealthCheck
  };
}

module.exports = optimizedSyncControllerFactory;
