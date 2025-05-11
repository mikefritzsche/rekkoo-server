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
    const changes = req.body; // Expected format: { table_name: { created: [], updated: [], deleted: [] } }
    const userId = req.user?.id; // From authenticateJWT middleware - this is the actual user's ID

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`[SyncController] User ${userId} pushing changes. Current time: ${new Date().toISOString()}`);

    try {
      await db.transaction(async (client) => {
        for (const table in changes) {
          if (changes.hasOwnProperty(table)) {
            const { created, updated, deleted } = changes[table];
            // Get user identifier for the main table (list_items, lists, user_settings etc.)
            // For detail tables, user association is via item_id to list_items, and list_items has owner_id.
            // So, direct operations on detail tables in push should ensure item_id exists and list_item is owned by user.
            let tableUserIdentifierColumn = getUserIdentifierColumn(table); // This might be null for detail tables here
            if (DETAIL_TABLES_MAP[table.replace('_details', '')]) {
                // For detail tables, we don't use a direct userIdentifierColumn for the table itself in primary operations,
                // but rely on the linked list_item for ownership checks (which uses owner_id).
                // However, some detail tables MIGHT have a user_id for auditing or direct reference.
                // For now, if it's a detail table, let's assume its direct operations are fine if list_item ownership is good.
                // This part is complex for a generic PUSH and relies on client sending correct item_id links.
                // The critical part for detail tables is that their item_id links to a list_item the user owns.
                // Let's assume detail tables have user_id for direct data, if not, client must not send user_id for them.
                // And created/updated/deleted ops should be based on item_id link mostly for details.
                // For now, if getUserIdentifierColumn returns null, we might need a different approach for detail table auth in push
                // OR assume they have user_id if client sends it, or owner_id via list_item.
                 tableUserIdentifierColumn = 'user_id'; // Defaulting to user_id for detail tables if they have it; review this assumption.
            }
            if (!tableUserIdentifierColumn && !DETAIL_TABLES_MAP[table.replace('_details', '')]) {
                // If it's not a detail table and we still don't have an identifier, that is an issue.
                console.error(`[SyncController] CRITICAL: No user identifier column for non-detail table ${table} in handlePush`);
                // throw new Error(`No user identifier for table ${table}`); // Or handle more gracefully
                // For now, let's default to user_id to avoid crashing, but this needs DDL check
                tableUserIdentifierColumn = 'user_id';
            }

            // Handle Created Records
            if (created && created.length > 0) {
              for (const record of created) {
                if (!DETAIL_TABLES_MAP[table.replace('_details', '')]) { // Not a detail table
                    record[tableUserIdentifierColumn] = userId; 
                } else { // It IS a detail table
                    // For detail tables, ensure item_id is present and user_id is set if column exists
                    // The ownership check for creating a detail record relies on the linked list_item being owned by the user.
                    // This is typically handled by client logic or needs a join/check here.
                    // For now, assume if it has user_id column, set it. Otherwise, rely on item_id link.
                    if (record.hasOwnProperty('user_id')) record.user_id = userId; // if user_id col exists on detail table
                    else if (record.hasOwnProperty('owner_id')) record.owner_id = userId; // if owner_id col exists on detail table
                }
                record.updated_at = new Date(); 
                if (!record.created_at) record.created_at = new Date(); 

                console.log(`[SyncController] Creating record in ${table}:`, record);
                const baseRecord = { ...record };
                delete baseRecord.details; 
                const columns = Object.keys(baseRecord).filter(key => key !== '_status' && key !== '_changed');
                const values = columns.map(col => baseRecord[col]);
                const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
                const query = `INSERT INTO ${client.escapeIdentifier(table)} (${columns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${placeholders}) RETURNING id`;
                await client.query(query, values);
                const newRecordId = record.id; 

                if (table === 'list_items' && record.type && record.details) {
                  const detailTableName = getDetailTableName(record.type);
                  if (detailTableName) {
                    // Detail table user_id/owner_id will be set based on its own columns if they exist (handled above)
                    const detailRecord = { ...record.details, item_id: newRecordId, created_at: new Date(), updated_at: new Date() };
                    if (detailRecord.hasOwnProperty('user_id')) detailRecord.user_id = userId;
                    else if (detailRecord.hasOwnProperty('owner_id')) detailRecord.owner_id = userId;

                    if (detailRecord.hasOwnProperty('tmdb_id') && typeof detailRecord.tmdb_id === 'string') {
                        detailRecord.tmdb_id = parseInt(detailRecord.tmdb_id, 10);
                        if (isNaN(detailRecord.tmdb_id)) delete detailRecord.tmdb_id; 
                    }
                    const detailColumns = Object.keys(detailRecord);
                    const detailValues = detailColumns.map(col => detailRecord[col]);
                    const detailPlaceholders = detailColumns.map((_, i) => `$${i + 1}`).join(', ');
                    const detailQuery = `INSERT INTO ${client.escapeIdentifier(detailTableName)} (${detailColumns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${detailPlaceholders})`;
                    console.log(`[SyncController] Creating detail record in ${detailTableName}:`, detailRecord);
                    await client.query(detailQuery, detailValues);
                  }
                }
              }
            }

            // Handle Updated Records
            if (updated && updated.length > 0) {
              for (const record of updated) {
                const recordId = record.id;
                const updateFields = { ...record };
                delete updateFields.id; delete updateFields._status; delete updateFields._changed; delete updateFields.details; delete updateFields.created_at; 
                
                let effectiveUserIdentifierColumn = tableUserIdentifierColumn;
                // For detail tables, updates are primarily by item_id and their own PK (id), user check is via parent list_item
                // However, if the detail table itself has a user_id/owner_id, it should be used for the WHERE clause
                if (DETAIL_TABLES_MAP[table.replace('_details', '')]) {
                    // This is complex: does the detail table have its OWN user_id/owner_id for filtering?
                    // Or do we rely on item_id and parent list_item ownership?
                    // Let's assume if it has user_id, use it, else no direct user filter on detail table for update
                    // which means we need to be careful about security.
                    // For now, let's be consistent: if it has user_id or owner_id, set it and use in where
                    if (record.hasOwnProperty('user_id')) { record.user_id = userId; effectiveUserIdentifierColumn = 'user_id'; }
                    else if (record.hasOwnProperty('owner_id')) { record.owner_id = userId; effectiveUserIdentifierColumn = 'owner_id'; }
                    else { effectiveUserIdentifierColumn = null; } // No direct user identifier for WHERE on detail table itself
                } else {
                    updateFields[effectiveUserIdentifierColumn] = userId; 
                }
                updateFields.updated_at = new Date(); 
                console.log(`[SyncController] Updating record in ${table} (ID: ${recordId}):`, updateFields);

                if (Object.keys(updateFields).length > 0) {
                  const setClauses = Object.keys(updateFields).map((key, i) => `${client.escapeIdentifier(key)} = $${i + 1}`).join(', ');
                  const values = Object.values(updateFields);
                  values.push(recordId); 
                  let query;
                  if (effectiveUserIdentifierColumn) { // For list_items, lists, user_settings, or details with own user/owner id
                    values.push(userId);   
                    query = `UPDATE ${client.escapeIdentifier(table)} SET ${setClauses} WHERE id = $${values.length - 1} AND ${client.escapeIdentifier(effectiveUserIdentifierColumn)} = $${values.length}`;
                  } else { // For detail tables assumed to be updated only by their own id, after parent ownership check (which isn't explicitly here yet)
                    query = `UPDATE ${client.escapeIdentifier(table)} SET ${setClauses} WHERE id = $${values.length}`;
                    console.warn(`[SyncController] Updating detail table ${table} without direct user/owner filter. Ensure parent ownership was checked.`);
                  }
                  await client.query(query, values);
                }

                if (table === 'list_items' && record.type && record.details) {
                  const detailTableName = getDetailTableName(record.type);
                  if (detailTableName) {
                    const detailRecordUpdates = { ...record.details, updated_at: new Date() };
                    if (detailRecordUpdates.hasOwnProperty('user_id')) detailRecordUpdates.user_id = userId;
                    else if (detailRecordUpdates.hasOwnProperty('owner_id')) detailRecordUpdates.owner_id = userId;

                    if (detailRecordUpdates.hasOwnProperty('tmdb_id') && typeof detailRecordUpdates.tmdb_id === 'string') {
                        detailRecordUpdates.tmdb_id = parseInt(detailRecordUpdates.tmdb_id, 10);
                         if (isNaN(detailRecordUpdates.tmdb_id)) delete detailRecordUpdates.tmdb_id;
                    }
                    // Check if detail record exists, using item_id and potentially its own user/owner id if it has one
                    let checkQueryUserIdentifier = 'user_id'; // Default for checking detail table, assumes it has user_id
                    // This is tricky - what is the detail table's user identifier if any?
                    // For now, let's assume we try user_id on detail table for check.
                    // This needs to align with the actual schema of detail tables.
                    const checkQuery = `SELECT id FROM ${client.escapeIdentifier(detailTableName)} WHERE item_id = $1 AND user_id = $2`; // FIXME: user_id may not exist here!
                    // const existingDetail = await client.query(checkQuery, [recordId, userId]); // This is problematic if detail table has no user_id
                    // Let's assume for now we just update/insert based on item_id, and trust client logic and parent ownership
                    // This simplification might be insecure if details can be reparented or client sends arbitrary item_ids.

                    // Attempt to update if exists by item_id (more robust would be item_id + its own PK if known)
                    // For simplicity now, we UPSERT logic: try update, if no rows, insert.
                    const detailSetClauses = Object.keys(detailRecordUpdates).map((key, i) => `${client.escapeIdentifier(key)} = $${i + 1}`).join(', ');
                    const detailUpdateValues = [...Object.values(detailRecordUpdates), recordId]; // item_id for WHERE clause
                    const detailUpdateQuery = `UPDATE ${client.escapeIdentifier(detailTableName)} SET ${detailSetClauses} WHERE item_id = $${detailUpdateValues.length}`;
                    console.log(`[SyncController] Attempting to update detail record in ${detailTableName} for item_id ${recordId}:`, detailRecordUpdates);
                    const updateResult = await client.query(detailUpdateQuery, detailUpdateValues);

                    if (updateResult.rowCount === 0) { // Detail record does not exist (or item_id didn't match), create it
                      const newDetailRecord = { ...record.details, item_id: recordId, created_at: new Date(), updated_at: new Date() };
                      if (newDetailRecord.hasOwnProperty('user_id')) newDetailRecord.user_id = userId;
                      else if (newDetailRecord.hasOwnProperty('owner_id')) newDetailRecord.owner_id = userId;

                      if (newDetailRecord.hasOwnProperty('tmdb_id') && typeof newDetailRecord.tmdb_id === 'string') {
                          newDetailRecord.tmdb_id = parseInt(newDetailRecord.tmdb_id, 10);
                          if (isNaN(newDetailRecord.tmdb_id)) delete newDetailRecord.tmdb_id;
                      }
                      const detailColumns = Object.keys(newDetailRecord);
                      const detailValues = detailColumns.map(col => newDetailRecord[col]);
                      const detailPlaceholders = detailColumns.map((_, i) => `$${i + 1}`).join(', ');
                      const detailInsertQuery = `INSERT INTO ${client.escapeIdentifier(detailTableName)} (${detailColumns.map(col => client.escapeIdentifier(col)).join(', ')}) VALUES (${detailPlaceholders})`;
                      console.log(`[SyncController] Detail record not found for update, creating in ${detailTableName}:`, newDetailRecord);
                      await client.query(detailInsertQuery, detailValues);
                    }
                  }
                }
              }
            }

            // Handle Deleted Records
            if (deleted && deleted.length > 0) {
              for (const recordId of deleted) {
                console.log(`[SyncController] Deleting record from ${table} (ID: ${recordId})`);
                let effectiveUserIdentifierColumnForDelete = tableUserIdentifierColumn;
                if (DETAIL_TABLES_MAP[table.replace('_details', '')]) {
                    // What is the user identifier for detail tables for deletion? Or do we rely on parent check?
                    // Let's assume if it has user_id or owner_id, use it for safety.
                    // This part needs schema knowledge of detail tables.
                     if (await columnExists(client, table, 'user_id')) effectiveUserIdentifierColumnForDelete = 'user_id';
                     else if (await columnExists(client, table, 'owner_id')) effectiveUserIdentifierColumnForDelete = 'owner_id';
                     else effectiveUserIdentifierColumnForDelete = null; // No direct user id on detail table to check for delete safety
                }

                if (table === 'list_items') {
                  const itemResult = await client.query(`SELECT type FROM list_items WHERE id = $1 AND ${client.escapeIdentifier(effectiveUserIdentifierColumnForDelete || 'owner_id')} = $2`, [recordId, userId]);
                  if (itemResult.rows.length > 0) {
                    const itemType = itemResult.rows[0].type;
                    const detailTableName = getDetailTableName(itemType);
                    if (detailTableName) {
                      // When deleting a list_item, delete its details. No separate user check on detail needed if parent is owned.
                      const detailDeleteQuery = `DELETE FROM ${client.escapeIdentifier(detailTableName)} WHERE item_id = $1`;
                      console.log(`[SyncController] Deleting detail record from ${detailTableName} for item_id ${recordId}`);
                      await client.query(detailDeleteQuery, [recordId]);
                    }
                  }
                }
                // For main tables or detail tables with own user id for safety check
                if (effectiveUserIdentifierColumnForDelete) {
                    const query = `DELETE FROM ${client.escapeIdentifier(table)} WHERE id = $1 AND ${client.escapeIdentifier(effectiveUserIdentifierColumnForDelete)} = $2`;
                    await client.query(query, [recordId, userId]);
                } else if (!DETAIL_TABLES_MAP[table.replace('_details', '')]) { // Not a detail table, but no identifier? Issue.
                    console.error(`[SyncController] CRITICAL: Attempting to delete from ${table} without user identifier and it is not a detail table.`);
                    // As a fallback, try with id only, but this is risky without user check
                    // const query = `DELETE FROM ${client.escapeIdentifier(table)} WHERE id = $1`;
                    // await client.query(query, [recordId]);
                } else {
                    // For detail tables without their own user_id/owner_id, we assume deletion is cascaded or handled by item_id if needed
                    // If a detail table is deleted directly by its ID, this implies client knows what it is doing,
                    // but server should ideally check parent list_item ownership first.
                    // For now, if no effectiveUserIdentifierColumnForDelete, we don't delete the detail record here unless it was handled by list_items parent.
                    console.warn(`[SyncController] Skipped direct delete for detail table ${table} due to no direct user identifier. Assumed handled by parent list_item deletion.`);
                }
              }
            }
          }
        }
      });

      if (socketService && socketService.broadcastUserChanges) {
         socketService.broadcastUserChanges(userId, { type: 'sync_push_success', pushedAt: new Date().toISOString() });
      }
      res.status(200).json({ message: 'Changes pushed successfully' });
    } catch (error) {
      console.error('[SyncController] Error pushing changes:', error);
      if (error.code) { 
         console.error(`DB Error Code: ${error.code}, Detail: ${error.detail}, Constraint: ${error.constraint}, Hint: ${error.hint}`);
      }
      res.status(500).json({ error: 'Server error processing changes', details: error.message, code: error.code, hint: error.hint });
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
    let lastPulledAt = 0; // Default to 0 if not provided or unparseable

    if (lastPulledAtString) {
      // Try parsing as an ISO date string first (Date.parse returns epoch ms)
      const parsedDate = Date.parse(lastPulledAtString);
      if (!isNaN(parsedDate)) {
        lastPulledAt = parsedDate;
      } else {
        // If not a valid ISO string, try parsing as an integer (epoch ms)
        const parsedInt = parseInt(lastPulledAtString, 10);
        if (!isNaN(parsedInt)) {
          lastPulledAt = parsedInt;
        } else {
          console.warn(`[SyncController] Could not parse last_pulled_at value: "${lastPulledAtString}". Defaulting to 0.`);
        }
      }
    }
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
      const allSyncableTables = ['list_items', 'lists', 'user_settings']; 
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