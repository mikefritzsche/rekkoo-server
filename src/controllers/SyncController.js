// server/src/controllers/SyncController.js
const db = require('../config/db'); // Ensure this path is correct

// Define detail tables that are associated with records in the 'list_items' table
const DETAIL_TABLES_MAP = {
  movie: 'movie_details',
  book: 'book_details',
  place: 'place_details',
  spotify_item: 'spotify_item_details', // Assuming 'spotify_item' is the type used in 'list_items' table
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
    // For any other table, including detail tables, we are saying there is no direct user identifier for the generic pull.
    // This means they won't be processed in the main loop of handleGetChanges for direct user-filtered updates/deletes.
    console.warn(`[SyncController] Table '${tableName}' will not be processed by user-identifier in handleGetChanges main loop.`);
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
      console.error('[SyncController] Push failed: req.body.changes is not an array. Received:', req.body);
      return res.status(400).json({ error: 'Invalid payload format: "changes" must be an array.' });
    }

    console.log(`[SyncController] User ${userId} pushing ${clientChangesArray.length} changes. Current time: ${new Date().toISOString()}`);

    try {
      await db.transaction(async (client) => {
        for (const changeItem of clientChangesArray) {
          const { table_name: tableName, operation, record_id: clientRecordId, data } = changeItem;

          if (!tableName || !operation || !data) {
            console.warn('[SyncController] Skipping invalid change item:', changeItem);
            continue;
          }

          console.log(`[SyncController] Processing operation '${operation}' for table '${tableName}', clientRecordId '${clientRecordId}'`);

          let tableUserIdentifierColumn = getUserIdentifierColumn(tableName);
          
          // Special handling for user_settings table's identifier for WHERE clause
          const isUserSettingsTable = tableName === 'user_settings';

          if (!tableUserIdentifierColumn && !DETAIL_TABLES_MAP[tableName.replace('_details', '')]) {
            console.error(`[SyncController] CRITICAL: No user identifier column defined for non-detail table ${tableName} in getUserIdentifierColumn. Defaulting to user_id but this needs review.`);
            tableUserIdentifierColumn = 'user_id'; // Fallback, but ideally getUserIdentifierColumn should cover all main tables
          }

          if (operation === 'create') {
            const recordToCreate = { ...data };
            // Ensure the client-provided ID is part of the record to be created
            if (!recordToCreate.id) {
              console.error(`[SyncController] Create operation for ${tableName} is missing an 'id' in the data payload. ClientRecordId was: ${clientRecordId}. Payload:`, data);
              results.push({ operation, tableName, clientRecordId, status: 'error_missing_id_payload', error: "Missing 'id' in data payload for create operation." });
              continue; // Skip this item
            }
            
            // Ensure owner_id is set correctly based on the authenticated user
            if (!DETAIL_TABLES_MAP[tableName.replace('_details', '')]) { // Not a detail table
                if (tableUserIdentifierColumn) {
                    recordToCreate[tableUserIdentifierColumn] = userId;
                } else {
                     console.error(`[SyncController] Create: Missing user identifier column for main table ${tableName}. Aborting create for this record.`);
                     results.push({ operation, tableName, clientRecordId, status: 'error_missing_user_column', error: `Missing user identifier column for table ${tableName}` });
                     continue; 
                }
            } else { // Is a detail table, ensure user_id/owner_id if present is set
                if (recordToCreate.hasOwnProperty('user_id')) recordToCreate.user_id = userId;
                else if (recordToCreate.hasOwnProperty('owner_id')) recordToCreate.owner_id = userId;
            }

            recordToCreate.updated_at = new Date();
            if (!recordToCreate.created_at) recordToCreate.created_at = new Date();

            if (tableName === 'list_items') {
                console.log(`[SyncController handlePush CREATE list_items] User ${userId} creating list_item. Full recordToCreate (using client ID ${recordToCreate.id}):`, JSON.stringify(recordToCreate));
            } else {
                console.log(`[SyncController] Creating record in ${tableName} (using client ID ${recordToCreate.id}):`, recordToCreate);
            }
            
            const baseRecord = { ...recordToCreate };
            delete baseRecord.details; // Example of a field not directly in the table
            
            // MODIFIED: Include 'id' from baseRecord (which is from client's data)
            const columns = Object.keys(baseRecord).filter(key => key !== '_status' && key !== '_changed'); 
            const values = columns.map(col => baseRecord[col]);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            
            const query = `INSERT INTO ${client.escapeIdentifier(tableName)} (${columns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${placeholders}) RETURNING id`;
            
            let newServerId = recordToCreate.id; // Assume client's ID will be used and returned

            try {
                const result = await client.query(query, values);
                // If RETURNING id gives back something different, log it, but we intend to use client's.
                // For most UUID setups where client provides ID, DB won't generate a new one if column default isn't overriding.
                if (result.rows[0] && result.rows[0].id !== newServerId) {
                    console.warn(`[SyncController CREATE ${tableName}] DB returned ID ${result.rows[0].id} which differs from client-provided ID ${newServerId}. Using client's ID as source of truth.`);
                }
                console.log(`[SyncController] Created record in ${tableName} with actual ID used: ${newServerId}`);
                results.push({ operation, tableName, clientRecordId: newServerId, serverId: newServerId, status: 'created' });

                // Add to sync_tracking using the client-provided (and now server-used) ID
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
                console.log(`[SyncController] Added/Updated CREATE in sync_tracking for ${tableName}/${newServerId}`);

            } catch (insertError) {
                console.error(`[SyncController CREATE ${tableName}] Error inserting record with client-provided ID ${newServerId}:`, insertError);
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
            console.log(`[SyncController] Updating record in ${tableName} (Client ID: ${clientRecordId}, User PK: ${data.user_id || clientRecordId}): Payload:`, recordToUpdate);

            if (Object.keys(recordToUpdate).length === 0) {
                console.warn(`[SyncController] No fields to update for ${tableName} (Client ID: ${clientRecordId}). Skipping.`);
                continue;
            }

            const setClauses = Object.keys(recordToUpdate).map((key, i) => `${client.escapeIdentifier(key)} = $${i + 1}`).join(', ');
            const values = Object.values(recordToUpdate);
            let query;

            if (isUserSettingsTable) {
              if (!data.user_id) {
                console.error(`[SyncController] Update for user_settings failed: data.user_id is missing. Client ID: ${clientRecordId}`);
                continue;
              }
              values.push(data.user_id); // Use data.user_id for the WHERE clause
              query = `UPDATE ${client.escapeIdentifier(tableName)} SET ${setClauses} WHERE ${client.escapeIdentifier('user_id')} = $${values.length}`;
              console.log(`[SyncController] UserSettings Update Query: ${query}, Values: `, values);
            } else {
              // Generic update logic for other tables (using clientRecordId which should be the server's actual ID for updates)
              if (!clientRecordId) {
                  console.error(`[SyncController] Update for ${tableName} failed: clientRecordId is missing.`);
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
                console.warn(`[SyncController] Updating detail table ${tableName} without direct user/owner filter by its ID. Ensure parent ownership was checked.`);
              }
            }
            
            console.log(`[SyncController] Executing Update for ${tableName}: Query: ${query.substring(0, 200)}..., Values Count: ${values.length}`);
            const updateResult = await client.query(query, values);
            console.log(`[SyncController] Update result for ${tableName} (Client ID: ${clientRecordId}): ${updateResult.rowCount} row(s) affected.`);
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
                console.log(`[SyncController] Added/Updated UPDATE in sync_tracking for ${tableName}/${recordIdForSync}`);

                // WebSocket notification for user_settings
                if (isUserSettingsTable && socketService && recordIdForSync === data.user_id) { 
                  try {
                    console.log(`[SyncController DEBUG] About to notify user ${data.user_id}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                    await socketService.notifyUser(data.user_id, 'sync_update_available', {
                      message: `User settings updated for user ${data.user_id}`,
                      source: 'push', 
                      changes: [{ 
                          table: 'user_settings', 
                          id: data.user_id,     
                          operation: operation
                      }]
                    });
                    console.log(`[SyncController] Sent 'sync_update_available' (user_settings) to user ${data.user_id}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                  } catch (wsError) {
                    console.error(`[SyncController] Error sending WebSocket notification for user_settings update to user ${data.user_id}:`, wsError);
                  }
                }
              } else {
                console.warn(`[SyncController] Could not add UPDATE to sync_tracking for ${tableName} due to missing record_id. Client ID: ${clientRecordId}`);
              }
            } else if (isUserSettingsTable) {
                console.warn(`[SyncController] WARN: User settings update for user_id ${data.user_id} affected 0 rows. Does the record exist?`);
                // Even if 0 rows affected, consider it 'processed' from client's perspective if no error thrown
                results.push({ operation, tableName, clientRecordId, status: 'noop_or_not_found', affectedRows: 0 });
            } else {
                 console.warn(`[SyncController] WARN: Update for ${tableName} ID ${clientRecordId} (User ${userId}) affected 0 rows. Does the record exist and belong to user?`);
                 results.push({ operation, tableName, clientRecordId, status: 'noop_or_not_found', affectedRows: 0 });
            }

            // TODO: Handle list_items with details update if necessary (simplified for now)

          } else if (operation === 'delete') {
            if (!clientRecordId) {
                console.error(`[SyncController] Delete for ${tableName} failed: clientRecordId is missing.`);
                continue;
            }
            console.log(`[SyncController] Deleting record from ${tableName} (ID: ${clientRecordId})`);
            
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
                    console.warn(`[SyncController] Deleting from detail table ${tableName} by ID only. Ensure parent ownership was checked.`);
                    deleteResult = await client.query(query, [clientRecordId]);
                }
            }
            console.log(`[SyncController] Delete result for ${tableName} (Client ID: ${clientRecordId}): ${deleteResult.rowCount} row(s) affected.`);
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
                  console.log(`[SyncController] Added/Updated DELETE in sync_tracking for ${tableName}/${recordIdForDeleteSync}`);

                  // WebSocket notification for user_settings deletion
                  if (isUserSettingsTable && socketService && recordIdForDeleteSync === userId) { 
                     try {
                        console.log(`[SyncController DEBUG] About to notify user (delete) ${userId}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                        await socketService.notifyUser(userId, 'sync_update_available', {
                            message: `User settings deleted for user ${userId}`,
                            source: 'push',
                            changes: [{
                                table: 'user_settings',
                                id: userId,
                                operation: operation // 'delete'
                            }]
                        });
                        console.log(`[SyncController] Sent 'sync_update_available' (user_settings delete) to user ${userId}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
                    } catch (wsError) {
                        console.error(`[SyncController] Error sending WebSocket notification for user_settings delete to user ${userId}:`, wsError);
                    }
                  }
              } else {
                  console.warn(`[SyncController] Could not add DELETE to sync_tracking for ${tableName} due to missing record_id. Client ID was: ${clientRecordId}`);
              }
            }
          } else {
            console.warn(`[SyncController] Unknown operation '${operation}' for table '${tableName}'. Skipping.`);
            results.push({ operation, tableName, clientRecordId, status: 'skipped_unknown_operation' });
          }
        }
      });
      // If transaction is successful
      res.status(200).json({ success: true, message: 'Changes pushed and processed successfully.', results });
    } catch (error) {
      console.error('[SyncController] Push error:', error);
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
    console.log(`[SyncController] Received req.query.last_pulled_at: '${lastPulledAtString}' (type: ${typeof lastPulledAtString})`);
    let lastPulledAt = 0; // Default to 0 if not provided or unparseable

    if (lastPulledAtString) {
      // Try parsing as an ISO date string first (Date.parse returns epoch ms)
      const parsedDate = Date.parse(lastPulledAtString);
      if (!isNaN(parsedDate)) {
        lastPulledAt = parsedDate;
        console.log(`[SyncController] Parsed last_pulled_at via Date.parse: ${lastPulledAt}`);
      } else {
        // If not a valid ISO string, try parsing as an integer (epoch ms)
        const parsedInt = parseInt(lastPulledAtString, 10);
        if (!isNaN(parsedInt)) {
          lastPulledAt = parsedInt;
          console.log(`[SyncController] Parsed last_pulled_at via parseInt: ${lastPulledAt}`);
        } else {
          console.warn(`[SyncController] Could not parse last_pulled_at value: "${lastPulledAtString}". Defaulting to 0.`);
        }
      }
    } else {
      console.log(`[SyncController] req.query.last_pulled_at was not provided or was empty. Defaulting to 0.`);
    }
    // Ensure final parsed value is logged before use
    console.log(`[SyncController] Final parsed lastPulledAt timestamp before use: ${lastPulledAt}`);

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    console.log(`[SyncController] User ${userId} pulling changes since: ${new Date(lastPulledAt).toISOString()} (timestamp: ${lastPulledAt})`);

    try {
      const diagnosticQueryResult = await db.query(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');"
      );
    } catch (diagError) {
      console.error('[SyncController DIAGNOSTIC] Error querying information_schema.tables:', diagError);
    }

    try {
      const changes = {};
      const serverNow = Date.now();
      // Only sync tables that can be directly filtered by a user identifier in this generic pull
      const allSyncableTables = ['list_items', 'lists', 'user_settings', 'users'];
      // Detail tables (movie_details, etc.) are implicitly synced via their parent list_items in WatermelonDB
      // or would need a more specific pull mechanism if their changes are independent of parent list_item updated_at.
      console.log('[SyncController] Syncing main tables for changes:', allSyncableTables);
      await db.transaction(async (client) => {
        for (const table of allSyncableTables) {
          const userIdentifierColumn = getUserIdentifierColumn(table);

          if (userIdentifierColumn === null) {
            // This case should not be hit if allSyncableTables is correctly filtered
            console.warn(`[SyncController] Skipping table ${table} as it has no direct user identifier for pull.`);
            changes[table] = { created: [], updated: [], deleted: [] };
            continue;
          } 
          
          console.log(`[SyncController] Processing table: ${table}, Using identifier column: ${userIdentifierColumn}`);
          const updatedQuery = `
            SELECT * FROM ${client.escapeIdentifier(table)} 
            WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND updated_at >= to_timestamp($2 / 1000.0)
          `;
          const updatedResult = await client.query(updatedQuery, [userId, lastPulledAt]);
          const createdRecords = [];
          const updatedRecords = [];
          updatedResult.rows.forEach(record => {
            record.updated_at = new Date(record.updated_at).getTime();
            record.created_at = new Date(record.created_at).getTime();
            if (record.created_at >= lastPulledAt) {
              createdRecords.push(record);
            } else {
              updatedRecords.push(record);
            }
          });
          
          let deletedRecordIds = [];
          // Only attempt soft delete query if the table is supposed to have a user identifier and deleted_at
          // And we have a valid column to SELECT as the ID for deleted records
          if (userIdentifierColumn) { 
            try {
              let selectIdColumnForDeleted = 'id'; 
              if (table === 'user_settings') {
                selectIdColumnForDeleted = `${client.escapeIdentifier('user_id')} AS id`; 
              } else if (userIdentifierColumn === 'owner_id') { 
                selectIdColumnForDeleted = `${client.escapeIdentifier('owner_id')} AS id`;
              } 
              // Ensure the table actually has a deleted_at column before trying to query it.
              if (await columnExists(client, table, 'deleted_at')) {
                const deletedQuery = `
                  SELECT ${selectIdColumnForDeleted} FROM ${client.escapeIdentifier(table)} 
                  WHERE ${client.escapeIdentifier(userIdentifierColumn)} = $1 AND deleted_at IS NOT NULL AND deleted_at >= to_timestamp($2 / 1000.0)
                `;
                const deletedResult = await client.query(deletedQuery, [userId, lastPulledAt]);
                deletedRecordIds = deletedResult.rows.map(r => r.id); 
              } else {
                console.warn(`[SyncController] Table ${table} does not have a deleted_at column. Skipping soft delete check.`);
              }
            } catch (e) {
               console.warn(`[SyncController] Could not query deleted records for table ${table}. Error: ${e.message}`);
               throw e; 
            }
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
      console.error('[SyncController] Error pulling changes:', error);
      res.status(500).json({ error: 'Server error pulling changes', details: error.message, code: error.code, hint: error.hint });
    }
  };

  const handleGetState = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    console.log(`[SyncController] User ${userId} requesting full initial state.`);
    // Implement fetching all necessary data for the user for an initial sync.
    // This is usually a larger payload than pullChanges.
    res.status(501).json({ message: 'Not implemented: Full state retrieval' });
  };

  const handleGetRecord = async (req, res) => {
    const { table, id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });

    console.log(`[SyncController] User ${userId} requesting record: ${table}/${id}`);
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
      console.error(`[SyncController] Error getting record ${table}/${id}:`, error);
      res.status(500).json({ error: 'Server error getting record', details: error.message, code: error.code, hint: error.hint });
    }
  };
  
  const handleGetConflicts = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    console.log(`[SyncController] User ${userId} requesting sync conflicts.`);
    // Conflict resolution logic would typically involve comparing client and server versions
    // and potentially storing conflicts for manual resolution.
    res.status(200).json({ conflicts: [] }); // Placeholder
  };

  const handleGetQueue = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    console.log(`[SyncController] User ${userId} requesting sync queue status.`);
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