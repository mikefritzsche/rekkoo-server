// server/src/controllers/SyncController.js
const db = require('../config/db'); // Ensure this path is correct
const ListService = require('../services/ListService'); // Import ListService
const { logger } = require('../utils/logger'); // Assuming logger is in utils
const EmbeddingService = require('../services/embeddingService'); // Import EmbeddingService
const spotifyService = require('../services/spotify-service');

// Define detail tables that are associated with records in the 'list_items' table
const DETAIL_TABLES_MAP = {
  movie: 'movie_details',
  book: 'book_details',
  place: 'place_details',
  spotify_item: 'spotify_item_details', // Assuming 'spotify_item' is the type used in 'list_items' table
  tv: 'tv_details', // Add TV details mapping
};

function syncControllerFactory(socketService) {
  // Helper function to get the detail table name for a given item type
  const getDetailTableName = (itemType) => {
    return DETAIL_TABLES_MAP[itemType.toLowerCase()] || null;
  };

  // Helper to determine the correct user identifier column for a given table
  const getUserIdentifierColumn = (tableName) => {
    if (tableName === 'list_items' || tableName === 'lists') {
      return 'owner_id';
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
    // For any other table, including detail tables, we are saying there is no direct user identifier for the generic pull.
    // This means they won't be processed in the main loop of handleGetChanges for direct user-filtered updates/deletes.
    // logger.warn(`[SyncController] Table '${tableName}' will not be processed by user-identifier in handleGetChanges main loop.`);
    return null;
  };

  // Helper function to process a single favorite creation or restoration
  async function processSingleFavoriteAddOrRestore(txnClient, userId, favDataFromPush) {
    const { id: clientProvidedId, target_id, target_type, category_id, is_public, notes, sort_order } = favDataFromPush;
    logger.debug(`[SyncController] processSingleFavoriteAddOrRestore called for user ${userId}, client ID ${clientProvidedId}, target ${target_id}, type ${target_type}`);

    if (!target_id || !target_type) {
        logger.warn(`[SyncController] processSingleFavoriteAddOrRestore: Missing target_id or target_type for client ID ${clientProvidedId}`);
        return { status: 'error_missing_target', error: 'Favorite must include target_id and target_type' };
    }

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
        // Even if client sent a new ID, we updated the existing one. Respond with the existing ID.
        return { status: 'updated_existing_active', serverId: existingActiveId, affectedRows: 1 };
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
        return { status: 'restored', serverId: existingSoftDeletedId, affectedRows: 1 };
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
    return { status: 'created', serverId: insertResult.rows[0].id, affectedRows: 1 };
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
            const values = Object.values(filteredData);
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

            let insertResult;
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
            } else {
              const insertQuery = `INSERT INTO "${tableName}" (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING id`;
              insertResult = await client.query(insertQuery, values);
            }
            const insertedId = insertResult.rows[0].id || insertResult.rows[0].item_id;

            // ----- Embedding queue hooks -----
            try {
              if (['list_items', 'item_tags'].includes(tableName)) {
                const targetItemId = tableName === 'list_items' ? insertedId : (createData.item_id || values[fields.indexOf('item_id')]);
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
                      let metaObj = {};
                      if (createData.api_metadata) {
                        metaObj = typeof createData.api_metadata === 'string' ? JSON.parse(createData.api_metadata) : createData.api_metadata;
                      }
                      if (!metaObj.genres || metaObj.genres.length === 0) {
                        const sourceId = metaObj.source_id || createData.source_id || null;
                        if (sourceId) {
                          const genres = await spotifyService.fetchGenres(sourceId, 'track');
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
                  default:
                    // Unknown or custom list types will skip detail creation
                    break;
                }

                if (detailTable && detailIdColumn) {
                  const detailRec = await ListService.createDetailRecord(
                    client,
                    detailTable,
                    createData.api_metadata,
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
              operation,
              clientRecordId,
              status: 'created',
              serverId: insertedId
            });

          } else if (operation === 'update') {
            const updateData = { ...dataPayload };
            const recordId = clientRecordId || updateData.id;

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

            results.push({
              operation,
              clientRecordId: recordId,
              status: 'updated'
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
              operation,
              clientRecordId: deleteId,
              status: 'deleted'
            });
          }
        }
      });
      
      // After transaction completes successfully
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
    // logger.info(`[SyncController] Received req.query.last_pulled_at: '${lastPulledAtString}' (type: ${typeof lastPulledAtString})`);
    let lastPulledAt = 0;

    if (lastPulledAtString) {
      const parsedDate = Date.parse(lastPulledAtString);
      if (!isNaN(parsedDate)) {
        lastPulledAt = parsedDate;
      } else {
        const parsedInt = parseInt(lastPulledAtString, 10);
        if (!isNaN(parsedInt)) {
          lastPulledAt = parsedInt;
        } else {
          logger.warn(`[SyncController] Could not parse last_pulled_at value: "${lastPulledAtString}". Defaulting to 0.`);
        }
      }
    } else {
      // logger.info(`[SyncController] req.query.last_pulled_at was not provided or was empty. Defaulting to 0.`);
    }
    // logger.info(`[SyncController] Final parsed lastPulledAt timestamp before use: ${lastPulledAt}`);

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    // logger.info(`[SyncController] User ${userId} pulling changes since: ${new Date(lastPulledAt).toISOString()} (timestamp: ${lastPulledAt})`);

    try {
      const changes = {
        list_items: { created: [], updated: [], deleted: [] },
        lists: { created: [], updated: [], deleted: [] },
        user_settings: { created: [], updated: [], deleted: [] },
        users: { created: [], updated: [], deleted: [] },
        movie_details: { created: [], updated: [], deleted: [] },
        tv_details: { created: [], updated: [], deleted: [] },
        favorites: { created: [], updated: [], deleted: [] },
        followers: { created: [], updated: [], deleted: [] },
        notifications: { created: [], updated: [], deleted: [] }
      };
      const serverNow = Date.now();
      const allSyncableTables = ['list_items', 'lists', 'user_settings', 'users', 'movie_details', 'tv_details', 'favorites', 'followers', 'notifications']; 
      
      const relatedUserIds = new Set();

      await db.transaction(async (client) => {
        for (const table of allSyncableTables) {
          const userIdentifierColumn = getUserIdentifierColumn(table);
          let createdRecords = [];
          let updatedRecords = [];
          let deletedRecordIds = [];

          if (table === 'movie_details') {
            const updatedQuery = `
              SELECT md.* FROM ${client.escapeIdentifier(table)} md
              JOIN list_items li ON md.list_item_id = li.id
              WHERE li.owner_id = $1 AND md.updated_at >= to_timestamp($2 / 1000.0)
            `;
            const updatedResult = await client.query(updatedQuery, [userId, lastPulledAt]);
            updatedResult.rows.forEach(record => {
              record.updated_at = new Date(record.updated_at).getTime();
              record.created_at = new Date(record.created_at).getTime();
              if (record.created_at >= lastPulledAt) {
                createdRecords.push(record);
              } else {
                updatedRecords.push(record);
              }
            });
            deletedRecordIds = []; 
          } else if (userIdentifierColumn) { 
            if (table === 'followers') {
                const createdQuery = `
                    SELECT * FROM ${client.escapeIdentifier(table)}
                    WHERE (${client.escapeIdentifier('follower_id')} = $1 OR ${client.escapeIdentifier('followed_id')} = $1)
                      AND created_at >= to_timestamp($2 / 1000.0) 
                      AND deleted_at IS NULL`;
                const createdResult = await client.query(createdQuery, [userId, lastPulledAt]);
                createdResult.rows.forEach(record => {
                    record.created_at = new Date(record.created_at).getTime();
                    if (record.updated_at) record.updated_at = new Date(record.updated_at).getTime(); else record.updated_at = record.created_at;
                    createdRecords.push(record);
                });
                // For followers, also check for updates to existing records (e.g. if a deleted_at was set then cleared - restoration)
                // For this, we look at updated_at. A follow action itself might not update 'updated_at' unless specified.
                // The client logic primarily uses created_at for new follows and deleted_at for unfollows.
                // We will primarily rely on 'created' and 'deleted' for followers.
                // However, if a follow record *is* updated (e.g. restoring a soft-deleted one), send it.
                 const updatedFollowersQuery = `
                    SELECT * FROM ${client.escapeIdentifier(table)}
                    WHERE (${client.escapeIdentifier('follower_id')} = $1 OR ${client.escapeIdentifier('followed_id')} = $1)
                    AND updated_at >= to_timestamp($2 / 1000.0)
                    AND created_at < to_timestamp($2 / 1000.0) -- Only consider as 'updated' if not already 'created'
                    AND deleted_at IS NULL`; // Only send active, updated follows
                const updatedFollowersResult = await client.query(updatedFollowersQuery, [userId, lastPulledAt]);
                updatedFollowersResult.rows.forEach(record => {
                    record.created_at = new Date(record.created_at).getTime();
                    record.updated_at = new Date(record.updated_at).getTime();
                    updatedRecords.push(record);
                });

            } else if (table === 'notifications') {
                const createdQuery = `
                    SELECT * FROM ${client.escapeIdentifier(table)}
                    WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 
                      AND created_at >= to_timestamp($2 / 1000.0)
                      AND deleted_at IS NULL`;
                const createdResult = await client.query(createdQuery, [userId, lastPulledAt]);
                createdResult.rows.forEach(record => {
                    record.created_at = new Date(record.created_at).getTime();
                    if (record.updated_at) record.updated_at = new Date(record.updated_at).getTime(); else record.updated_at = record.created_at;
                    createdRecords.push(record);
                });
                 const updatedNotificationsQuery = `
                    SELECT * FROM ${client.escapeIdentifier(table)}
                    WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1
                    AND updated_at >= to_timestamp($2 / 1000.0)
                    AND created_at < to_timestamp($2 / 1000.0)
                    AND deleted_at IS NULL`;
                const updatedNotificationsResult = await client.query(updatedNotificationsQuery, [userId, lastPulledAt]);
                updatedNotificationsResult.rows.forEach(record => {
                    record.created_at = new Date(record.created_at).getTime();
                    record.updated_at = new Date(record.updated_at).getTime();
                    updatedRecords.push(record);
                });
            } else { // General case for other tables with userIdentifierColumn
                const query = `
                  SELECT * FROM ${client.escapeIdentifier(table)} 
                  WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND updated_at >= to_timestamp($2 / 1000.0)
                `;
                const result = await client.query(query, [userId, lastPulledAt]);
                result.rows.forEach(record => {
                  if (record.updated_at) record.updated_at = new Date(record.updated_at).getTime();
                  record.created_at = new Date(record.created_at).getTime();
                  if (record.created_at >= lastPulledAt) {
                    createdRecords.push(record);
                  } else { // Already checked updated_at in query
                    updatedRecords.push(record);
                  }
                });
            }
            
            if (await columnExists(client, table, 'deleted_at')) {
              let selectIdColumnForDeleted = 'id'; 
              if (table === 'user_settings') { selectIdColumnForDeleted = `${client.escapeIdentifier('user_id')} AS id`; }
              const deletedQuery = `
                SELECT ${selectIdColumnForDeleted} FROM ${client.escapeIdentifier(table)} 
                WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND deleted_at IS NOT NULL AND deleted_at >= to_timestamp($2 / 1000.0)
              `;
              try {
                const deletedResult = await client.query(deletedQuery, [userId, lastPulledAt]);
                deletedRecordIds = deletedResult.rows.map(r => r.id); 
              } catch (e) {
                 logger.warn(`[SyncController] Could not query deleted records for table ${table}. Error: ${e.message}`);
              }
            }
          } else if (table !== 'movie_details' && table !== 'tv_details') { // Skip if no user identifier and not a detail table handled above
            logger.warn(`[SyncController] Skipping table ${table} in pull changes as it has no direct user identifier column and no special handling defined.`);
            changes[table] = { created: [], updated: [], deleted: [] }; // Ensure it has an entry
            continue;
          }
          // END OF PLACEHOLDER for per-table fetching logic

          // Collect related user IDs
          if (table === 'followers') {
            createdRecords.forEach(record => {
              if (record.follower_id) relatedUserIds.add(record.follower_id);
              if (record.followed_id) relatedUserIds.add(record.followed_id);
            });
            updatedRecords.forEach(record => {
              if (record.follower_id) relatedUserIds.add(record.follower_id);
              if (record.followed_id) relatedUserIds.add(record.followed_id);
            });
          } else if (table === 'lists' || table === 'list_items') { // list_items also has owner_id
            createdRecords.forEach(record => { if (record.owner_id) relatedUserIds.add(record.owner_id); });
            updatedRecords.forEach(record => { if (record.owner_id) relatedUserIds.add(record.owner_id); });
          } else if (table === 'notifications') {
            createdRecords.forEach(record => {
              if (record.user_id) relatedUserIds.add(record.user_id);
              if (record.actor_id) relatedUserIds.add(record.actor_id);
            });
            updatedRecords.forEach(record => {
              if (record.user_id) relatedUserIds.add(record.user_id);
              if (record.actor_id) relatedUserIds.add(record.actor_id);
            });
          } else if (table === 'favorites') { // Favorites are user-specific
             createdRecords.forEach(record => { if (record.user_id) relatedUserIds.add(record.user_id); });
             updatedRecords.forEach(record => { if (record.user_id) relatedUserIds.add(record.user_id); });
          }
          // For 'users' table itself, the main query handles the current user.
          // If other users are modified directly and should be synced, they'd be caught here
          // but primary user sync for current user is usually more direct.
          // We are mostly interested in related users from *other* tables.

          changes[table] = {
            created: createdRecords,
            updated: updatedRecords,
            deleted: deletedRecordIds,
          };
        }

        if (relatedUserIds.size > 0) {
          relatedUserIds.delete(userId); 
          if (relatedUserIds.size > 0) {
            const userIdsToFetch = Array.from(relatedUserIds);
            logger.info(`[SyncController handleGetChanges] Need to fetch profiles for related user IDs: ${userIdsToFetch.join(', ')}`);
            const placeholders = userIdsToFetch.map((_, i) => `$${i + 1}`).join(',');
            const usersQuery = `
              SELECT * FROM public.users
              WHERE id IN (${placeholders}) 
              AND updated_at >= to_timestamp($${userIdsToFetch.length + 1} / 1000.0)
            `;
            const userResults = await client.query(usersQuery, [...userIdsToFetch, lastPulledAt]);
            userResults.rows.forEach(userRecord => {
              userRecord.created_at = new Date(userRecord.created_at).getTime();
              userRecord.updated_at = new Date(userRecord.updated_at).getTime();
              // Check if this user record is already in changes.users from the main 'users' table processing
              const existingCreated = changes.users.created.find(u => u.id === userRecord.id);
              const existingUpdated = changes.users.updated.find(u => u.id === userRecord.id);

              if (!existingCreated && !existingUpdated) { // Only add if not already processed
                if (userRecord.created_at >= lastPulledAt) {
                  changes.users.created.push(userRecord);
                } else {
                  changes.users.updated.push(userRecord);
                }
              } else {
                logger.info(`[SyncController handleGetChanges] User ${userRecord.id} was already processed in the main 'users' table sync. Skipping duplicate add from related IDs.`);
              }
            });
            logger.info(`[SyncController handleGetChanges] Added ${userResults.rows.length} distinct related user profiles to the sync payload (if not already present).`);
          }
        }
      });

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
    const allowedTables = ['list_items', 'lists', ...Object.values(DETAIL_TABLES_MAP), 'user_settings'];
    if (!allowedTables.includes(table)) {
      return res.status(400).json({ error: 'Invalid or disallowed table specified' });
    }

    // Determine user identifier column for the current table
    const userIdentifierColumn = getUserIdentifierColumn(table);

    try {
      const query = `SELECT * FROM ${db.escapeIdentifier(table)} WHERE id = $1 AND ${db.escapeIdentifier(userIdentifierColumn)} = $2`;
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

  return {
    handlePush,
    handleGetChanges,
    handleGetState,
    handleGetRecord,
    handleGetConflicts,
    handleGetQueue,
  };
}

module.exports = syncControllerFactory; 