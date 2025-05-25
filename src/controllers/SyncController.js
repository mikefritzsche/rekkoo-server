// server/src/controllers/SyncController.js
const db = require('../config/db'); // Ensure this path is correct
const ListService = require('../services/ListService'); // Import ListService
const { logger } = require('../utils/logger'); // Assuming logger is in utils

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
    // For any other table, including detail tables, we are saying there is no direct user identifier for the generic pull.
    // This means they won't be processed in the main loop of handleGetChanges for direct user-filtered updates/deletes.
    logger.warn(`[SyncController] Table '${tableName}' will not be processed by user-identifier in handleGetChanges main loop.`);
    return null;
  };

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
      await db.transaction(async (client) => {
        for (const changeItem of clientChangesArray) {
          const { table_name: tableName, operation, record_id: clientRecordId, data } = changeItem;

          if (!operation || !data) { // table_name might be implicit in BATCH_LIST_ORDER_UPDATE
            logger.warn('[SyncController] Skipping invalid change item (missing operation or data):', changeItem);
            continue;
          }
          
          // Handle BATCH_LIST_ORDER_UPDATE specifically
          if (operation === 'BATCH_LIST_ORDER_UPDATE') {
            if (tableName !== 'lists' && data.targetTable !== 'lists') { // Allow data.targetTable for flexibility
                 logger.warn(`[SyncController] BATCH_LIST_ORDER_UPDATE received for unexpected table: ${tableName || data.targetTable}. Skipping.`);
                 results.push({
                    operation,
                    clientRecordId: data.operationId || 'N/A', // Client might send an operationId for the batch
                    status: 'error_invalid_batch_table',
                    error: `Batch list order update is only for 'lists' table.`
                });
                continue;
            }
            const listOrders = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : null);
            if (!listOrders) {
                logger.error('[SyncController] BATCH_LIST_ORDER_UPDATE missing or invalid items array in data:', data);
                results.push({
                    operation,
                    clientRecordId: data.operationId || 'N/A',
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
                    clientRecordId: data.operationId || 'batch_success', // Use a general success ID or one from client
                    status: 'batch_updated',
                    message: `Successfully processed batch order update for ${listOrders.length} lists.`
                });
            } catch (batchError) {
                logger.error('[SyncController] Error processing BATCH_LIST_ORDER_UPDATE:', batchError);
                results.push({
                    operation,
                    clientRecordId: data.operationId || 'batch_error',
                    status: 'error_batch_processing',
                    error: batchError.message || 'Failed to process batch list order update.'
                });
            }
            continue; // Move to next change item
          }
          
          // Existing logic for other operations (create, update, delete)
          if (!tableName) {
            logger.warn('[SyncController] Skipping invalid change item (missing tableName for non-batch op):', changeItem);
            continue;
          }

          logger.debug(`[SyncController] Processing operation '${operation}' for table '${tableName}', clientRecordId '${clientRecordId}'`);

          let tableUserIdentifierColumn = getUserIdentifierColumn(tableName);
          
          // Special handling for user_settings table's identifier for WHERE clause
          const isUserSettingsTable = tableName === 'user_settings';

          if (!tableUserIdentifierColumn && !DETAIL_TABLES_MAP[tableName.replace('_details', '')]) {
            logger.error(`[SyncController] CRITICAL: No user identifier column defined for non-detail table ${tableName} in getUserIdentifierColumn. Defaulting to user_id but this needs review.`);
            tableUserIdentifierColumn = 'user_id'; // Fallback, but ideally getUserIdentifierColumn should cover all main tables
          }

          if (operation === 'create') {
            const recordToCreate = { ...data };
            // Ensure the client-provided ID is part of the record to be created
            if (!recordToCreate.id) {
              logger.error(`[SyncController] Create operation for ${tableName} is missing an 'id' in the data payload. ClientRecordId was: ${clientRecordId}. Payload:`, data);
              results.push({ operation, tableName, clientRecordId, status: 'error_missing_id_payload', error: "Missing 'id' in data payload for create operation." });
              continue; // Skip this item
            }
            
            // Ensure owner_id is set correctly based on the authenticated user
            if (!DETAIL_TABLES_MAP[tableName.replace('_details', '')]) { // Not a detail table
                if (tableUserIdentifierColumn) {
                    recordToCreate[tableUserIdentifierColumn] = userId;
                } else {
                     logger.error(`[SyncController] Create: Missing user identifier column for main table ${tableName}. Aborting create for this record.`);
                     results.push({ operation, tableName, clientRecordId, status: 'error_missing_user_column', error: `Missing user identifier column for table ${tableName}` });
                     continue; 
                }
            } else { // Is a detail table, ensure user_id/owner_id if present is set
                if (recordToCreate.hasOwnProperty('user_id')) recordToCreate.user_id = userId;
                else if (recordToCreate.hasOwnProperty('owner_id')) recordToCreate.owner_id = userId;
            }

            recordToCreate.updated_at = new Date();
            if (!recordToCreate.created_at) recordToCreate.created_at = new Date();

            // Prepare baseRecord for insertion, excluding api_metadata for the main list_items insert
            const baseRecord = { ...recordToCreate };
            // Only delete api_metadata and custom_fields if they are NOT actual columns 
            // in the target table. Assuming list_items might have these as JSON/JSONB columns.
            // If they are processed into other fields entirely and not stored as blobs, then delete.
            // For now, let's assume they *could* be columns and avoid deleting if present in data.
            // The specific INSERT query will only use keys present in baseRecord that match table columns.
            
            // delete baseRecord.api_metadata; // Conditional deletion or let DB handle unknown columns
            // delete baseRecord.custom_fields; // Conditional deletion
            delete baseRecord.details; // This was an example, ensure it's not a real field or handle appropriately
            
            const columns = Object.keys(baseRecord).filter(key => key !== '_status' && key !== '_changed'); 
            const values = columns.map(col => baseRecord[col]);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            
            const query = `INSERT INTO ${client.escapeIdentifier(tableName)} (${columns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${placeholders}) RETURNING id`;
            
            let newServerId = recordToCreate.id; 

            try {
                const result = await client.query(query, values);
                if (result.rows[0] && result.rows[0].id !== newServerId) {
                    logger.warn(`[SyncController CREATE ${tableName}] DB returned ID ${result.rows[0].id} which differs from client-provided ID ${newServerId}. Using client's ID as source of truth.`);
                }
                logger.info(`[SyncController] Created record in ${tableName} with actual ID used: ${newServerId}`);
                results.push({ operation, tableName, clientRecordId: newServerId, serverId: newServerId, status: 'created' });

                // --- BEGIN MOVIE DETAILS LOGIC ---
                if (tableName === 'list_items' && data.api_metadata) {
                    const apiMetadata = data.api_metadata;
                    const itemType = apiMetadata.type?.toLowerCase(); // e.g., 'movie', 'book', 'tv'
                    const rawDetails = apiMetadata.raw_details;

                    logger.info(`[SyncController CREATE list_items] Item type: ${itemType}, Raw details found: ${!!rawDetails}`);

                    if (itemType === 'movie' && rawDetails && typeof rawDetails === 'object') {
                        const detailTableName = getDetailTableName(itemType); // Should be 'movie_details'
                        if (detailTableName) {
                            const movieDetailData = {
                                list_item_id: newServerId, // Link to the list_item
                                tmdb_id: rawDetails.tmdb_id || rawDetails.id || apiMetadata.source_id,
                                title: rawDetails.title || rawDetails.tmdb_title || apiMetadata.title, // Prioritize details, fallback to apiMetadata top level
                                overview: rawDetails.overview || rawDetails.tmdb_overview || apiMetadata.description,
                                tagline: rawDetails.tagline || rawDetails.tmdb_tagline,
                                release_date: rawDetails.release_date || rawDetails.tmdb_release_date || apiMetadata.release_date,
                                genres: rawDetails.genres || rawDetails.tmdb_genres, // Assuming array of strings
                                rating: parseFloat(rawDetails.rating || rawDetails.tmdb_vote_average) || null,
                                vote_count: parseInt(rawDetails.vote_count || rawDetails.tmdb_vote_count) || null,
                                runtime_minutes: parseInt(rawDetails.runtime || rawDetails.tmdb_runtime) || null,
                                original_language: rawDetails.original_language || rawDetails.tmdb_original_language,
                                original_title: rawDetails.original_title || rawDetails.tmdb_original_title,
                                popularity: parseFloat(rawDetails.popularity || rawDetails.tmdb_popularity) || null,
                                poster_path: rawDetails.poster_path || rawDetails.tmdb_poster_path,
                                backdrop_path: rawDetails.backdrop_path || rawDetails.tmdb_backdrop_path,
                                // budget, revenue, status, production_companies, etc. can be added if available in rawDetails
                                // Ensure data types match the movie_details DDL (e.g., date, numeric, integer, text[])
                            };
                            
                            // Filter out undefined values to avoid inserting NULL for non-existent keys
                            Object.keys(movieDetailData).forEach(key => movieDetailData[key] === undefined && delete movieDetailData[key]);

                            if (movieDetailData.release_date && isNaN(new Date(movieDetailData.release_date).getTime())) {
                                logger.warn(`[SyncController CREATE movie_details] Invalid release_date format: ${movieDetailData.release_date}. Setting to null.`);
                                movieDetailData.release_date = null;
                            }


                            const detailColumns = Object.keys(movieDetailData);
                            const detailValues = detailColumns.map(col => movieDetailData[col]);
                            const detailPlaceholders = detailColumns.map((_, i) => `$${i + 1}`).join(', ');

                            const detailQuery = `INSERT INTO ${client.escapeIdentifier(detailTableName)} (${detailColumns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${detailPlaceholders}) RETURNING id`;
                            
                            logger.info(`[SyncController CREATE movie_details] Query: ${detailQuery}, Values:`, detailValues);
                            try {
                                const detailResult = await client.query(detailQuery, detailValues);
                                const movieDetailId = detailResult.rows[0]?.id;
                                if (movieDetailId) {
                                    logger.info(`[SyncController] Created record in ${detailTableName} with ID ${movieDetailId}`);
                                    // Now, update the list_items record with the movie_detail_id
                                    const updateListItemQuery = `UPDATE ${client.escapeIdentifier(tableName)} SET movie_detail_id = $1 WHERE id = $2`;
                                    await client.query(updateListItemQuery, [movieDetailId, newServerId]);
                                    logger.info(`[SyncController] Updated list_items ${newServerId} with movie_detail_id ${movieDetailId}`);
                                } else {
                                    logger.error(`[SyncController CREATE movie_details] Failed to get ID from ${detailTableName} insert.`);
                                }
                            } catch (detailInsertError) {
                                logger.error(`[SyncController CREATE movie_details] Error inserting into ${detailTableName} for list_item_id ${newServerId}:`, detailInsertError);
                                // Decide on error handling: rethrow, log, or mark main item?
                                // For now, it logs, and the transaction might proceed without the detail link.
                            }
                        }
                    }
                    // --- BEGIN TV DETAILS LOGIC ---
                    else if (itemType === 'tv' && rawDetails && typeof rawDetails === 'object') {
                        const detailTableName = getDetailTableName(itemType); // Should be 'tv_details'
                        if (detailTableName) {
                            const tvDetailData = {
                                list_item_id: newServerId, // Link to the list_item
                                tmdb_id: rawDetails.tmdb_id || rawDetails.id || apiMetadata.source_id,
                                name: rawDetails.name || rawDetails.tmdb_name || apiMetadata.title,
                                overview: rawDetails.overview || rawDetails.tmdb_overview || apiMetadata.description,
                                tagline: rawDetails.tagline || rawDetails.tmdb_tagline,
                                first_air_date: rawDetails.first_air_date || rawDetails.tmdb_first_air_date || apiMetadata.release_date,
                                last_air_date: rawDetails.last_air_date || rawDetails.tmdb_last_air_date,
                                genres: rawDetails.genres || rawDetails.tmdb_genres, // Assuming array of strings
                                rating: parseFloat(rawDetails.rating || rawDetails.tmdb_vote_average) || null,
                                vote_count: parseInt(rawDetails.vote_count || rawDetails.tmdb_vote_count) || null,
                                episode_run_time: rawDetails.episode_run_time || rawDetails.tmdb_episode_run_time,
                                number_of_episodes: parseInt(rawDetails.number_of_episodes || rawDetails.tmdb_number_of_episodes) || null,
                                number_of_seasons: parseInt(rawDetails.number_of_seasons || rawDetails.tmdb_number_of_seasons) || null,
                                status: rawDetails.status || rawDetails.tmdb_status,
                                type: rawDetails.type || rawDetails.tmdb_type,
                                original_language: rawDetails.original_language || rawDetails.tmdb_original_language,
                                original_name: rawDetails.original_name || rawDetails.tmdb_original_name,
                                popularity: parseFloat(rawDetails.popularity || rawDetails.tmdb_popularity) || null,
                                poster_path: rawDetails.poster_path || rawDetails.tmdb_poster_path,
                                backdrop_path: rawDetails.backdrop_path || rawDetails.tmdb_backdrop_path,
                                production_companies: rawDetails.production_companies || rawDetails.tmdb_production_companies,
                                production_countries: rawDetails.production_countries || rawDetails.tmdb_production_countries,
                                spoken_languages: rawDetails.spoken_languages || rawDetails.tmdb_spoken_languages,
                                in_production: rawDetails.in_production || rawDetails.tmdb_in_production,
                            };
                            
                            // Filter out undefined values to avoid inserting NULL for non-existent keys
                            Object.keys(tvDetailData).forEach(key => tvDetailData[key] === undefined && delete tvDetailData[key]);

                            if (tvDetailData.first_air_date && isNaN(new Date(tvDetailData.first_air_date).getTime())) {
                                logger.warn(`[SyncController CREATE tv_details] Invalid first_air_date format: ${tvDetailData.first_air_date}. Setting to null.`);
                                tvDetailData.first_air_date = null;
                            }

                            if (tvDetailData.last_air_date && isNaN(new Date(tvDetailData.last_air_date).getTime())) {
                                logger.warn(`[SyncController CREATE tv_details] Invalid last_air_date format: ${tvDetailData.last_air_date}. Setting to null.`);
                                tvDetailData.last_air_date = null;
                            }

                            const detailColumns = Object.keys(tvDetailData);
                            const detailValues = detailColumns.map(col => tvDetailData[col]);
                            const detailPlaceholders = detailColumns.map((_, i) => `$${i + 1}`).join(', ');

                            const detailQuery = `INSERT INTO ${client.escapeIdentifier(detailTableName)} (${detailColumns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${detailPlaceholders}) RETURNING id`;
                            
                            logger.info(`[SyncController CREATE tv_details] Query: ${detailQuery}, Values:`, detailValues);
                            try {
                                const detailResult = await client.query(detailQuery, detailValues);
                                const tvDetailId = detailResult.rows[0]?.id;
                                if (tvDetailId) {
                                    logger.info(`[SyncController] Created record in ${detailTableName} with ID ${tvDetailId}`);
                                    // Now, update the list_items record with the tv_detail_id
                                    const updateListItemQuery = `UPDATE ${client.escapeIdentifier(tableName)} SET tv_detail_id = $1 WHERE id = $2`;
                                    await client.query(updateListItemQuery, [tvDetailId, newServerId]);
                                    logger.info(`[SyncController] Updated list_items ${newServerId} with tv_detail_id ${tvDetailId}`);
                                } else {
                                    logger.error(`[SyncController CREATE tv_details] Failed to get ID from ${detailTableName} insert.`);
                                }
                            } catch (detailInsertError) {
                                logger.error(`[SyncController CREATE tv_details] Error inserting into ${detailTableName} for list_item_id ${newServerId}:`, detailInsertError);
                                // Decide on error handling: rethrow, log, or mark main item?
                                // For now, it logs, and the transaction might proceed without the detail link.
                            }
                        }
                    }
                    // --- END TV DETAILS LOGIC ---
                }
                // --- END MOVIE DETAILS LOGIC ---


                await client.query(
                  `INSERT INTO sync_tracking (table_name, record_id, operation) 
                   VALUES ($1, $2, $3)
                   ON CONFLICT (table_name, record_id) DO UPDATE SET
                     operation = EXCLUDED.operation,
                     created_at = NOW(),
                     sync_status = 'pending',
                     last_sync_attempt = NULL,
                     sync_error = NULL`,
                  [tableName, newServerId, operation]
                );
                logger.info(`[SyncController] Added/Updated CREATE in sync_tracking for ${tableName}/${newServerId}`);

            } catch (insertError) {
                logger.error(`[SyncController CREATE ${tableName}] Error inserting record with client-provided ID ${newServerId}:`, insertError);
                results.push({ operation, tableName, clientRecordId, serverId: null, status: 'error_insert_failed', error: insertError.message, detail: insertError.detail });
                // Do not add to sync_tracking if insert failed
                continue; // move to next change item
            }
            // TODO: Handle list_items with details creation if necessary (simplified for now)

          } else if (operation === 'update') {
            const recordToUpdate = { ...data };
            delete recordToUpdate.id; // Remove 'id' if it's the client's local ID from the data payload
            delete recordToUpdate._status; delete recordToUpdate._changed; delete recordToUpdate.details; delete recordToUpdate.created_at;
            
            recordToUpdate.updated_at = new Date();
            logger.info(`[SyncController] Updating record in ${tableName} (Client ID: ${clientRecordId}, User PK: ${data.user_id || clientRecordId}): Payload:`, recordToUpdate);

            if (Object.keys(recordToUpdate).length === 0) {
                logger.warn(`[SyncController] No fields to update for ${tableName} (Client ID: ${clientRecordId}). Skipping.`);
                continue;
            }

            const setClauses = Object.keys(recordToUpdate).map((key, i) => `${client.escapeIdentifier(key)} = $${i + 1}`).join(', ');
            const values = Object.values(recordToUpdate);
            let query;

            if (isUserSettingsTable) {
              if (!data.user_id) {
                logger.error(`[SyncController] Update for user_settings failed: data.user_id is missing. Client ID: ${clientRecordId}`);
                continue;
              }
              values.push(data.user_id); // Use data.user_id for the WHERE clause
              query = `UPDATE ${client.escapeIdentifier(tableName)} SET ${setClauses} WHERE ${client.escapeIdentifier('user_id')} = $${values.length}`;
              logger.info(`[SyncController] UserSettings Update Query: ${query}, Values: `, values);
            } else {
              // Generic update logic for other tables (using clientRecordId which should be the server's actual ID for updates)
              if (!clientRecordId) {
                  logger.error(`[SyncController] Update for ${tableName} failed: clientRecordId is missing.`);
                  continue;
              }
              values.push(clientRecordId); 
              if (tableName === 'users') {
                // For users table, we only allow users to update their own record
                query = `UPDATE ${client.escapeIdentifier(tableName)} SET ${setClauses} WHERE id = $${values.length} AND id = '${userId}'`;
              } else if (tableUserIdentifierColumn) {
                values.push(userId);
                query = `UPDATE ${client.escapeIdentifier(tableName)} SET ${setClauses} WHERE id = $${values.length - 1} AND ${client.escapeIdentifier(tableUserIdentifierColumn)} = $${values.length}`;
              } else { // For detail tables assumed to be updated only by their own id, after parent ownership check
                query = `UPDATE ${client.escapeIdentifier(tableName)} SET ${setClauses} WHERE id = $${values.length}`;
                logger.warn(`[SyncController] Updating detail table ${tableName} without direct user/owner filter by its ID. Ensure parent ownership was checked.`);
              }
            }
            
            logger.info(`[SyncController] Executing Update for ${tableName}: Query: ${query.substring(0, 200)}..., Values Count: ${values.length}`);
            const updateResult = await client.query(query, values);
            logger.info(`[SyncController] Update result for ${tableName} (Client ID: ${clientRecordId}): ${updateResult.rowCount} row(s) affected.`);
            if (updateResult.rowCount > 0) {
              results.push({ operation, tableName, clientRecordId, status: 'updated', affectedRows: updateResult.rowCount }); // Add to results
              // Add to sync_tracking
              const recordIdForSync = isUserSettingsTable ? data.user_id : clientRecordId;
              if (recordIdForSync) { // Ensure we have an ID to track
                await client.query(
                  `INSERT INTO sync_tracking (table_name, record_id, operation) 
                   VALUES ($1, $2, $3)
                   ON CONFLICT (table_name, record_id) DO UPDATE SET
                     operation = EXCLUDED.operation,
                     created_at = NOW(),
                     sync_status = 'pending',
                     last_sync_attempt = NULL,
                     sync_error = NULL`,
                  [tableName, recordIdForSync, operation]
                );
                logger.info(`[SyncController] Added/Updated UPDATE in sync_tracking for ${tableName}/${recordIdForSync}`);

                // WebSocket notification for user_settings
                if (isUserSettingsTable && socketService && recordIdForSync === data.user_id) { 
                  try {
                    logger.info(`[SyncController DEBUG] About to notify user ${data.user_id}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                    await socketService.notifyUser(data.user_id, 'sync_update_available', {
                      message: `User settings updated for user ${data.user_id}`,
                      source: 'push', 
                      changes: [{ 
                          table: 'user_settings', 
                          id: data.user_id,     
                          operation: operation
                      }]
                    });
                    logger.info(`[SyncController] Sent 'sync_update_available' (user_settings) to user ${data.user_id}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                  } catch (wsError) {
                    logger.error(`[SyncController] Error sending WebSocket notification for user_settings update to user ${data.user_id}:`, wsError);
                  }
                }
              } else {
                logger.warn(`[SyncController] Could not add UPDATE to sync_tracking for ${tableName} due to missing record_id. Client ID: ${clientRecordId}`);
              }
            } else if (isUserSettingsTable) {
                logger.warn(`[SyncController] WARN: User settings update for user_id ${data.user_id} affected 0 rows. Does the record exist?`);
                // Even if 0 rows affected, consider it 'processed' from client's perspective if no error thrown
                results.push({ operation, tableName, clientRecordId, status: 'noop_or_not_found', affectedRows: 0 });
            } else {
                 logger.warn(`[SyncController] WARN: Update for ${tableName} ID ${clientRecordId} (User ${userId}) affected 0 rows. Does the record exist and belong to user?`);
                 results.push({ operation, tableName, clientRecordId, status: 'noop_or_not_found', affectedRows: 0 });
            }

            // TODO: Handle list_items with details update if necessary (simplified for now)
            if (tableName === 'list_items' && data.api_metadata) {
                // Logic to find existing movie_detail_id
                // Decide to UPDATE existing movie_detail or INSERT new if not found (and maybe delete old)
                // This is more complex than create.
            }

          } else if (operation === 'delete') {
            if (!clientRecordId) {
                logger.error(`[SyncController] Delete for ${tableName} failed: clientRecordId is missing.`);
                continue;
            }
            logger.info(`[SyncController] Deleting record from ${tableName} (ID: ${clientRecordId})`);
            
            // TODO: Handle list_items with details deletion if necessary (simplified for now)
            let query;
            let deleteResult;
            let recordIdForDeleteSync = clientRecordId; // Default for most tables

            if (isUserSettingsTable) { // user_settings are deleted by user_id, which should match the authenticated userId
                query = `DELETE FROM ${client.escapeIdentifier(tableName)} WHERE ${client.escapeIdentifier('user_id')} = $1`;
                deleteResult = await client.query(query, [userId]); // Use authenticated userId for deletion safety
                recordIdForDeleteSync = userId; // For user_settings, the record_id in sync_tracking should be user_id
            } else {
                if (tableUserIdentifierColumn) {
                    query = `DELETE FROM ${client.escapeIdentifier(tableName)} WHERE id = $1 AND ${client.escapeIdentifier(tableUserIdentifierColumn)} = $2`;
                    deleteResult = await client.query(query, [clientRecordId, userId]);
                } else { // Detail tables without direct user identifier, deletion should be based on parent.
                    query = `DELETE FROM ${client.escapeIdentifier(tableName)} WHERE id = $1`;
                    logger.warn(`[SyncController] Deleting from detail table ${tableName} by ID only. Ensure parent ownership was checked.`);
                    deleteResult = await client.query(query, [clientRecordId]);
                }
            }
            logger.info(`[SyncController] Delete result for ${tableName} (Client ID: ${clientRecordId}): ${deleteResult.rowCount} row(s) affected.`);
            results.push({ operation, tableName, clientRecordId, status: 'deleted', affectedRows: deleteResult.rowCount }); // Add to results

            if (deleteResult.rowCount > 0) {
              // Add to sync_tracking
              if (recordIdForDeleteSync) { // Ensure we have an ID to track
                  await client.query(
                    `INSERT INTO sync_tracking (table_name, record_id, operation) 
                     VALUES ($1, $2, $3)
                     ON CONFLICT (table_name, record_id) DO UPDATE SET
                       operation = EXCLUDED.operation,
                       created_at = NOW(),
                       sync_status = 'pending',
                       last_sync_attempt = NULL,
                       sync_error = NULL`,
                    [tableName, recordIdForDeleteSync, operation]
                  );
                  logger.info(`[SyncController] Added/Updated DELETE in sync_tracking for ${tableName}/${recordIdForDeleteSync}`);

                  // WebSocket notification for user_settings deletion
                  if (isUserSettingsTable && socketService && recordIdForDeleteSync === userId) { 
                     try {
                        logger.info(`[SyncController DEBUG] About to notify user (delete) ${userId}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                        await socketService.notifyUser(userId, 'sync_update_available', {
                            message: `User settings deleted for user ${userId}`,
                            source: 'push',
                            changes: [{
                                table: 'user_settings',
                                id: userId,
                                operation: operation // 'delete'
                            }]
                        });
                        logger.info(`[SyncController] Sent 'sync_update_available' (user_settings delete) to user ${userId}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                    } catch (wsError) {
                        logger.error(`[SyncController] Error sending WebSocket notification for user_settings delete to user ${userId}:`, wsError);
                    }
                  }
              } else {
                  logger.warn(`[SyncController] Could not add DELETE to sync_tracking for ${tableName} due to missing record_id. Client ID was: ${clientRecordId}`);
              }
            }

            // TODO: Handle list_items with details deletion if necessary (simplified for now)
            if (tableName === 'list_items' && data.api_metadata) {
                // Logic to find existing movie_detail_id
                // Decide to DELETE existing movie_detail or UPDATE old if not found (and maybe insert new)
                // This is more complex than create.
            }
          } else {
            logger.warn(`[SyncController] Unknown operation '${operation}' for table '${tableName}'. Skipping.`);
            results.push({ operation, tableName, clientRecordId, status: 'skipped_unknown_operation' });
          }
        }
      });
      // If transaction is successful
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
    const lastPulledAtString = req.query.last_pulled_at; // Prioritize last_pulled_at
    logger.info(`[SyncController] Received req.query.last_pulled_at: '${lastPulledAtString}' (type: ${typeof lastPulledAtString})`);
    let lastPulledAt = 0; // Default to 0 if not provided or unparseable

    if (lastPulledAtString) {
      const parsedDate = Date.parse(lastPulledAtString);
      if (!isNaN(parsedDate)) {
        lastPulledAt = parsedDate;
        logger.info(`[SyncController] Parsed last_pulled_at via Date.parse: ${lastPulledAt}`);
      } else {
        const parsedInt = parseInt(lastPulledAtString, 10);
        if (!isNaN(parsedInt)) {
          lastPulledAt = parsedInt;
          logger.info(`[SyncController] Parsed last_pulled_at via parseInt: ${lastPulledAt}`);
        } else {
          logger.warn(`[SyncController] Could not parse last_pulled_at value: "${lastPulledAtString}". Defaulting to 0.`);
        }
      }
    } else {
      logger.info(`[SyncController] req.query.last_pulled_at was not provided or was empty. Defaulting to 0.`);
    }
    logger.info(`[SyncController] Final parsed lastPulledAt timestamp before use: ${lastPulledAt}`);

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    logger.info(`[SyncController] User ${userId} pulling changes since: ${new Date(lastPulledAt).toISOString()} (timestamp: ${lastPulledAt})`);

    try {
      const changes = {};
      const serverNow = Date.now();
      // Add 'movie_details' and other detail tables as needed
      const allSyncableTables = ['list_items', 'lists', 'user_settings', 'users', 'movie_details', 'tv_details']; 
      
      // console.log('[SyncController] Syncing tables for changes:', allSyncableTables);
      await db.transaction(async (client) => {
        for (const table of allSyncableTables) {
          const userIdentifierColumn = getUserIdentifierColumn(table);
          let createdRecords = [];
          let updatedRecords = [];
          let deletedRecordIds = [];

          if (table === 'movie_details') {
            // console.log(`[SyncController] Processing table: ${table} (special handling for detail table)`);
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
            // Deletion of movie_details is assumed to be handled by client when parent list_item is deleted,
            // as movie_details table does not have its own deleted_at column in the provided DDL.
            deletedRecordIds = []; 

          } else if (userIdentifierColumn) { 
            // console.log(`[SyncController] Processing table: ${table}, Using identifier column: ${userIdentifierColumn}`);
            const updatedQuery = `
              SELECT * FROM ${client.escapeIdentifier(table)} 
              WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND updated_at >= to_timestamp($2 / 1000.0)
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
            
            if (await columnExists(client, table, 'deleted_at')) {
              let selectIdColumnForDeleted = 'id'; 
              // Adjustments for specific tables if their primary ID isn't 'id' or if deleted records are identified differently.
              if (table === 'user_settings') { selectIdColumnForDeleted = `${client.escapeIdentifier('user_id')} AS id`; }
              // Example if 'lists' or 'list_items' used a different column for their ID in a specific context for deletion tracking (unlikely here)

              const deletedQuery = `
                SELECT ${selectIdColumnForDeleted} FROM ${client.escapeIdentifier(table)} 
                WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND deleted_at IS NOT NULL AND deleted_at >= to_timestamp($2 / 1000.0)
              `;
              try {
                const deletedResult = await client.query(deletedQuery, [userId, lastPulledAt]);
                deletedRecordIds = deletedResult.rows.map(r => r.id); 
              } catch (e) {
                 logger.warn(`[SyncController] Could not query deleted records for table ${table}. Error: ${e.message}`);
                 // Potentially rethrow or handle if this is critical: throw e;
              }
            } else {
              logger.warn(`[SyncController] Table ${table} does not have a deleted_at column. Skipping soft delete check for this table.`);
            }
          } else {
            logger.warn(`[SyncController] Skipping table ${table} in pull changes as it has no direct user identifier column and no special handling defined.`);
            changes[table] = { created: [], updated: [], deleted: [] };
            continue;
          }
          changes[table] = {
            created: createdRecords,
            updated: updatedRecords,
            deleted: deletedRecordIds,
          };
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