// server/src/controllers/SyncController.js
const db = require('../config/db'); // Ensure this path is correct
const ListService = require('../services/ListService'); // Import ListService
const { logger } = require('../utils/logger'); // Assuming logger is in utils
const EmbeddingService = require('../services/embeddingService'); // Import EmbeddingService
// Lazy-load spotifyService only when needed to avoid ESM import issues in tests
let spotifyService = null;
function getSpotifyServiceLazy() {
  if (!spotifyService) {
    try {
      // eslint-disable-next-line global-require
      spotifyService = require('../services/spotify-service');
    } catch (err) {
      // In test or environments without spotify deps, keep null
      spotifyService = null;
    }
  }
  return spotifyService;
}

// Define detail tables that are associated with records in the 'list_items' table
const DETAIL_TABLES_MAP = {
  movie: 'movie_details',
  book: 'book_details',
  place: 'place_details',
  spotify_item: 'spotify_item_details', // Assuming 'spotify_item' is the type used in 'list_items' table
  tv: 'tv_details', // Add TV details mapping
  gift: 'gift_details', // Add gift details mapping
};

function syncControllerFactory(socketService) {
  // Permission check: can user edit items on list?
  async function userCanEditList(client, userId, listId) {
    // Owner can edit
    const { rows: ownerRows } = await client.query('SELECT owner_id FROM public.lists WHERE id = $1 AND deleted_at IS NULL', [listId]);
    if (ownerRows.length === 0) return false;
    if (ownerRows[0].owner_id === userId) return true;

    // Per-user override grants edit if role is editor/admin
    const { rows: overrideRows } = await client.query(
      `SELECT 1 FROM public.list_user_overrides
       WHERE list_id = $2 AND user_id = $1 AND deleted_at IS NULL AND role IN ('editor','admin')
       LIMIT 1`,
      [userId, listId]
    );
    if (overrideRows.length > 0) return true;

    // Group role grants edit if user is member AND role is editor/admin AND list is attached to the group
    const { rows: roleRows } = await client.query(
      `SELECT 1
         FROM public.list_group_roles lgr
         JOIN public.list_sharing ls
           ON ls.list_id = lgr.list_id AND ls.shared_with_group_id = lgr.group_id AND ls.deleted_at IS NULL
         JOIN public.collaboration_group_members m
           ON m.group_id = lgr.group_id AND m.user_id = $1
        WHERE lgr.list_id = $2
          AND lgr.deleted_at IS NULL
          AND lgr.role IN ('editor','admin')
        LIMIT 1`,
      [userId, listId]
    );
    if (roleRows.length > 0) return true;

    // Per-group per-user override grants edit
    const { rows: perGroupOverrideRows } = await client.query(
      `SELECT 1
         FROM public.list_group_user_roles lgur
         WHERE lgur.list_id = $2 AND lgur.user_id = $1 AND lgur.deleted_at IS NULL AND lgur.role IN ('editor','admin')
         LIMIT 1`,
      [userId, listId]
    );
    if (perGroupOverrideRows.length > 0) return true;

    // Legacy list_sharing permissions ('edit','write','owner') also grant edit when member of that group
    const { rows: legacyRows } = await client.query(
      `SELECT 1
       FROM public.list_sharing ls
       JOIN public.collaboration_group_members m
         ON m.group_id = ls.shared_with_group_id AND m.user_id = $1
       WHERE ls.list_id = $2
         AND ls.deleted_at IS NULL
         AND (ls.permissions IS NULL OR ls.permissions IN ('edit','write','owner'))
       LIMIT 1`,
      [userId, listId]
    );
    return legacyRows.length > 0;
  }
  // Helper function to get the detail table name for a given item type
  const getDetailTableName = (itemType) => {
    return DETAIL_TABLES_MAP[itemType.toLowerCase()] || null;
  };

  // Helper function to notify group members about list changes
  async function notifyGroupMembersOfListChanges(results, userId) {
    try {
      // Collect affected list IDs and their operations from list_items changes
      const affectedLists = new Map(); // Map<listId, {operations: Set, deletedItemIds: Array}>
      
      for (const result of results) {
        if (result.tableName === 'list_items' && result.listId) {
          if (!affectedLists.has(result.listId)) {
            affectedLists.set(result.listId, { 
              operations: new Set(),
              deletedItemIds: []
            });
          }
          
          const listInfo = affectedLists.get(result.listId);
          
          // Track what operations were performed
          let operation = 'update';
          if (result.status === 'created' || result.operation === 'create') {
            operation = 'add';
          } else if (result.status === 'deleted' || result.operation === 'delete') {
            operation = 'delete';
            // Track the deleted item ID (use clientRecordId for delete operations)
            if (result.clientRecordId || result.itemId || result.id) {
              listInfo.deletedItemIds.push(result.clientRecordId || result.itemId || result.id);
            }
          } else if (result.status === 'updated' || result.operation === 'update') {
            operation = 'update';
          }
          listInfo.operations.add(operation);
        }
      }
      
      if (affectedLists.size === 0) {
        return; // No list_items changes to notify about
      }
      
      // For each affected list, check if it has groups and notify members
      for (const [listId, listInfo] of affectedLists) {
        const operations = listInfo.operations;
        // Get all group members who have access to this list (including group owners)
        const groupMembersQuery = `
          SELECT DISTINCT cgm.user_id
          FROM list_group_roles lgr
          JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
          WHERE lgr.list_id = $1 
            AND lgr.deleted_at IS NULL
            AND cgm.deleted_at IS NULL
            AND cgm.user_id != $2
          UNION
          SELECT DISTINCT cg.owner_id as user_id
          FROM list_group_roles lgr
          JOIN collaboration_groups cg ON lgr.group_id = cg.id
          WHERE lgr.list_id = $1 
            AND lgr.deleted_at IS NULL
            AND cg.deleted_at IS NULL
            AND cg.owner_id != $2
          UNION
          SELECT DISTINCT cgm.user_id
          FROM list_sharing ls
          JOIN collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
          WHERE ls.list_id = $1 
            AND ls.deleted_at IS NULL
            AND cgm.deleted_at IS NULL
            AND cgm.user_id != $2
          UNION
          SELECT DISTINCT cg.owner_id as user_id
          FROM list_sharing ls
          JOIN collaboration_groups cg ON ls.shared_with_group_id = cg.id
          WHERE ls.list_id = $1 
            AND ls.deleted_at IS NULL
            AND cg.deleted_at IS NULL
            AND cg.owner_id != $2
        `;
        
        const { rows: members } = await db.query(groupMembersQuery, [listId, userId]);
        
        // Notify each group member about the list update
        const operationsArray = Array.from(operations);
        for (const member of members) {
          const notificationData = { 
            listId: listId,
            updatedBy: userId,
            operations: operationsArray, // Include what operations were performed
            timestamp: Date.now()
          };
          
          // Include deleted item IDs for delete operations
          if (listInfo.deletedItemIds.length > 0) {
            notificationData.deletedItemIds = listInfo.deletedItemIds;
            // For backward compatibility, keep single itemId for single deletions
            if (listInfo.deletedItemIds.length === 1) {
              notificationData.itemId = listInfo.deletedItemIds[0];
            }
          }
          
          const deletedInfo = notificationData.deletedItemIds ? ` with ${notificationData.deletedItemIds.length} deleted items` : (notificationData.itemId ? ` itemId: ${notificationData.itemId}` : '');
          logger.info(`[SyncController] Notifying user ${member.user_id} about list ${listId} update (operations: ${operationsArray.join(', ')})${deletedInfo}`);
          socketService.notifyUser(member.user_id, 'list_update', notificationData);
        }
      }
    } catch (error) {
      logger.error('[SyncController] Error notifying group members:', error);
      // Don't throw - this is a non-critical operation
    }
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function fetchShareMetadataForLists(listIds = []) {
    const normalizedIds = Array.from(new Set(
      listIds
        .map((id) => (typeof id === 'string' ? id : String(id ?? '')))
        .filter((id) => UUID_REGEX.test(id))
    ));

    if (normalizedIds.length === 0) {
      return new Map();
    }

    const placeholders = normalizedIds;

    const [groupRoleResult, legacyShareResult, individualShareResult] = await Promise.all([
      db.query(
        `SELECT lgr.list_id::text AS list_id,
                lgr.group_id::text AS group_id,
                cg.name AS group_name
         FROM public.list_group_roles lgr
         LEFT JOIN public.collaboration_groups cg ON cg.id = lgr.group_id
         WHERE lgr.list_id = ANY($1::uuid[])
           AND lgr.deleted_at IS NULL
           AND (cg.deleted_at IS NULL OR cg.deleted_at IS NULL)`,
        [placeholders]
      ),
      db.query(
        `SELECT ls.list_id::text AS list_id,
                ls.shared_with_group_id::text AS group_id,
                cg.name AS group_name
         FROM public.list_sharing ls
         LEFT JOIN public.collaboration_groups cg ON cg.id = ls.shared_with_group_id
         WHERE ls.list_id = ANY($1::uuid[])
           AND ls.deleted_at IS NULL
           AND ls.shared_with_group_id IS NOT NULL`,
        [placeholders]
      ),
      db.query(
        `SELECT luo.list_id::text AS list_id,
                luo.user_id::text AS user_id
         FROM public.list_user_overrides luo
         WHERE luo.list_id = ANY($1::uuid[])
           AND luo.deleted_at IS NULL
           AND luo.role NOT IN ('blocked','inherit')`,
        [placeholders]
      ),
    ]);

    const metadataMap = new Map();

    const ensureEntry = (listId) => {
      if (!metadataMap.has(listId)) {
        metadataMap.set(listId, {
          groupIds: new Set(),
          groupDetails: new Map(),
          connectionIds: new Set(),
        });
      }
      return metadataMap.get(listId);
    };

    const processGroupRow = (row) => {
      if (!row || !row.list_id || !row.group_id) return;
      const entry = ensureEntry(row.list_id);
      entry.groupIds.add(row.group_id);
      if (!entry.groupDetails.has(row.group_id)) {
        entry.groupDetails.set(row.group_id, {
          id: row.group_id,
          name: row.group_name || null,
        });
      }
    };

    groupRoleResult.rows.forEach(processGroupRow);
    legacyShareResult.rows.forEach(processGroupRow);

    individualShareResult.rows.forEach((row) => {
      if (!row || !row.list_id || !row.user_id) return;
      const entry = ensureEntry(row.list_id);
      entry.connectionIds.add(row.user_id);
    });

    const result = new Map();
    metadataMap.forEach((value, key) => {
      result.set(key, {
        groupIds: Array.from(value.groupIds),
        groupDetails: Array.from(value.groupDetails.values()),
        connectionIds: Array.from(value.connectionIds),
      });
    });

    return result;
  }

  // Helper to determine the correct user identifier column for a given table
  const getUserIdentifierColumn = (tableName) => {
    if (tableName === 'list_items' || tableName === 'lists') {
      return 'owner_id';
    }
    if (tableName === 'collaboration_groups') {
      return 'owner_id';
    }
    if (tableName === 'collaboration_group_members') {
      return 'user_id';
    }
    if (tableName === 'list_sharing') {
      return 'shared_with_user_id';
    }
    if (tableName === 'user_settings') {
      return 'user_id';
    }
    if (tableName === 'users') {
      return 'id'; // Users table uses 'id' as its identifier
    }
    if (tableName === 'favorites' || tableName === 'favorite_categories' || tableName === 'favorite_notification_preferences') {
      return 'user_id'; // Favorites tables use 'user_id' as their identifier
    }
    if (tableName === 'favorite_sharing') {
      return 'shared_by_user_id'; // Favorite sharing uses 'shared_by_user_id' as its identifier
    }
    // Add 'followers' table
    if (tableName === 'followers') {
      return 'follower_id'; // The user performing the follow/unfollow action
    }
    // Add 'notifications' table
    if (tableName === 'notifications') {
      return 'user_id'; // The user receiving the notification
    }
    if (tableName === 'gift_reservations') {
      return 'reserved_by';
    }
    if (tableName === 'gift_purchase_groups') {
      return 'created_by';
    }
  if (tableName === 'gift_contributions') {
    return 'contributor_id';
  }
  // For any other table, including detail tables, we are saying there is no direct user identifier for the generic pull.
  // This means they won't be processed in the main loop of handleGetChanges for direct user-filtered updates/deletes.
  // logger.warn(`[SyncController] Table '${tableName}' will not be processed by user-identifier in handleGetChanges main loop.`);
  return null;
};

  const normalizeFavoriteTargetType = (rawType) => {
    const normalized = (rawType || '').toString().toLowerCase();
    if (normalized === 'list' || normalized === 'lists') return 'list';
    if (
      normalized === 'item' ||
      normalized === 'items' ||
      normalized === 'list_item' ||
      normalized === 'list_items'
    ) {
      return 'item';
    }
    return rawType;
  };

  async function enqueueFavoriteChangeForOwner(txnClient, ownerId, favoriteRecord, operation) {
    if (!ownerId || !favoriteRecord) return;
    if (String(ownerId) === String(favoriteRecord.user_id)) return;

    try {
      await txnClient.query(
        `INSERT INTO public.change_log (table_name, record_id, operation, user_id, change_data, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
        [
          'favorites',
          favoriteRecord.id,
          operation,
          ownerId,
          JSON.stringify({
            id: favoriteRecord.id,
            user_id: favoriteRecord.user_id,
            target_id: favoriteRecord.target_id,
            target_type: favoriteRecord.target_type,
            category_id: favoriteRecord.category_id,
            is_public: favoriteRecord.is_public,
            notes: favoriteRecord.notes,
            sort_order: favoriteRecord.sort_order,
            created_at: favoriteRecord.created_at,
            updated_at: favoriteRecord.updated_at,
            deleted_at: favoriteRecord.deleted_at,
          }),
        ]
      );
    } catch (changeLogError) {
      logger.error('[SyncController] Failed to enqueue favorite change for owner:', changeLogError);
    }
  }

  async function getFavoriteTargetContext(txnClient, targetId, rawTargetType) {
    const targetType = normalizeFavoriteTargetType(rawTargetType);
    let targetOwnerId = null;
    let targetListId = null;

    try {
      if (targetType === 'list' && targetId) {
        const { rows } = await txnClient.query(
          `SELECT owner_id FROM public.lists WHERE id = $1 LIMIT 1`,
          [targetId]
        );
        if (rows.length > 0) {
          targetOwnerId = rows[0].owner_id;
          targetListId = targetId;
        }
      } else if (targetType === 'item' && targetId) {
        const { rows } = await txnClient.query(
          `SELECT li.list_id, l.owner_id
             FROM public.list_items li
             LEFT JOIN public.lists l ON li.list_id = l.id
            WHERE li.id = $1
            LIMIT 1`,
          [targetId]
        );
        if (rows.length > 0) {
          targetListId = rows[0].list_id;
          targetOwnerId = rows[0].owner_id;
        }
      }
    } catch (contextError) {
      logger.error('[SyncController] Failed to resolve favorite target context:', contextError);
    }

    return {
      targetOwnerId: targetOwnerId || null,
      targetListId: targetListId || null,
      targetType: targetType || rawTargetType,
      targetId: targetId || null,
    };
  }

  // Helper function to process a single favorite creation or restoration
  async function processSingleFavoriteAddOrRestore(txnClient, userId, favDataFromPush) {
    const { id: clientProvidedId, target_id, target_type, category_id, is_public, notes, sort_order } = favDataFromPush;
    logger.debug(`[SyncController] processSingleFavoriteAddOrRestore called for user ${userId}, client ID ${clientProvidedId}, target ${target_id}, type ${target_type}`);

    if (!target_id || !target_type) {
        logger.warn(`[SyncController] processSingleFavoriteAddOrRestore: Missing target_id or target_type for client ID ${clientProvidedId}`);
        return { status: 'error_missing_target', error: 'Favorite must include target_id and target_type' };
    }

    const targetContext = await getFavoriteTargetContext(txnClient, target_id, target_type);

    // 1. Check for an *active* favorite for the same target
    const activeFavoriteQuery = `
        SELECT id FROM public.favorites
        WHERE user_id = $1 AND target_id = $2 AND target_type = $3 AND deleted_at IS NULL LIMIT 1`;
    const activeFavoriteResult = await txnClient.query(activeFavoriteQuery, [userId, target_id, target_type]);

    if (activeFavoriteResult.rows.length > 0) {
        const existingActiveId = activeFavoriteResult.rows[0].id;
        logger.info(`[SyncController] Active favorite found (id: ${existingActiveId}) for user ${userId}, target ${target_id}, type ${target_type}. Updating details.`);
        const updateActiveQuery = `
            UPDATE public.favorites
            SET category_id = $1, is_public = $2, notes = $3, sort_order = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5 RETURNING id`;
        await txnClient.query(updateActiveQuery, [category_id || null, is_public || false, notes || null, sort_order || 0, existingActiveId]);
        // Fetch record for change log propagation
        try {
          const { rows: favRows } = await txnClient.query(
            `SELECT id, user_id, target_id, target_type, category_id, is_public, notes, sort_order, created_at, updated_at, deleted_at
             FROM public.favorites WHERE id = $1`,
            [existingActiveId]
          );
          if (favRows.length > 0) {
            await enqueueFavoriteChangeForOwner(
              txnClient,
              targetContext.targetOwnerId,
              favRows[0],
              'update'
            );
          }
        } catch (logErr) {
          logger.error('[SyncController] Failed to enqueue favorite update for owner:', logErr);
        }
        // Even if client sent a new ID, we updated the existing one. Respond with the existing ID.
        return { status: 'updated_existing_active', serverId: existingActiveId, affectedRows: 1, ...targetContext };
    }

    // 2. Check for a *soft-deleted* favorite for the same target
    const softDeletedQuery = `
        SELECT id FROM public.favorites
        WHERE user_id = $1 AND target_id = $2 AND target_type = $3 AND deleted_at IS NOT NULL LIMIT 1 FOR UPDATE`;
    const softDeletedResult = await txnClient.query(softDeletedQuery, [userId, target_id, target_type]);

    if (softDeletedResult.rows.length > 0) {
        const existingSoftDeletedId = softDeletedResult.rows[0].id;
        logger.info(`[SyncController] Soft-deleted favorite found (id: ${existingSoftDeletedId}) for user ${userId}, target ${target_id}, type ${target_type}. Restoring.`);
        const restoreQuery = `
            UPDATE public.favorites
            SET deleted_at = NULL, category_id = $1, is_public = $2, notes = $3, sort_order = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5 RETURNING id`;
        await txnClient.query(restoreQuery, [category_id || null, is_public || false, notes || null, sort_order || 0, existingSoftDeletedId]);
        try {
          const { rows: favRows } = await txnClient.query(
            `SELECT id, user_id, target_id, target_type, category_id, is_public, notes, sort_order, created_at, updated_at, deleted_at
             FROM public.favorites WHERE id = $1`,
            [existingSoftDeletedId]
          );
          if (favRows.length > 0) {
            await enqueueFavoriteChangeForOwner(
              txnClient,
              targetContext.targetOwnerId,
              favRows[0],
              'update'
            );
          }
        } catch (logErr) {
          logger.error('[SyncController] Failed to enqueue favorite restore for owner:', logErr);
        }
        return { status: 'restored', serverId: existingSoftDeletedId, affectedRows: 1, ...targetContext };
    }

    // 3. No existing (active or soft-deleted) favorite for this target - insert new using client's provided ID
    logger.info(`[SyncController] No existing favorite found for user ${userId}, target ${target_id}, type ${target_type}. Inserting new with client ID ${clientProvidedId}.`);
    const insertQueryFields = ['id', 'user_id', 'target_id', 'target_type'];
    const insertValues = [clientProvidedId, userId, target_id, target_type];
    
    // Add other fields if present in favDataFromPush
    if (category_id !== undefined && category_id !== null) { insertQueryFields.push('category_id'); insertValues.push(category_id); }
    if (is_public !== undefined && is_public !== null) { insertQueryFields.push('is_public'); insertValues.push(is_public); }
    if (notes !== undefined && notes !== null) { insertQueryFields.push('notes'); insertValues.push(notes); }
    if (sort_order !== undefined && sort_order !== null) { insertQueryFields.push('sort_order'); insertValues.push(sort_order); }
    
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    const insertQuery = `
        INSERT INTO public.favorites (${insertQueryFields.join(', ')})
        VALUES (${placeholders})
        RETURNING id`;
    const insertResult = await txnClient.query(insertQuery, insertValues);
    const createdId = insertResult.rows[0].id;
    try {
      const { rows: favRows } = await txnClient.query(
        `SELECT id, user_id, target_id, target_type, category_id, is_public, notes, sort_order, created_at, updated_at, deleted_at
         FROM public.favorites WHERE id = $1`,
        [createdId]
      );
      if (favRows.length > 0) {
        await enqueueFavoriteChangeForOwner(
          txnClient,
          targetContext.targetOwnerId,
          favRows[0],
          'create'
        );
      }
    } catch (logErr) {
      logger.error('[SyncController] Failed to enqueue favorite create for owner:', logErr);
    }
    return { status: 'created', serverId: createdId, affectedRows: 1, ...targetContext };
  }

  // Helper function to get valid columns for a table to prevent SQL errors
  async function getTableColumns(client, tableName) {
    const query = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1;
    `;
    const result = await client.query(query, [tableName]);
    return result.rows.map(row => row.column_name);
  }

  /**
   * Handles pushing changes from the client to the server.
   * Processes created, updated, and deleted records for various tables.
   * Includes special logic for 'list_items' table to manage associated detail records.
   */
  const handlePush = async (req, res) => {
    const clientChangesArray = req.body.changes; // Assuming client sends { "changes": [...] }
    // If client sends the array directly as body, use: const clientChangesArray = req.body;
    const userId = req.user?.id;
    const results = []; // Initialize results array
    const favoriteNotifications = new Map(); // Map<ownerId:targetKey, payload>

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    if (!Array.isArray(clientChangesArray)) {
      logger.error('[SyncController] Push failed: req.body.changes is not an array. Received:', req.body);
      return res.status(400).json({ error: 'Invalid payload format: "changes" must be an array.' });
    }

    // console.log(`[SyncController] User ${userId} pushing ${clientChangesArray.length} changes. Current time: ${new Date().toISOString()}`);

    try {
      // Define the desired order of table operations to avoid foreign key violations
      const tableOrder = [
        'users',
        'lists',
        'list_items',
        'favorites',
        // Add other tables in an order that respects dependencies
      ];

      // Sort the changes array based on the defined table order
      clientChangesArray.sort((a, b) => {
        const aIndex = tableOrder.indexOf(a.table_name);
        const bIndex = tableOrder.indexOf(b.table_name);
        
        // If a table is not in the order list, it gets lower priority
        const effectiveAIndex = aIndex === -1 ? Infinity : aIndex;
        const effectiveBIndex = bIndex === -1 ? Infinity : bIndex;
        
        return effectiveAIndex - effectiveBIndex;
      });
      
      await db.transaction(async (client) => {
        for (const changeItem of clientChangesArray) {
          const { table_name: tableName, operation, record_id: clientRecordId, data } = changeItem;

          if (!operation || (!data && operation !== 'delete' && operation !== 'BATCH_LIST_ORDER_UPDATE' && operation !== 'BATCH_FAVORITES_UPDATE')) {
            logger.warn('[SyncController] Skipping invalid change item (missing operation or data for non-delete/batch operation):', changeItem);
            continue;
          }
          
          let tableUserIdentifierColumn = getUserIdentifierColumn(tableName);
          const isUserSettingsTable = tableName === 'user_settings';

          // Get valid columns for the table
          const validColumns = await getTableColumns(client, tableName);

          // --- FINAL ATTEMPT TO FIX DOUBLE-ENCODING ---
          // The entire data payload can arrive as a string. Parse it.
          let dataPayload = data;
          if (typeof dataPayload === 'string') {
            try {
              dataPayload = JSON.parse(dataPayload);
            } catch (e) {
              logger.warn(`[SyncController] Could not parse stringified 'data' payload for record ${clientRecordId}. Skipping.`);
              results.push({ id: clientRecordId, success: false, error: 'Malformed data payload' });
              continue; // Skip to the next change in the loop
            }
          }
          // --- END FIX ---

          // For most operations we require a data payload. For 'delete' we only
          // need the record_id, so allow an empty/undefined dataPayload when
          // operation === 'delete'.
          if (!dataPayload && operation !== 'delete') {
            logger.warn(`[SyncController] Skipping change with no data for record ${clientRecordId}`);
            continue;
          }

          // Handle BATCH_LIST_ORDER_UPDATE specifically
          if (operation === 'BATCH_LIST_ORDER_UPDATE') {
            if (tableName !== 'lists' && dataPayload.targetTable !== 'lists') { // Allow data.targetTable for flexibility
                 logger.warn(`[SyncController] BATCH_LIST_ORDER_UPDATE received for unexpected table: ${tableName || dataPayload.targetTable}. Skipping.`);
                 results.push({
                    operation,
                    clientRecordId: dataPayload.operationId || 'N/A', // Client might send an operationId for the batch
                    status: 'error_invalid_batch_table',
                    error: `Batch list order update is only for 'lists' table.`
                });
                continue;
            }
            const listOrders = Array.isArray(dataPayload.items) ? dataPayload.items : (Array.isArray(data) ? data : null);
            if (!listOrders) {
                logger.error('[SyncController] BATCH_LIST_ORDER_UPDATE missing or invalid items array in data:', dataPayload);
                results.push({
                    operation,
                    clientRecordId: dataPayload.operationId || 'N/A',
                    status: 'error_missing_batch_items',
                    error: 'BATCH_LIST_ORDER_UPDATE payload must contain an array of list orders in data.items or directly in data.'
                });
                continue;
            }
            try {
                logger.info(`[SyncController] Processing BATCH_LIST_ORDER_UPDATE for ${listOrders.length} lists.`);
                await ListService.batchUpdateListOrder(listOrders); // Assumes ListService is imported and available
                results.push({
                    operation,
                    clientRecordId: dataPayload.operationId || 'batch_success', // Use a general success ID or one from client
                    status: 'batch_updated',
                    message: `Successfully processed batch order update for ${listOrders.length} lists.`
                });
            } catch (batchError) {
                logger.error('[SyncController] Error processing BATCH_LIST_ORDER_UPDATE:', batchError);
                results.push({
                    operation,
                    clientRecordId: dataPayload.operationId || 'batch_error',
                    status: 'error_batch_processing',
                    error: batchError.message || 'Failed to process batch list order update.'
                });
            }
            continue; // Move to next change item
          }
          // Handle BATCH_FAVORITES_UPDATE
          else if (operation === 'BATCH_FAVORITES_UPDATE') {
            const favoriteItems = Array.isArray(dataPayload.items) ? dataPayload.items : null;
            if (!favoriteItems) {
              logger.error('[SyncController] BATCH_FAVORITES_UPDATE missing or invalid items array in data:', dataPayload);
              results.push({
                operation,
                clientRecordId: dataPayload.operationId || 'N/A',
                status: 'error_missing_batch_items',
                error: 'BATCH_FAVORITES_UPDATE payload must contain an array of favorite items in data.items.'
              });
              continue;
            }

            logger.info(`[SyncController] Processing BATCH_FAVORITES_UPDATE for ${favoriteItems.length} favorites.`);
            const batchResults = [];

            for (const favItem of favoriteItems) {
              console.log('[DEBUG] Processing favorite item action:', favItem.action); // Add this
              const { action, ...favoriteData } = favItem;
              const { id: clientFavId, target_id, target_type, category_id, is_public, notes, sort_order } = favoriteData;

              if (!action || !clientFavId || (!target_id && !target_type)) {
                logger.warn('[SyncController] BATCH_FAVORITES_UPDATE: Skipping invalid favorite item (missing action, id, or target):', favItem);
                batchResults.push({ clientRecordId: clientFavId, status: 'error_invalid_favorite_item', error: 'Missing action, id, or target' });
                continue;
              }

              try {
                if (action === 'add') {
                  // Check for an *active* favorite first (deleted_at IS NULL)
                  const activeFavoriteQuery = `
                    SELECT id FROM public.favorites
                    WHERE user_id = $1
                    AND target_id = $2
                    AND target_type = $3
                    AND deleted_at IS NULL
                    LIMIT 1
                  `;
                  const activeFavoriteResult = await client.query(activeFavoriteQuery, [userId, target_id, target_type]);

                  if (activeFavoriteResult.rows.length > 0) {
                    // Active favorite already exists - treat as no-op
                    logger.warn(`[SyncController] Favorite already exists for user ${userId} and target ${target_id}, type ${target_type}. Skipping.`);
                    batchResults.push({ clientRecordId: clientFavId, status: 'noop' });
                    continue;
                  }

                  // Check for a soft-deleted favorite to restore
                  const softDeletedQuery = `
                    SELECT id FROM public.favorites
                    WHERE user_id = $1
                    AND target_id = $2
                    AND target_type = $3
                    AND deleted_at IS NOT NULL
                    LIMIT 1
                    FOR UPDATE  -- Lock the row to prevent concurrent modifications
                  `;
                  const softDeletedResult = await client.query(softDeletedQuery, [userId, target_id, target_type]);

                  let favoriteId;
                  let recordStatus = 'created';

                  if (softDeletedResult.rows.length > 0) {
                    // Restore the soft-deleted favorite
                    const restoreQuery = `
                      UPDATE public.favorites
                      SET deleted_at = NULL, category_id = $4, is_public = $5, notes = $6, sort_order = $7, updated_at = CURRENT_TIMESTAMP
                      WHERE id = $1 AND user_id = $2 AND target_id = $3 AND target_type = $8
                      RETURNING id
                    `;
                    const restoreParams = [softDeletedResult.rows[0].id, userId, target_id, target_type, category_id || null, is_public || false, notes || null, sort_order || 0];
                    const restoreResult = await client.query(restoreQuery, restoreParams);
                    favoriteId = restoreResult.rows[0].id;
                    recordStatus = 'restored';
                  } else {
                    // No existing favorite (active or soft-deleted) - insert new
                    const insertQuery = `
                      INSERT INTO public.favorites (id, user_id, target_id, target_type, category_id, is_public, notes, sort_order, created_at, updated_at)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                      ON CONFLICT (user_id, target_id, target_type) WHERE deleted_at IS NULL
                      DO UPDATE SET 
                        deleted_at = NULL,
                        category_id = EXCLUDED.category_id,
                        is_public = EXCLUDED.is_public,
                        notes = EXCLUDED.notes,
                        sort_order = EXCLUDED.sort_order,
                        updated_at = EXCLUDED.updated_at
                      RETURNING id
                    `;
                    const insertParams = [clientFavId, userId, target_id, target_type, category_id || null, is_public || false, notes || null, sort_order || 0];
                    const insertResult = await client.query(insertQuery, insertParams);
                    favoriteId = insertResult.rows[0].id;
                  }

                  // Sync tracking is now handled automatically by database triggers
                  if (recordStatus !== 'noop') {
                    batchResults.push({ clientRecordId: clientFavId, serverId: favoriteId, status: recordStatus });
                  }

                  // Queue embedding generation for favorite within batch operation
                  try {
                    await EmbeddingService.queueEmbeddingGeneration(
                      favoriteId,
                      'favorite',
                      {
                        operation: recordStatus === 'created' ? 'create' : 'update',
                        priority: recordStatus === 'created' ? 'high' : 'normal'
                      }
                    );
                    logger.info(`[SyncController] Queued embedding generation for favorites/${favoriteId} (batch)`);
                  } catch (embeddingError) {
                    logger.error(`[SyncController] Failed to queue embedding generation for favorites/${favoriteId} (batch):`, embeddingError);
                  }
                } else if (action === 'delete') {
                  console.log(`[SyncController] BATCH_FAVORITES_UPDATE: Deleting favorite item ${clientFavId} for user ${userId}`);
                  // Soft delete
                  const deleteQuery = `
                    UPDATE public.favorites
                    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1 AND user_id = $2 AND target_id = $3 AND target_type = $4
                    RETURNING id
                  `;
                  console.log('Executing soft-delete query:', deleteQuery, [clientFavId, userId, target_id, target_type]); // Debug log
                  const deleteResult = await client.query(deleteQuery, [clientFavId, userId, target_id, target_type]);
                  console.log('Soft-delete result:', deleteResult.rows); // Debug log
                  if (deleteResult.rows.length > 0) {
                    batchResults.push({ clientRecordId: clientFavId, serverId: deleteResult.rows[0].id, status: 'deleted' });
                    // Sync tracking is now handled automatically by database triggers
                    
                    // Soft-delete embedding row (set deleted_at, reduce weight)
                    try {
                      await EmbeddingService.deactivateEmbedding(deleteResult.rows[0].id, 'favorite');
                      logger.info(`[SyncController] Deactivated embedding for favorites/${deleteResult.rows[0].id}`);
                    } catch (embErr) {
                      logger.error(`[SyncController] Failed to deactivate embedding for favorites/${deleteResult.rows[0].id}`, embErr);
                    }
                  } else {
                    batchResults.push({ clientRecordId: clientFavId, status: 'error_not_found_or_not_owner' });
                  }
                } else {
                  logger.warn(`[SyncController] BATCH_FAVORITES_UPDATE: Unknown action '${action}' for favorite item:`, favItem);
                  batchResults.push({ clientRecordId: clientFavId, status: 'error_unknown_action', error: `Unknown action: ${action}` });
                }
              } catch (favError) {
                logger.error(`[SyncController] BATCH_FAVORITES_UPDATE: Error processing favorite item ${clientFavId}:`, favError);
                batchResults.push({ clientRecordId: clientFavId, status: 'error_processing_item', error: favError.message });
              }
            }
            results.push({
              operation,
              clientRecordId: dataPayload.operationId || 'batch_favorites_processed',
              status: 'batch_processed',
              itemResults: batchResults
            });
            continue; // Move to next change item
          }
          // Handle USER_SETTINGS table (create / update / delete)
          else if (tableName === 'user_settings') {
            try {
              if (dataPayload && dataPayload.user_id && dataPayload.user_id !== userId) {
                logger.warn(`[SyncController] Ignoring user_settings change for mismatched user_id ${dataPayload.user_id} (auth user ${userId})`);
                results.push({
                  tableName,
                  operation,
                  clientRecordId: clientRecordId || dataPayload.user_id,
                  status: 'error_user_mismatch',
                  error: 'user_id in payload does not match authenticated user.'
                });
                continue;
              }

              if (operation === 'delete') {
                const delRes = await client.query(
                  `UPDATE public.user_settings SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND deleted_at IS NULL`,
                  [userId]
                );
                results.push({
                  tableName,
                  operation,
                  clientRecordId: userId,
                  status: delRes.rowCount > 0 ? 'deleted' : 'noop_or_not_found'
                });
              } else if (operation === 'create' || operation === 'update') {
                // Build columns / values dynamically from data
                const allowedCols = [
                  'user_id',
                  'theme',
                  'notification_preferences',
                  'privacy_settings',
                  'lists_header_background_type',
                  'lists_header_background_value',
                  'lists_header_image_url',
                  'social_networks',
                  'misc_settings',
                  'updated_at'
                ];
                const cols = [];
                const vals = [];
                Object.keys(dataPayload || {}).forEach((k) => {
                  if (allowedCols.includes(k)) {
                    cols.push(k);
                    vals.push(dataPayload[k]);
                  }
                });
                if (!cols.includes('user_id')) {
                  cols.unshift('user_id');
                  vals.unshift(userId);
                }
                if (!cols.includes('updated_at')) {
                  cols.push('updated_at');
                  vals.push(new Date().toISOString());
                }

                const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
                const updateAssignments = cols.filter(c => c !== 'user_id').map((c, idx) => `${c} = EXCLUDED.${c}`).join(', ');

                const upsertQuery = `INSERT INTO public.user_settings (${cols.join(', ')}) VALUES (${placeholders})
                  ON CONFLICT (user_id) DO UPDATE SET ${updateAssignments}`;
                await client.query(upsertQuery, vals);

                results.push({
                  tableName,
                  operation,
                  clientRecordId: userId,
                  status: operation === 'create' ? 'created' : 'updated'
                });
              } else {
                results.push({ tableName, operation, clientRecordId: userId, status: 'error_invalid_operation' });
              }
            } catch (settingsErr) {
              logger.error('[SyncController] Error processing user_settings change:', settingsErr);
              results.push({
                tableName,
                operation,
                clientRecordId: clientRecordId || userId,
                status: 'error',
                error: settingsErr.message || 'Exception during user_settings processing'
              });
            }
            continue; // move to next change item
          }
          // START ---- NEW LOGIC FOR SINGLE FAVORITE CREATE ---- START
          else if (tableName === 'favorites' && operation === 'create') {
            logger.info(`[SyncController] Processing single favorite create for clientRecordId: ${clientRecordId}`);
            try {
                const favoriteDataPayload = { ...dataPayload, id: clientRecordId };
                
                const result = await processSingleFavoriteAddOrRestore(client, userId, favoriteDataPayload);
                results.push({ 
                    operation, 
                    tableName, 
                    clientRecordId,
                    serverId: result.serverId,
                    status: result.status, 
                    affectedRows: result.affectedRows,
                    error: result.error 
                });

                if (result.serverId && (result.status === 'created' || result.status === 'restored' || result.status === 'updated_existing_active')) {
                    let syncOperation = 'create';
                    if (result.status === 'restored' || result.status === 'updated_existing_active') {
                        syncOperation = 'update';
                    }
                    // Sync tracking is now handled automatically by database triggers

                    // Queue embedding generation for favorite
                    try {
                        await EmbeddingService.queueEmbeddingGeneration(
                            result.serverId,
                            'favorite',
                            {
                                operation: syncOperation,
                                priority: syncOperation === 'create' ? 'high' : 'normal'
                            }
                        );
                        logger.info(`[SyncController] Queued embedding generation for favorites/${result.serverId}`);
                    } catch (embeddingError) {
                        logger.error(`[SyncController] Failed to queue embedding generation for favorites/${result.serverId}:`, embeddingError);
                    }
                } else if (!result.serverId) {
                    logger.warn(`[SyncController] Sync tracking not added for favorite create op for client ID ${clientRecordId} due to missing serverId in result.`);
                } else {
                    logger.info(`[SyncController] Sync tracking not added for favorite create op for client ID ${clientRecordId} due to status: ${result.status}`);
                }

                if (result.targetOwnerId && result.targetOwnerId !== userId) {
                    const notificationKey = `${result.targetOwnerId}:${result.targetType}:${result.targetId || 'unknown'}`;
                    const operationForOwner =
                        result.status === 'created'
                            ? 'create'
                            : result.status === 'restored'
                                ? 'restore'
                                : 'update';

                    favoriteNotifications.set(notificationKey, {
                        ownerId: result.targetOwnerId,
                        listId: result.targetListId || (result.targetType === 'list' ? result.targetId : null),
                        targetType: result.targetType,
                        targetId: result.targetId,
                        favoriteId: result.serverId,
                        actorId: userId,
                        operation: operationForOwner,
                    });
                }
            } catch (favError) {
                logger.error(`[SyncController] Error in single favorite create for client ID ${clientRecordId}:`, favError);
                results.push({ 
                    operation, 
                    tableName, 
                    clientRecordId, 
                    status: 'error_processing_fav_create', 
                    error: favError.message 
                });
            }
            continue; // Move to next change item
          }
          // END ---- NEW LOGIC FOR SINGLE FAVORITE CREATE ---- END
          
          // More general handling for other tables
          if (operation === 'create') {
            console.log('create', [operation, tableName, changeItem]);
            const createData = { ...dataPayload };
            // Ensure ID is present for creation
            if (!createData.id) {
              logger.warn(`[SyncController] Skipping create for table '${tableName}': missing 'id'.`, dataPayload);
              continue;
            }

            // Enforce collaboration permissions for list_items create
            if (tableName === 'list_items' && createData.list_id) {
              const targetListId = createData.list_id || createData.list_server_id;
              if (targetListId) {
                const allowed = await userCanEditList(client, userId, targetListId);
                if (!allowed) {
                  results.push({ tableName, operation, clientRecordId, status: 'error_forbidden', error: 'Not allowed to add items to this list' });
                  continue;
                }
              }
            }

            // For list_items, parse custom_fields if it's a string
            if (tableName === 'list_items' && typeof createData.custom_fields === 'string') {
              try {
                createData.custom_fields = JSON.parse(createData.custom_fields);
              } catch (e) {
                logger.error(`[SyncController] Error parsing custom_fields for create in '${tableName}':`, e);
                // Decide how to handle - skip, or insert with null custom_fields?
                // For now, we'll set it to null and log the error.
                createData.custom_fields = null; 
              }
            }

            // NEW: Also parse api_metadata if it's a string for list_items
            if (tableName === 'list_items' && typeof createData.api_metadata === 'string') {
              try {
                createData.api_metadata = JSON.parse(createData.api_metadata);
              } catch (e) {
                logger.error(`[SyncController] Error parsing api_metadata for create in '${tableName}':`, e);
                createData.api_metadata = null;
              }
            }

            // Immediately after ensuring createData.id exists
            if (tableName === 'list_items') {
              // 1) If they’re strings that look like JSON we keep them as-is.
              // 2) If they’re JS objects/arrays we stringify them.
              ['custom_fields', 'api_metadata'].forEach(col => {
                if (createData[col] && typeof createData[col] !== 'string') {
                  try {
                    createData[col] = JSON.stringify(createData[col]);
                  } catch (e) {
                    logger.error(`[SyncController] Failed to stringify ${col} for list_items:`, e);
                    createData[col] = 'null';          // valid JSON sentinel
                  }
                }
              });
            }

            // Filter out fields that don't exist in the table
            const filteredData = Object.keys(createData)
              .filter(key => validColumns.includes(key))
              .reduce((obj, key) => {
                obj[key] = createData[key];
                return obj;
              }, {});

            const fields = Object.keys(filteredData);
            const placeholders = fields.map((field, i) => {
              const base = `$${i + 1}`;
              if (
                (tableName === 'list_items' && (field === 'custom_fields' || field === 'api_metadata')) ||
                (tableName === 'lists' && field === 'background')
              ) {
                return `${base}::jsonb`;
              }
              return base;
            }).join(', ');
            
            // For lists.background ensure value is stringified JSON
            if (tableName === 'lists' && filteredData.background && typeof filteredData.background !== 'string') {
              filteredData.background = JSON.stringify(filteredData.background);
            }

            const values = fields.map(field => filteredData[field]);
            let insertResult;
            let creationStatus = 'created';
            if (tableName === 'item_tags') {
              // Expecting composite pk (item_id, tag_id) plus optional source column
              const idxItem   = fields.indexOf('item_id');
              const idxTag    = fields.indexOf('tag_id');
              const idxSource = fields.indexOf('source');
              const idxDel    = fields.indexOf('deleted_at');

              const hasSource = idxSource !== -1;
              const orderedVals = hasSource
                ? [values[idxItem], values[idxTag] ?? null, values[idxSource] ?? 'user', values[idxDel] ?? null]
                : [values[idxItem], values[idxTag] ?? null, values[idxDel] ?? null];

              const upsertQuery = hasSource
                ? `INSERT INTO "item_tags" (item_id, tag_id, source, deleted_at)
                   VALUES ($1,$2,$3,$4)
                   ON CONFLICT (item_id, tag_id) DO UPDATE SET source = EXCLUDED.source, deleted_at = EXCLUDED.deleted_at
                   RETURNING item_id`
                : `INSERT INTO "item_tags" (item_id, tag_id, deleted_at)
                   VALUES ($1,$2,$3)
                   ON CONFLICT (item_id, tag_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at
                   RETURNING item_id`;

              insertResult = await client.query(upsertQuery, orderedVals);
            } else if (tableName === 'list_item_categories') {
              // unique by item_id
              const idxItem = fields.indexOf('item_id');
              const idxCat = fields.indexOf('category_id');
              const idxDel = fields.indexOf('deleted_at');
              const orderedVals = [values[idxItem], values[idxCat] ?? null, values[idxDel] ?? null];
              const upsertQuery = `INSERT INTO "list_item_categories" (item_id, category_id, deleted_at)
                VALUES ($1,$2,$3)
                ON CONFLICT (item_id) DO UPDATE SET category_id = EXCLUDED.category_id, deleted_at = EXCLUDED.deleted_at
                RETURNING item_id`;
              insertResult = await client.query(upsertQuery, orderedVals);
            } else if (tableName === 'tags') {
              // Maintain id from client; upsert to avoid duplicate key on primary id
              const idxId       = fields.indexOf('id');
              const idxListType = fields.indexOf('list_type');
              const idxName     = fields.indexOf('name');
              const idxType     = fields.indexOf('tag_type');
              const idxSystem   = fields.indexOf('is_system');
              const idxDeleted  = fields.indexOf('deleted_at');

              const ordered = [
                values[idxId],
                values[idxListType] ?? null,
                values[idxName],
                values[idxType] ?? 'tag',
                values[idxSystem] ?? false,
                values[idxDeleted] ?? null,
              ];

              const upsertSql = `INSERT INTO public.tags (id, list_type, name, tag_type, is_system, deleted_at)
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (id) DO UPDATE SET
                  list_type = EXCLUDED.list_type,
                  name      = EXCLUDED.name,
                  tag_type  = EXCLUDED.tag_type,
                  is_system = EXCLUDED.is_system,
                  deleted_at= EXCLUDED.deleted_at,
                  updated_at = CURRENT_TIMESTAMP
                RETURNING id`;
              insertResult = await client.query(upsertSql, ordered);
            } else if (tableName === 'lists') {
              const { rows: existingRows } = await client.query(
                'SELECT 1 FROM public.lists WHERE id = $1 LIMIT 1',
                [filteredData.id]
              );
              const listAlreadyExists = existingRows.length > 0;
              const updateAssignments = fields
                .filter(field => field !== 'id' && field !== 'created_at')
                .map(field => `"${field}" = EXCLUDED."${field}"`);

              if (!fields.includes('updated_at')) {
                updateAssignments.push('updated_at = CURRENT_TIMESTAMP');
              }

              const upsertQuery = `INSERT INTO "lists" (${fields.map(f => `"${f}"`).join(', ')})
                VALUES (${placeholders})
                ON CONFLICT (id) DO UPDATE SET ${updateAssignments.join(', ')}
                RETURNING id`;

              insertResult = await client.query(upsertQuery, values);
              creationStatus = listAlreadyExists ? 'updated' : 'created';
            } else if (tableName === 'list_items') {
              const { rows: existingRows } = await client.query(
                'SELECT 1 FROM public.list_items WHERE id = $1 LIMIT 1',
                [filteredData.id]
              );
              const itemAlreadyExists = existingRows.length > 0;

              const updateAssignments = fields
                .filter(field => field !== 'id' && field !== 'created_at')
                .map(field => {
                  if (field === 'custom_fields' || field === 'api_metadata') {
                    return `"${field}" = EXCLUDED."${field}"::jsonb`;
                  }
                  return `"${field}" = EXCLUDED."${field}"`;
                });

              if (!fields.includes('updated_at')) {
                updateAssignments.push('updated_at = CURRENT_TIMESTAMP');
              }

              const upsertQuery = `INSERT INTO "list_items" (${fields.map(f => `"${f}"`).join(', ')})
                VALUES (${placeholders})
                ON CONFLICT (id) DO UPDATE SET ${updateAssignments.join(', ')}
                RETURNING id`;

              insertResult = await client.query(upsertQuery, values);
              creationStatus = itemAlreadyExists ? 'updated' : 'created';
            } else {
              const insertQuery = `INSERT INTO "${tableName}" (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING id`;
              insertResult = await client.query(insertQuery, values);
            }
            const insertedId = insertResult.rows[0].id || insertResult.rows[0].item_id;

            // --- Spotify raw details persistence ---
            if (tableName === 'list_items') {
              try {
                if (createData && createData.api_source === 'spotify') {
                  const spotifyId = createData.source_id || createData.item_id_from_api;
                  if (spotifyId) {
                    const raw = createData.api_metadata ? (typeof createData.api_metadata === 'string' ? createData.api_metadata : JSON.stringify(createData.api_metadata)) : null;
                    await client.query(
                      `INSERT INTO public.spotify_item_details (id, spotify_id, raw_json)
                       VALUES ($1,$2,$3)
                       ON CONFLICT (spotify_id) DO UPDATE
                         SET raw_json = EXCLUDED.raw_json, updated_at = CURRENT_TIMESTAMP`,
                      [insertedId, spotifyId, raw]
                    );
                  }
                }
              } catch (spErr) {
                logger.error('[SyncController] Failed upserting spotify_item_details:', spErr);
              }
            }

            // ----- Embedding queue hooks -----
            try {
              // Only enqueue generically for item_tags; list_items enqueued below in post-processing to ensure correct timing
              if (tableName === 'item_tags') {
                const targetItemId = createData.item_id || values[fields.indexOf('item_id')];
                if (targetItemId) {
                  await EmbeddingService.queueEmbeddingGeneration(targetItemId, 'list_item', { reason: `${tableName}_${operation}` });
                }
              }
            } catch (embedErr) {
              logger.error('[SyncController] Failed to enqueue embedding generation:', embedErr);
            }

            // ---- Post-processing specific to list_items ----
            if (tableName === 'list_items') {
              try {
                // Determine detail table based on api_source or list_type
                let sourceType = (createData.api_source || '').toLowerCase();
                // If api_source is missing, fall back to the parent list's `type` column
                if (!sourceType && createData.list_id) {
                  try {
                    // Determine which column exists without causing transaction-abort errors
                    const { rows: colRows } = await client.query(`
                      SELECT column_name FROM information_schema.columns
                      WHERE table_name = 'lists' AND column_name IN ('list_type', 'type')
                    `);
                    const hasListType = colRows.some(r => r.column_name === 'list_type');
                    const colName = hasListType ? 'list_type' : 'type';
                    const { rows: listRows } = await client.query(`SELECT ${colName} AS lstype FROM lists WHERE id = $1`, [createData.list_id]);
                    if (listRows[0] && listRows[0].lstype) {
                      sourceType = String(listRows[0].lstype).toLowerCase();
                      logger.debug(`[SyncController] Derived sourceType "${sourceType}" from parent list ${createData.list_id} (column: ${colName})`);
                    }
                  } catch (lookupErr) {
                    logger.error('[SyncController] Failed to derive sourceType from parent list:', lookupErr);
                  }
                }
                let detailTable = null;
                let detailIdColumn = null;
                logger.info(`[SyncController] CREATE: Processing item with sourceType: '${sourceType}' for list_items creation`);
                switch (sourceType) {
                  case 'movie':
                  case 'movies':
                    detailTable = 'movie_details';
                    detailIdColumn = 'movie_detail_id';
                    break;
                  case 'book':
                  case 'books':
                    detailTable = 'book_details';
                    detailIdColumn = 'book_detail_id';
                    break;
                  case 'music':
                  case 'songs':
                  case 'track':
                  case 'tracks':
                    detailTable = 'music_details';
                    detailIdColumn = 'music_detail_id';

                    // --- NEW: enrich api_metadata with genres from Spotify ---
                    try {
                      const svc = getSpotifyServiceLazy();
                      if (!svc) throw new Error('spotify service unavailable');
                      let metaObj = {};
                      if (createData.api_metadata) {
                        metaObj = typeof createData.api_metadata === 'string' ? JSON.parse(createData.api_metadata) : createData.api_metadata;
                      }
                      if (!metaObj.genres || metaObj.genres.length === 0) {
                        const sourceId = metaObj.source_id || createData.source_id || null;
                        if (sourceId) {
                          const genres = await svc.fetchGenres(sourceId, 'track');
                          if (genres && genres.length) {
                            metaObj.genres = genres.map(g => ({ name: g }));
                            const str = JSON.stringify(metaObj);
                            await client.query('UPDATE list_items SET api_metadata = $1 WHERE id = $2', [str, insertedId]);
                            createData.api_metadata = str; // keep consistency for detail record creation
                          }
                        }
                      }
                    } catch (spotifyErr) {
                      logger.error('[SyncController] Spotify genre fetch failed:', spotifyErr);
                    }
                    break;
                  case 'place':
                  case 'places':
                    detailTable = 'place_details';
                    detailIdColumn = 'place_detail_id';
                    break;
                  case 'recipe':
                  case 'recipes':
                    detailTable = 'recipe_details';
                    detailIdColumn = 'recipe_detail_id';
                    break;
                  case 'tv':
                  case 'television':
                    detailTable = 'tv_details';
                    detailIdColumn = 'tv_detail_id';
                    break;
                  case 'gift':
                  case 'gifts':
                    logger.info('[SyncController] CREATE: Detected gift list type - will create gift_details');
                    logger.info('[SyncController] CREATE: Gift item data:', JSON.stringify(createData));
                    detailTable = 'gift_details';
                    detailIdColumn = 'gift_detail_id';
                    break;
                  default:
                    // Unknown or custom list types will skip detail creation
                    break;
                }

                if (detailTable && detailIdColumn) {
                  logger.info(`[SyncController] CREATE: Creating detail record in table: ${detailTable}`);
                  // Prioritize the 'raw' field for place_details, as it contains the full object
                  // needed by the ListService, whereas api_metadata might be partial.
                  // For gift_details, use the item data directly
                  const detailSource = detailTable === 'gift_details' ? createData : 
                                     (detailTable === 'place_details' && createData.raw) ? createData.raw : createData.api_metadata;
                  logger.info(`[SyncController] CREATE: Detail source for ${detailTable}:`, typeof detailSource === 'string' ? detailSource : JSON.stringify(detailSource));

                  const detailRec = await ListService.createDetailRecord(
                    client,
                    detailTable,
                    detailSource,
                    insertedId,
                    createData
                  );

                  if (detailRec && detailRec.id) {
                    // Patch list_items row with the FK to details
                    await client.query(
                      `UPDATE list_items SET ${detailIdColumn} = $1 WHERE id = $2`,
                      [detailRec.id, insertedId]
                    );
                  }
                }

                // Queue embedding generation for the new list item
                try {
                  await EmbeddingService.queueEmbeddingGeneration(
                    insertedId,
                    'list_item',
                    { operation: 'create', priority: 'high' }
                  );
                  logger.info(`[SyncController] Queued embedding generation for list_items/${insertedId}`);
                } catch (embErr) {
                  logger.error(`[SyncController] Failed to queue embedding for list_items/${insertedId}:`, embErr);
                }
              } catch (detailErr) {
                logger.error('[SyncController] Error post-processing list_item create:', detailErr);
              }
            }
            // ---- End list_items post-processing ----

            results.push({
              tableName,
              operation,
              clientRecordId,
              status: creationStatus,
              serverId: insertedId,
              listId: tableName === 'list_items' ? (createData.list_id || createData.list_server_id) : undefined
            });

          } else if (operation === 'update') {
            const updateData = { ...dataPayload };
            const recordId = clientRecordId || updateData.id;
            let updateListId = undefined; // Store list_id for notifications

            // Enforce collaboration permissions for list_items update
            if (tableName === 'list_items') {
              const { rows: liRows } = await client.query('SELECT list_id FROM public.list_items WHERE id = $1', [recordId]);
              if (liRows.length === 0) {
                results.push({ tableName, operation, clientRecordId: recordId, status: 'error_not_found' });
                continue;
              }
              updateListId = liRows[0].list_id; // Store for later use
              const allowed = await userCanEditList(client, userId, updateListId);
              if (!allowed) {
                results.push({ tableName, operation, clientRecordId: recordId, status: 'error_forbidden', error: 'Not allowed to edit items on this list' });
                continue;
              }
            }

            if (!recordId) {
                logger.warn(`[SyncController] Skipping update for table '${tableName}': missing 'record_id' or 'data.id'.`, changeItem);
                continue;
            }
            
            // For list_items, parse custom_fields if it's a string
            if (tableName === 'list_items') {
                ['custom_fields', 'api_metadata'].forEach(col => {
                    if (updateData[col] && typeof updateData[col] === 'object') {
                        updateData[col] = JSON.stringify(updateData[col]);
                    }
                });
            }

            // Remove id from the update payload itself
            delete updateData.id; 

            // Filter out fields that don't exist in the table
            const filteredData = Object.keys(updateData)
              .filter(key => validColumns.includes(key))
              .reduce((obj, key) => {
                obj[key] = updateData[key];
                return obj;
              }, {});
            
            const fieldsToUpdate = Object.keys(filteredData);
            if (fieldsToUpdate.length === 0) {
              logger.warn(`[SyncController] Skipping update for '${tableName}' ID ${recordId}: No valid fields to update after filtering.`);
              continue;
            }
            
            // For lists, cast background as jsonb when updating
            const setClauses = fieldsToUpdate.map((field, i) => {
                const base = `$${i + 1}`;
                if (tableName === 'lists' && field === 'background') {
                    return `"${field}" = ${base}::jsonb`;
                }
                if (tableName === 'list_items' && (field === 'custom_fields' || field === 'api_metadata')) {
                    return `"${field}" = ${base}::jsonb`;
                }
                return `"${field}" = ${base}`;
            }).join(', ');

            // Stringify lists.background for update
            if (tableName === 'lists' && updateData.background && typeof updateData.background !== 'string') {
              updateData.background = JSON.stringify(updateData.background);
            }

            const queryValues = fieldsToUpdate.map(field => filteredData[field]);

            // Only append automatic timestamp update if client did NOT include updated_at
            const needsTimestamp = !fieldsToUpdate.includes('updated_at');
            const updateQuery = `UPDATE "${tableName}" SET ${setClauses}${needsTimestamp ? ', updated_at = CURRENT_TIMESTAMP' : ''} WHERE id = $${fieldsToUpdate.length + 1}`;
            logger.error(
              '[DEBUG-JSON] about to UPDATE list_items',
              JSON.stringify(filteredData, null, 2)
            );
            await client.query(updateQuery, [...queryValues, recordId]);

            // ---- Spotify raw-details upsert on UPDATE ----
            if (tableName === 'list_items' && updateData.api_source === 'spotify') {
              const spotifyId = updateData.source_id || updateData.item_id_from_api;
              if (spotifyId) {
                const rawJson = updateData.api_metadata
                  ? (typeof updateData.api_metadata === 'string'
                      ? updateData.api_metadata
                      : JSON.stringify(updateData.api_metadata))
                  : null;

                await client.query(
                  `INSERT INTO public.spotify_item_details (id, spotify_id, raw_json)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (spotify_id)
                   DO UPDATE SET raw_json = EXCLUDED.raw_json, updated_at = CURRENT_TIMESTAMP`,
                  [updateData.id, spotifyId, rawJson]
                );
              }
            }

            // ---- Generic detail record ensure/upsert (any api_source) ----
            if (tableName === 'list_items') {
              try {
                let sourceType = (updateData.api_source || '').toLowerCase();

                // If api_source missing fall back to the parent list's list_type/type
                if (!sourceType && updateData.list_id) {
                  try {
                    const { rows: colRows } = await client.query(
                      `SELECT column_name FROM information_schema.columns
                       WHERE table_name = 'lists' AND column_name IN ('list_type','type')`
                    );
                    const hasListType = colRows.some(r => r.column_name === 'list_type');
                    const colName = hasListType ? 'list_type' : 'type';
                    const { rows: listRows } = await client.query(
                      `SELECT ${colName} AS lstype FROM lists WHERE id = $1`,
                      [updateData.list_id]
                    );
                    if (listRows[0] && listRows[0].lstype) {
                      sourceType = String(listRows[0].lstype).toLowerCase();
                    }
                  } catch (lookupErr) {
                    logger.error('[SyncController] Failed to derive sourceType in update branch:', lookupErr);
                  }
                }

                // Map to detail table / fk column
                let detailTable = null;
                logger.info(`[SyncController] UPDATE: Processing item with sourceType: '${sourceType}' for list_items update`);
                switch (sourceType) {
                  case 'movie':
                  case 'movies':
                    detailTable = 'movie_details';
                    break;
                  case 'book':
                  case 'books':
                    detailTable = 'book_details';
                    break;
                  case 'music':
                  case 'songs':
                  case 'track':
                  case 'tracks':
                    detailTable = 'music_details';
                    break;
                  case 'place':
                  case 'places':
                    detailTable = 'place_details';
                    break;
                  case 'recipe':
                  case 'recipes':
                    detailTable = 'recipe_details';
                    break;
                  case 'tv':
                  case 'television':
                    detailTable = 'tv_details';
                    break;
                  case 'gift':
                  case 'gifts':
                    logger.info('[SyncController] UPDATE: Detected gift list type - will ensure gift_details');
                    logger.info('[SyncController] UPDATE: Gift item data:', JSON.stringify(updateData));
                    detailTable = 'gift_details';
                    break;
                  default:
                    break; // Unknown/custom types => skip
                }

                 if (detailTable) {
                  // Ensure a detail row exists – ListService.createDetailRecord is idempotent (ON CONFLICT list_item_id)
                  await ListService.createDetailRecord(
                    client,
                    detailTable,
                    updateData.api_metadata,
                    recordId,
                    updateData
                  );
                }
              } catch (detailErr) {
                logger.error('[SyncController] Failed ensuring detail record on update:', detailErr);
              }
            }

            results.push({
              tableName,
              operation,
              clientRecordId: recordId,
              status: 'updated',
              listId: updateListId // Use the updateListId we captured earlier
            });

          } 
          // handle delete operation
          else if (operation === 'delete') {
            console.log('delete', changeItem);
            // Determine the record ID to delete. Prefer explicit record_id, but fall back to data.id when provided.
            let deleteId = clientRecordId;
            if (!deleteId && dataPayload && typeof dataPayload === 'object' && dataPayload.id) {
              deleteId = dataPayload.id;
            }

            if (!deleteId) {
              logger.warn(`[SyncController] Skipping delete for table '${tableName}': missing 'record_id' and no 'data.id' fallback found.`, changeItem);
              continue;
            }
            
            let deleteListId = undefined; // Store list_id for notifications
            
            let favoriteDeleteContext = null;
            let favoriteDeleteRecord = null;

            // Enforce collaboration permissions for list_items delete
            if (tableName === 'list_items') {
              const { rows: liRows } = await client.query('SELECT list_id FROM public.list_items WHERE id = $1', [deleteId]);
              if (liRows.length === 0) {
                results.push({ tableName, operation, clientRecordId: deleteId, status: 'error_not_found' });
                continue;
              }
              deleteListId = liRows[0].list_id; // Store for later use
              const allowed = await userCanEditList(client, userId, deleteListId);
              if (!allowed) {
                results.push({ tableName, operation, clientRecordId: deleteId, status: 'error_forbidden', error: 'Not allowed to delete items from this list' });
                continue;
              }
            } else if (tableName === 'favorites') {
              const { rows: favRows } = await client.query(
                `SELECT id, user_id, target_id, target_type, category_id, is_public, notes, sort_order, created_at, updated_at, deleted_at
                 FROM public.favorites WHERE id = $1`,
                [deleteId]
              );
              if (favRows.length > 0) {
                favoriteDeleteRecord = favRows[0];
                favoriteDeleteContext = await getFavoriteTargetContext(
                  client,
                  favRows[0].target_id,
                  favRows[0].target_type
                );
              }
            }

            // Soft delete by setting deleted_at timestamp (instead of legacy _deleted flag)
            const deleteQuery = `UPDATE "${tableName}" SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`;
            const deleteRes = await client.query(deleteQuery, [deleteId]);

            if (deleteRes.rowCount === 0) {
              logger.warn(`[SyncController] Delete operation for ${tableName}/${deleteId} affected 0 rows. Record may not exist or already deleted.`);
            }

            // Deactivate related embeddings if applicable
            try {
              if (tableName === 'list_items') {
                await EmbeddingService.deactivateEmbedding(deleteId, 'list_item');
              } else if (tableName === 'lists') {
                await EmbeddingService.deactivateEmbedding(deleteId, 'list');
              }
            } catch (embErr) {
              logger.error(`[SyncController] Failed to deactivate embedding for ${tableName}/${deleteId}:`, embErr);
            }
            
            results.push({
              tableName,
              operation,
              clientRecordId: deleteId,
              status: 'deleted',
              listId: deleteListId // Use the deleteListId we captured earlier
            });

            if (
              tableName === 'favorites' &&
              favoriteDeleteContext &&
              favoriteDeleteContext.targetOwnerId &&
              favoriteDeleteContext.targetOwnerId !== userId
            ) {
              const notificationKey = `${favoriteDeleteContext.targetOwnerId}:${favoriteDeleteContext.targetType}:${favoriteDeleteContext.targetId || 'unknown'}`;

              favoriteNotifications.set(notificationKey, {
                ownerId: favoriteDeleteContext.targetOwnerId,
                listId:
                  favoriteDeleteContext.targetListId ||
                  (favoriteDeleteContext.targetType === 'list'
                    ? favoriteDeleteContext.targetId
                    : null),
                targetType: favoriteDeleteContext.targetType,
                targetId: favoriteDeleteContext.targetId,
                favoriteId: deleteId,
                actorId: userId,
                operation: 'delete',
              });

              if (favoriteDeleteRecord) {
                try {
                  const deletedRecord = {
                    ...favoriteDeleteRecord,
                    deleted_at: new Date().toISOString(),
                  };
                  await enqueueFavoriteChangeForOwner(
                    client,
                    favoriteDeleteContext.targetOwnerId,
                    deletedRecord,
                    'delete'
                  );
                } catch (logErr) {
                  logger.error('[SyncController] Failed to enqueue favorite delete for owner:', logErr);
                }
              } else {
                try {
                  await enqueueFavoriteChangeForOwner(
                    client,
                    favoriteDeleteContext.targetOwnerId,
                    {
                      id: deleteId,
                      user_id: userId,
                      target_id: favoriteDeleteContext.targetId,
                      target_type: favoriteDeleteContext.targetType,
                      category_id: null,
                      is_public: false,
                      notes: null,
                      sort_order: 0,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                      deleted_at: new Date().toISOString(),
                    },
                    'delete'
                  );
                } catch (logErr) {
                  logger.error('[SyncController] Failed to enqueue fallback favorite delete for owner:', logErr);
                }
              }
            }
          }
        }
      });
      
      // After transaction completes successfully
      // Notify group members about list_item changes
      await notifyGroupMembersOfListChanges(results, userId);

      for (const notification of favoriteNotifications.values()) {
        try {
          socketService.notifyUser(notification.ownerId, 'favorite_count_updated', {
            listId: notification.listId,
            targetType: notification.targetType,
            targetId: notification.targetId,
            favoriteId: notification.favoriteId,
            operation: notification.operation,
            actorId: notification.actorId,
            timestamp: Date.now(),
          });

          socketService.notifyUser(notification.ownerId, 'sync_update_available', {
            tables: ['favorites'],
            listId: notification.listId,
            targetType: notification.targetType,
            targetId: notification.targetId,
            favoriteId: notification.favoriteId,
            operation: notification.operation,
            actorId: notification.actorId,
            timestamp: Date.now(),
          });
        } catch (notifyError) {
          logger.error('[SyncController] Failed to notify owner about favorite count update:', notifyError);
        }
      }
      
      socketService.notifyUser(userId, 'syncComplete', { message: 'Push processed', results });
      res.status(200).json({ success: true, message: 'Changes pushed and processed successfully.', results });
    } catch (error) {
      logger.error('[SyncController] Push error:', error);
      res.status(500).json({ success: false, error: 'Failed to process changes', details: error.message, results }); // Include results even on error if partially processed
    }
  };

  async function columnExists(client, tableName, columnName) {
    const query = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2;
    `;
    const result = await client.query(query, [tableName, columnName]);
    return result.rows.length > 0;
  }

  /**
   * Handles pulling changes from the server to the client.
   * Returns changes (created, updated, deleted) since the client's last pull time.
   * Compatible with WatermelonDB sync protocol.
   */
  const handleGetChanges = async (req, res) => {
    const lastPulledAtString = req.query.last_pulled_at;
    let lastPulledAt = 0;

    if (lastPulledAtString) {
      const parsed = parseInt(lastPulledAtString, 10);
      if (!isNaN(parsed)) {
        lastPulledAt = parsed;
      }
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const serverNow = Date.now();

    try {
      // This single, optimized query replaces the previous multi-query loop.
      const query = `
        WITH change_log_updates AS (
          SELECT
            table_name,
            record_id,
            operation,
            created_at,
            change_data
          FROM public.change_log
          WHERE user_id = $1 AND created_at > to_timestamp($2 / 1000.0)
        )
        SELECT
          cl.table_name,
          cl.record_id,
          cl.operation,
          cl.created_at,
          cl.change_data,
          -- Efficiently fetch current data using LEFT JOINs
          COALESCE(
            l.json_build_object,
            li.json_build_object,
            f.json_build_object,
            us.json_build_object,
            u.json_build_object,
            flw.json_build_object,
            n.json_build_object,
            lc.json_build_object,
            it.json_build_object,
            gr.json_build_object,
            gpg.json_build_object,
            gc.json_build_object,
            cl.change_data::json
          ) AS current_data
        FROM change_log_updates cl
        LEFT JOIN (
          SELECT id, row_to_json(lists.*) as json_build_object 
          FROM public.lists 
          WHERE deleted_at IS NULL 
            AND (
              owner_id = $1 
              OR id IN (
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
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
              )
            )
        ) l ON cl.table_name = 'lists' AND cl.operation != 'delete' AND l.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (
          SELECT li.id, 
            CASE 
              WHEN gd.id IS NOT NULL THEN
                json_build_object(
                  'id', li.id,
                  'list_id', li.list_id,
                  'title', li.title,
                  'description', li.description,
                  'status', li.status,
                  'priority', li.priority,
                  'image_url', li.image_url,
                  'link', li.link,
                  'custom_fields', li.custom_fields,
                  'owner_id', li.owner_id,
                  'created_at', li.created_at,
                  'updated_at', li.updated_at,
                  'deleted_at', li.deleted_at,
                  'price', li.price,
                  'api_metadata', li.api_metadata,
                  'gift_detail_id', li.gift_detail_id,
                  'quantity', gd.quantity,
                  'where_to_buy', gd.where_to_buy,
                  'amazon_url', gd.amazon_url,
                  'web_link', gd.web_link,
                  'rating', gd.rating
                )
              ELSE row_to_json(li.*)
            END as json_build_object
          FROM public.list_items li
          LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id
          WHERE li.deleted_at IS NULL 
            AND (
              li.owner_id = $1 
              OR li.list_id IN (
                -- Items from lists shared with user through groups
                SELECT DISTINCT lgr.list_id 
                FROM list_group_roles lgr
                JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
                WHERE cgm.user_id = $1 
                  AND lgr.deleted_at IS NULL 
                  AND cgm.deleted_at IS NULL
                UNION
                -- Items from lists shared directly with user  
                SELECT DISTINCT luo.list_id
                FROM list_user_overrides luo
                WHERE luo.user_id = $1 
                  AND luo.deleted_at IS NULL
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
              )
            )
        ) li ON cl.table_name = 'list_items' AND cl.operation != 'delete' AND li.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT id, row_to_json(favorites.*) as json_build_object FROM public.favorites WHERE user_id = $1 AND deleted_at IS NULL) f ON cl.table_name = 'favorites' AND cl.operation != 'delete' AND f.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT user_id, row_to_json(user_settings.*) as json_build_object FROM public.user_settings WHERE user_id = $1) us ON cl.table_name = 'user_settings' AND cl.operation != 'delete' AND us.user_id = $1
        LEFT JOIN (SELECT id, row_to_json(users.*) as json_build_object FROM public.users) u ON cl.table_name = 'users' AND cl.operation != 'delete' AND u.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT id, row_to_json(followers.*) as json_build_object FROM public.followers WHERE (follower_id = $1 OR followed_id = $1) AND deleted_at IS NULL) flw ON cl.table_name = 'followers' AND cl.operation != 'delete' AND flw.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT id, row_to_json(notifications.*) as json_build_object FROM public.notifications WHERE user_id = $1 AND deleted_at IS NULL) n ON cl.table_name = 'notifications' AND cl.operation != 'delete' AND n.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT id, row_to_json(list_categories.*) as json_build_object FROM public.list_categories WHERE deleted_at IS NULL) lc ON cl.table_name = 'list_categories' AND cl.operation != 'delete' AND lc.id = CASE 
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
          THEN cl.record_id::uuid 
          ELSE NULL 
        END
        LEFT JOIN (SELECT item_id, row_to_json(item_tags.*) as json_build_object FROM public.item_tags WHERE deleted_at IS NULL) it ON cl.table_name = 'item_tags' AND cl.operation != 'delete' AND it.item_id::text = cl.record_id
        LEFT JOIN (
          SELECT
            gr.id,
            row_to_json(gr.*) AS json_build_object
          FROM public.gift_reservations gr
          JOIN public.list_items li2 ON gr.item_id = li2.id
          WHERE gr.deleted_at IS NULL
            AND (
              li2.owner_id = $1
              OR gr.reserved_by = $1
              OR gr.reserved_for = $1
              OR li2.list_id IN (
                SELECT DISTINCT lgr.list_id
                FROM list_group_roles lgr
                JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
                WHERE cgm.user_id = $1
                  AND lgr.deleted_at IS NULL
                  AND cgm.deleted_at IS NULL
                UNION
                SELECT DISTINCT luo.list_id
                FROM list_user_overrides luo
                WHERE luo.user_id = $1
                  AND luo.deleted_at IS NULL
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
              )
            )
        ) gr ON cl.table_name = 'gift_reservations' AND cl.operation != 'delete' AND gr.id = CASE
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN cl.record_id::uuid
          ELSE NULL
        END
        LEFT JOIN (
          SELECT
            gpg.id,
            row_to_json(gpg.*) AS json_build_object
          FROM public.gift_purchase_groups gpg
          WHERE gpg.deleted_at IS NULL
            AND (
              gpg.created_by = $1
              OR gpg.list_id IN (
                SELECT DISTINCT lgr.list_id
                FROM list_group_roles lgr
                JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
                WHERE cgm.user_id = $1
                  AND lgr.deleted_at IS NULL
                  AND cgm.deleted_at IS NULL
                UNION
                SELECT DISTINCT luo.list_id
                FROM list_user_overrides luo
                WHERE luo.user_id = $1
                  AND luo.deleted_at IS NULL
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
              )
            )
        ) gpg ON cl.table_name = 'gift_purchase_groups' AND cl.operation != 'delete' AND gpg.id = CASE
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN cl.record_id::uuid
          ELSE NULL
        END
        LEFT JOIN (
          SELECT
            gc.id,
            row_to_json(gc.*) AS json_build_object
          FROM public.gift_contributions gc
          JOIN public.gift_purchase_groups gpg2 ON gc.group_id = gpg2.id
          WHERE gc.deleted_at IS NULL
            AND gpg2.deleted_at IS NULL
            AND (
              gc.contributor_id = $1
              OR gpg2.list_id IN (
                SELECT DISTINCT lgr.list_id
                FROM list_group_roles lgr
                JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
                WHERE cgm.user_id = $1
                  AND lgr.deleted_at IS NULL
                  AND cgm.deleted_at IS NULL
                UNION
                SELECT DISTINCT luo.list_id
                FROM list_user_overrides luo
                WHERE luo.user_id = $1
                  AND luo.deleted_at IS NULL
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
              )
            )
        ) gc ON cl.table_name = 'gift_contributions' AND cl.operation != 'delete' AND gc.id = CASE
          WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN cl.record_id::uuid
          ELSE NULL
        END
        ORDER BY cl.created_at ASC
        LIMIT 1000;
      `;

      const { rows } = await db.query(query, [userId, lastPulledAt]);

      const listIdsToAugment = rows
        .filter((r) => r.table_name === 'lists' && r.current_data && r.current_data.id)
        .map((r) => String(r.current_data.id));

      const shareMetadataMap = await fetchShareMetadataForLists(listIdsToAugment);

      for (const row of rows) {
        if (row.table_name !== 'lists' || !row.current_data || !row.current_data.id) continue;

        const listId = String(row.current_data.id);
        const ownerId = row.current_data.owner_id ? String(row.current_data.owner_id) : null;
        const shareMeta = shareMetadataMap.get(listId) || { groupIds: [], groupDetails: [], connectionIds: [] };

        if (shareMeta.groupIds.length > 0) {
          row.current_data.access_groups = shareMeta.groupIds;
          row.current_data.access_group_details = shareMeta.groupDetails;
        }

        if (shareMeta.connectionIds.length > 0) {
          row.current_data.shared_with_connections = shareMeta.connectionIds;
        }

        const hasGroupShares = shareMeta.groupIds.length > 0;
        const hasIndividualShares = shareMeta.connectionIds.length > 0;

        let shareType = row.current_data.share_type || null;
        if (!shareType) {
          if (hasGroupShares) {
            shareType = 'group_shared';
          } else if (hasIndividualShares) {
            shareType = 'individual_shared';
          }
        }

        if (ownerId === String(userId)) {
          if (shareType) {
            row.current_data.share_type = shareType;
          }
          if (typeof row.current_data.shared_by_owner !== 'boolean') {
            row.current_data.shared_by_owner = Boolean(shareType);
          }
        } else {
          row.current_data.shared_with_me = true;
          if (shareType) {
            row.current_data.share_type = shareType;
          }
          if (!row.current_data.access_via_group && shareMeta.groupDetails.length > 0) {
            const primaryGroup = shareMeta.groupDetails[0];
            row.current_data.access_via_group = primaryGroup?.name || primaryGroup?.id || row.current_data.access_via_group;
          }
        }
      }

      // Debug: Log shared lists being pulled
      const sharedLists = rows.filter((r) => r.table_name === 'lists' && r.current_data && r.current_data.owner_id !== userId);
      if (sharedLists.length > 0) {
        logger.info(`[SyncController] Pull found ${sharedLists.length} shared lists for user ${userId}:`);
        sharedLists.forEach((list) => {
          logger.info(`  - Shared list: "${list.current_data.title}" (${list.current_data.id}), owner: ${list.current_data.owner_id}`);
        });
      }

      const changes = {
        lists: { created: [], updated: [], deleted: [] },
        list_items: { created: [], updated: [], deleted: [] },
        favorites: { created: [], updated: [], deleted: [] },
        user_settings: { created: [], updated: [], deleted: [] },
        users: { created: [], updated: [], deleted: [] },
        followers: { created: [], updated: [], deleted: [] },
        notifications: { created: [], updated: [], deleted: [] },
        list_categories: { created: [], updated: [], deleted: [] },
        item_tags: { created: [], updated: [], deleted: [] },
        list_sharing: { created: [], updated: [], deleted: [] },
        gift_reservations: { created: [], updated: [], deleted: [] },
        gift_purchase_groups: { created: [], updated: [], deleted: [] },
        gift_contributions: { created: [], updated: [], deleted: [] },
      };

      for (const row of rows) {
        const { table_name, record_id, operation, current_data } = row;

        if (!changes[table_name]) {
          changes[table_name] = { created: [], updated: [], deleted: [] };
        }

        if (operation === 'delete') {
          changes[table_name].deleted.push(record_id);
        } else if (operation === 'create') {
          changes[table_name].created.push(current_data);
        } else {
          changes[table_name].updated.push(current_data);
        }
      }

      res.status(200).json({
        changes: changes,
        timestamp: serverNow,
      });

    } catch (error) {
      logger.error('[SyncController] Error pulling changes:', error);
      res.status(500).json({ error: 'Server error pulling changes', details: error.message, code: error.code, hint: error.hint });
    }
  };

  const handleGetState = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    logger.info(`[SyncController] User ${userId} requesting full initial state.`);
    // Implement fetching all necessary data for the user for an initial sync.
    // This is usually a larger payload than pullChanges.
    res.status(501).json({ message: 'Not implemented: Full state retrieval' });
  };

  const handleGetRecord = async (req, res) => {
    const { table, id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });

    logger.info(`[SyncController] User ${userId} requesting record: ${table}/${id}`);
    // Renamed 'items' to 'list_items' in allowedTables
    const allowedTables = [
      'list_items',
      'lists',
      ...Object.values(DETAIL_TABLES_MAP),
      'user_settings',
      'list_sharing',
      'list_user_overrides',
      'list_group_roles',
      'collaboration_group_members',
      'collaboration_groups',
      'gift_reservations',
      'gift_purchase_groups',
      'gift_contributions',
    ];
    if (!allowedTables.includes(table)) {
      return res.status(400).json({ error: 'Invalid or disallowed table specified' });
    }

    // Determine user identifier column for the current table
    const userIdentifierColumn = getUserIdentifierColumn(table);

    try {
      // Special handling for list_items - need to check list permissions
      if (table === 'list_items') {
        // First get the item to check which list it belongs to
        const escapedItemsTable = `"list_items"`;
        const itemQuery = `SELECT list_id FROM ${escapedItemsTable} WHERE id = $1 AND deleted_at IS NULL`;
        const itemResult = await db.query(itemQuery, [id]);

        if (itemResult.rows.length === 0) {
          return res.status(404).json({ message: 'Record not found or access denied' });
        }

        const listId = itemResult.rows[0].list_id;

        // Check if user has access to this list
        const hasAccess = await userCanEditList(db, userId, listId);
        if (!hasAccess) {
          // Check if user can at least view the list (read-only access)
          const viewQuery = `
            SELECT 1 FROM public.lists WHERE id = $1 AND (
              owner_id = $2
              OR is_public = true
              OR id IN (
                SELECT list_id FROM public.list_sharing ls
                JOIN public.collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
                WHERE cgm.user_id = $2 AND ls.deleted_at IS NULL AND cgm.deleted_at IS NULL
              )
            ) AND deleted_at IS NULL
          `;
          const viewResult = await db.query(viewQuery, [listId, userId]);
          if (viewResult.rows.length === 0) {
            return res.status(404).json({ message: 'Record not found or access denied' });
          }
        }

        // User has access, fetch the complete item with gift details
        const fullQuery = `
          SELECT
            li.*,
            gd.quantity,
            gd.where_to_buy,
            gd.amazon_url,
            gd.web_link,
            gd.rating
          FROM ${escapedItemsTable} li
          LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
          WHERE li.id = $1 AND li.deleted_at IS NULL
        `;
        const result = await db.query(fullQuery, [id]);

        if (result.rows.length === 0) {
          return res.status(404).json({ message: 'Record not found or access denied' });
        }

        return res.status(200).json(result.rows[0]);
      }

      // For other tables, use the original logic
      const escapedTable = `"${table.replace(/"/g, '""')}"`;
      const escapedUserColumn = `"${userIdentifierColumn.replace(/"/g, '""')}"`;
      const query = `SELECT * FROM ${escapedTable} WHERE id = $1 AND ${escapedUserColumn} = $2`;
      const result = await db.query(query, [id, userId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Record not found or access denied' });
      }
      res.status(200).json(result.rows[0]);
    } catch (error) {
      logger.error(`[SyncController] Error getting record ${table}/${id}:`, error);
      res.status(500).json({ error: 'Server error getting record', details: error.message, code: error.code, hint: error.hint });
    }
  };
  
  const handleGetConflicts = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    logger.info(`[SyncController] User ${userId} requesting sync conflicts.`);
    // Conflict resolution logic would typically involve comparing client and server versions
    // and potentially storing conflicts for manual resolution.
    res.status(200).json({ conflicts: [] }); // Placeholder
  };

  const handleGetQueue = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    logger.info(`[SyncController] User ${userId} requesting sync queue status.`);
    // This could report the number of pending changes or background sync jobs.
    res.status(200).json({ queue_status: 'idle', pending_changes: 0 }); // Placeholder
  };

  const BATCH_FAVORITES_UPDATE = async (client, userId, operations) => {
    const batchResults = [];
    for (const op of operations) {
      const { action, clientRecordId, data } = op;
      if (!action || !clientRecordId || !data) {
        console.warn('[SyncController] Skipping invalid change item (missing operation or data):', op);
        continue;
      }

      if (action === 'delete') {
        // Soft delete logic
        const deleteQuery = `
          UPDATE public.favorites
          SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2
          RETURNING id
        `;
        const deleteResult = await client.query(deleteQuery, [clientRecordId, userId]);
        if (deleteResult.rows.length > 0) {
          batchResults.push({ clientRecordId, serverId: deleteResult.rows[0].id, status: 'deleted' });
        }
      } else if (action === 'create') {
        // Handle create (for future mass favoriting)
        const { list_id, list_item_id } = data;
        const insertQuery = `
          INSERT INTO public.favorites (user_id, list_id, list_item_id, created_at, updated_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, COALESCE(list_id, ''), COALESCE(list_item_id, '')) 
          DO UPDATE SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
          RETURNING id
        `;
        const insertResult = await client.query(insertQuery, [userId, list_id, list_item_id]);
        batchResults.push({ clientRecordId, serverId: insertResult.rows[0].id, status: 'created' });
      }
    }
    return batchResults;
  };

  // Get all list items for a list (used by group members to fetch shared items)
  const handleGetListItems = async (req, res) => {
    try {
      const userId = req.user?.id;
      const { listId } = req.params;
      
      if (!userId || !listId) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      
      // Check if user has access to this list
      const hasAccess = await userCanEditList(db, userId, listId);
      if (!hasAccess) {
        // Check if user can at least view the list
        const viewQuery = `
          SELECT 1 FROM public.lists WHERE id = $1 AND (
            owner_id = $2 
            OR is_public = true
            OR id IN (
              SELECT list_id FROM public.list_sharing ls
              JOIN public.collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
              WHERE cgm.user_id = $2 AND ls.deleted_at IS NULL AND cgm.deleted_at IS NULL
            )
            OR id IN (
              SELECT list_id FROM public.list_group_roles lgr
              JOIN public.collaboration_group_members cgm ON lgr.group_id = cgm.group_id
              WHERE cgm.user_id = $2 AND lgr.deleted_at IS NULL AND cgm.deleted_at IS NULL
            )
          ) LIMIT 1
        `;
        const { rows: viewRows } = await db.query(viewQuery, [listId, userId]);
        if (viewRows.length === 0) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
      
      // Fetch all non-deleted items for this list
      const itemsQuery = `
        SELECT * FROM public.list_items 
        WHERE list_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      const { rows: items } = await db.query(itemsQuery, [listId]);
      
      logger.info(`[SyncController] User ${userId} fetched ${items.length} items for list ${listId}`);
      
      res.status(200).json({ 
        success: true,
        items: items,
        count: items.length
      });
      
    } catch (error) {
      logger.error('[SyncController] Error fetching list items:', error);
      res.status(500).json({ error: 'Failed to fetch list items' });
    }
  };

  return {
    handlePush,
    handleGetChanges,
    handleGetState,
    handleGetRecord,
    handleGetConflicts,
    handleGetQueue,
    handleGetListItems,
  };
}

module.exports = syncControllerFactory; 
