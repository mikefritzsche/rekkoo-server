// src/routes/sync.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware'); // Adjust path if needed
const { pool, query, transaction } = require('../config/db'); // Adjust path if needed
const validateListData = require('../middleware/validate-list-data'); // Adjust path if needed

// --- Export a function that takes socketService ---
module.exports = (socketService) => {
  const router = express.Router(); // Create router inside the function

  // Get sync state (pull changes) - No socketService needed here
  router.get('/changes', authenticateJWT, async (req, res) => {
    const logPrefix = `[${new Date().toISOString()}] [GET /sync/changes] User ${req.user?.id || 'UNKNOWN'}:`;
    try {
      const { lastSyncTime } = req.query;
      const userId = req.user.id; // Provided by authenticateJWT

      if (!userId) {
        console.error(`${logPrefix} Error: User ID not found after authentication.`);
        return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
      }
      if (!lastSyncTime || isNaN(new Date(lastSyncTime).getTime())) {
        console.warn(`${logPrefix} Invalid or missing lastSyncTime. Query:`, req.query);
        return res.status(400).json({ message: 'Valid lastSyncTime query parameter is required.' });
      }

      const timestamp = new Date(lastSyncTime);
      console.log(`${logPrefix} Fetching changes since ${timestamp.toISOString()}`);

      // Optimized query: Join ownership check directly
      const changes = await query(
        `SELECT st.*,
                CASE
                  WHEN st.table_name = 'lists' THEN l.title
                  WHEN st.table_name = 'items' THEN i.title
                  ELSE NULL
                END as record_title
         FROM sync_tracking st
         LEFT JOIN lists l ON st.table_name = 'lists' AND st.record_id::uuid = l.id AND l.owner_id = $2::uuid -- Join owner check
         LEFT JOIN items i ON st.table_name = 'items' AND st.record_id::uuid = i.id AND i.list_id IN (SELECT id FROM lists WHERE owner_id = $2::uuid) -- Join owner check via list
         WHERE st.created_at > $1
           AND st.deleted_at IS NULL
           AND (l.owner_id = $2::uuid OR i.list_id IS NOT NULL) -- Ensure at least one join matched owner
         ORDER BY st.created_at ASC`,
        [timestamp, userId]
      );

      console.log(`${logPrefix} Found ${changes.rows.length} changes.`);
      res.json(changes.rows);
    } catch (error) {
      console.error(`${logPrefix} Pull changes error:`, error);
      res.status(500).json({ message: 'Failed to fetch changes' });
    }
  });

  // Push changes - <<< INTEGRATE socketService HERE >>>
  router.post('/push', authenticateJWT, validateListData, async (req, res) => {
    const userId = req.user.id; // Provided by authenticateJWT
    const logPrefix = `[${new Date().toISOString()}] [POST /sync/push] User ${userId || 'UNKNOWN'}:`;

    if (!userId) {
      console.error(`${logPrefix} Error: User ID not found after authentication.`);
      return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
    }

    const client = await pool.connect();
    console.log(`${logPrefix} Starting push transaction.`);

    try {
      await client.query('BEGIN');

      const { changes } = req.body;
      if (!Array.isArray(changes)) {
        console.error(`${logPrefix} Invalid input: Changes must be an array.`);
        await client.query('ROLLBACK'); // Rollback before sending error response
        return res.status(400).json({ success: false, error: 'Changes must be an array' });
      }
      if (changes.length === 0) {
        console.log(`${logPrefix} Received empty changes array. Nothing to push.`);
        await client.query('ROLLBACK'); // No changes, no need for transaction
        return res.json({ success: true, results: [], message: "No changes provided." });
      }


      console.log(`${logPrefix} Processing ${changes.length} changes.`);
      const results = [];
      let changesMade = false; // Track if any actual DB modification occurred

      for (const change of changes) {
        const { table_name, record_id, operation, data } = change;
        const changeLogPrefix = `${logPrefix} Change [${table_name}/${record_id}/${operation}]:`;

        // Basic validation
        if (!table_name || !record_id || !operation || !['lists', 'items'].includes(table_name) || !['create', 'update', 'delete'].includes(operation)) {
          console.error(`${changeLogPrefix} Invalid change structure/values.`);
          throw new Error(`Invalid change structure for record ${record_id || 'MISSING_ID'}. Table: ${table_name}, Op: ${operation}`);
        }
        if ((operation === 'create' || operation === 'update') && !data) {
          console.error(`${changeLogPrefix} Missing data for create/update.`);
          throw new Error(`Data is required for ${operation} operation on ${table_name}/${record_id}`);
        }

        let filteredData = null;
        if (data) {
          filteredData = { ...data };
          // Remove potentially problematic fields (adjust based on your actual schema needs)
          delete filteredData.id; // Should use record_id
          delete filteredData.owner_id; // Should be set server-side based on authenticated user
          delete filteredData.created_at;
          delete filteredData.updated_at;
          delete filteredData.deleted_at;
          delete filteredData.owner_server_id; // Example potentially client-only field
          delete filteredData.sharing_permissions; // Read-only field

          // Specific handling for JSON fields, etc.
          if (table_name === 'lists' && filteredData.background && typeof filteredData.background !== 'string') {
            filteredData.background = JSON.stringify(filteredData.background);
          }
          // Add more specific data filtering/validation as needed
        }

        // Determine actual owner_id for filtering/insertion
        // For items, the owner is the owner of the list it belongs to.
        // For lists, the owner is directly the user.
        let recordOwnerId = userId; // Default to the pusher for lists
        let listIdForItem = null;
        if (table_name === 'items') {
          listIdForItem = data?.list_id; // Get list_id from incoming data for new items
          if (!listIdForItem && operation === 'create') {
            throw new Error(`Missing list_id for creating item ${record_id}`);
          }
        }

        // Process the operation
        switch (operation) {
          case 'create': {
            console.log(`${changeLogPrefix} Attempting to create.`);
            // Check for existing (soft-deleted or active) to prevent ID collision if client reuses IDs improperly
            const collisionCheck = await client.query(`SELECT id FROM ${table_name} WHERE id = $1::uuid`, [record_id]);
            if (collisionCheck.rows.length > 0) {
              console.warn(`${changeLogPrefix} Record already exists (possibly soft-deleted). Rejecting create.`);
              // Option 1: Throw error
              throw new Error(`Cannot create record ${record_id}, ID already exists.`);
              // Option 2: Treat as update (more complex, needs careful handling)
              // results.push({ success: false, operation, record_id, error: 'Record already exists' });
              // continue; // Skip to next change
            }

            const columns = Object.keys(filteredData);
            const values = Object.values(filteredData);
            const valuePlaceholders = columns.map((_, i) => `$${i + 2}`).join(', ');

            // Add owner_id correctly
            let insertOwnerId = userId;
            if (table_name === 'items') {
              if (!listIdForItem) throw new Error(`Cannot determine list_id for creating item ${record_id}`);
              // Verify pusher owns the target list
              const listOwnerCheck = await client.query(`SELECT owner_id FROM lists WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL`, [listIdForItem, userId]);
              if (listOwnerCheck.rows.length === 0) {
                throw new Error(`User ${userId} does not own the target list ${listIdForItem} for item creation.`);
              }
              insertOwnerId = userId; // Items are owned by the list owner implicitly through list_id
            }

            const finalColumns = ['id', ...columns];
            // Add owner_id to query if it's a direct column (like in 'lists')
            if (table_name === 'lists') {
              finalColumns.push('owner_id');
            }

            const finalPlaceholders = ['$1::uuid', ...valuePlaceholders];
            if (table_name === 'lists') {
              finalPlaceholders.push(`$${columns.length + 2}::uuid`);
            }

            const finalValues = [record_id, ...values];
            if (table_name === 'lists') {
              finalValues.push(insertOwnerId);
            }


            const insertResult = await client.query(
              `INSERT INTO ${table_name} (${finalColumns.join(', ')}) VALUES (${finalPlaceholders.join(', ')}) RETURNING id`,
              finalValues
            );
            if (insertResult.rowCount === 1) {
              console.log(`${changeLogPrefix} Created successfully.`);
              changesMade = true;
            } else {
              console.error(`${changeLogPrefix} Failed to create.`);
              throw new Error(`Database insert failed for ${record_id}`);
            }
            break;
          } // end case 'create'

          case 'update': {
            console.log(`${changeLogPrefix} Attempting to update.`);
            if (!filteredData || Object.keys(filteredData).length === 0) {
              console.warn(`${changeLogPrefix} No valid data provided for update. Skipping.`);
              results.push({ success: false, operation, record_id, error: 'No data to update' });
              continue; // Skip to next change
            }

            // Verify ownership before update
            let ownerCheckField = 'owner_id';
            let ownerCheckValue = userId;
            if (table_name === 'items') {
              // For items, check if the user owns the list the item belongs to
              const itemCheck = await client.query(`SELECT l.owner_id FROM items i JOIN lists l ON i.list_id = l.id WHERE i.id = $1::uuid AND i.deleted_at IS NULL`, [record_id]);
              if (itemCheck.rows.length === 0) throw new Error(`Item ${record_id} not found or already deleted.`);
              if (itemCheck.rows[0].owner_id !== userId) throw new Error(`User ${userId} does not own the list containing item ${record_id}.`);
            } else { // 'lists' table
              const listCheck = await client.query(`SELECT owner_id FROM lists WHERE id = $1::uuid AND deleted_at IS NULL`, [record_id]);
              if (listCheck.rows.length === 0) throw new Error(`List ${record_id} not found or already deleted.`);
              if (listCheck.rows[0].owner_id !== userId) throw new Error(`User ${userId} does not own list ${record_id}.`);
            }


            const updateClauses = Object.keys(filteredData).map((key, i) => `${key} = $${i + 2}`);
            const updateValues = [record_id, ...Object.values(filteredData)];

            const updateResult = await client.query(
              `UPDATE ${table_name}
               SET ${updateClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1::uuid AND deleted_at IS NULL
               RETURNING id`, // Check ownership implicitly via previous query/logic
              updateValues
            );

            if (updateResult.rowCount === 1) {
              console.log(`${changeLogPrefix} Updated successfully.`);
              changesMade = true;
            } else {
              console.warn(`${changeLogPrefix} Update failed (maybe record deleted concurrently?).`);
              // Don't throw, but report failure for this change
              results.push({ success: false, operation, record_id, error: 'Update failed, record potentially missing or deleted' });
              continue; // Move to next change
            }
            break;
          } // end case 'update'

          case 'delete': {
            console.log(`${changeLogPrefix} Attempting to soft delete.`);
            // Verify ownership before delete (similar to update)
            if (table_name === 'items') {
              const itemCheck = await client.query(`SELECT l.owner_id FROM items i JOIN lists l ON i.list_id = l.id WHERE i.id = $1::uuid AND i.deleted_at IS NULL`, [record_id]);
              if (itemCheck.rows.length === 0) {
                console.warn(`${changeLogPrefix} Item not found or already deleted. Skipping delete.`);
                results.push({ success: true, operation, record_id, message: 'Already deleted or not found' }); // Idempotent success
                continue;
              }
              if (itemCheck.rows[0].owner_id !== userId) throw new Error(`User ${userId} does not own the list containing item ${record_id}. Cannot delete.`);
            } else { // 'lists' table
              const listCheck = await client.query(`SELECT owner_id FROM lists WHERE id = $1::uuid AND deleted_at IS NULL`, [record_id]);
              if (listCheck.rows.length === 0) {
                console.warn(`${changeLogPrefix} List not found or already deleted. Skipping delete.`);
                results.push({ success: true, operation, record_id, message: 'Already deleted or not found' }); // Idempotent success
                continue;
              }
              if (listCheck.rows[0].owner_id !== userId) throw new Error(`User ${userId} does not own list ${record_id}. Cannot delete.`);
            }

            // Perform soft delete
            const deleteResult = await client.query(
              `UPDATE ${table_name} SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1::uuid AND deleted_at IS NULL
               RETURNING id`,
              [record_id]
            );

            if (deleteResult.rowCount === 1) {
              console.log(`${changeLogPrefix} Soft deleted successfully.`);
              changesMade = true;
              // Optional: If deleting a list, maybe soft delete its items too? Add that logic here if needed.
            } else {
              console.warn(`${changeLogPrefix} Soft delete failed (maybe record already deleted?). Treating as success.`);
              // Idempotent success if already deleted
            }
            break;
          } // end case 'delete'
        } // end switch

        // Only record success if the operation was attempted and didn't throw/continue earlier
        const existingResultIndex = results.findIndex(r => r.record_id === record_id);
        if (existingResultIndex === -1) {
          results.push({ success: true, operation, record_id });
        } else {
          // Update existing result if needed (e.g., if a create was skipped but delete succeeded)
          results[existingResultIndex] = { success: true, operation, record_id };
        }

        // Update or insert sync tracking record AFTER successful operation
        // We track the *original* client data for potential conflict resolution later
        await client.query(
          `INSERT INTO sync_tracking
               (table_name, record_id, operation, data, created_at, user_id) -- Added user_id
           VALUES ($1, $2::uuid, $3, $4, CURRENT_TIMESTAMP, $5::uuid)
           ON CONFLICT (table_name, record_id) DO UPDATE SET
             operation = EXCLUDED.operation,
             data = EXCLUDED.data,
             created_at = CURRENT_TIMESTAMP,
             user_id = EXCLUDED.user_id, -- Ensure user_id is updated too
             deleted_at = NULL -- IMPORTANT: Undelete tracking record on new push
             `,
          [table_name, record_id, operation, JSON.stringify(data || {}), userId] // Store original client data
        );

      } // end for loop over changes

      await client.query('COMMIT');
      console.log(`${logPrefix} Transaction committed successfully.`);

      // <<< --- SOCKET.IO INTEGRATION --- >>>
      // Notify other clients of the same user *if* any changes were actually made
      if (changesMade && socketService) {
        const eventName = 'sync_update_available';
        const payload = { timestamp: new Date().toISOString() }; // Simple payload
        try {
          // Use the specific method from your service to target the user
          socketService.emitToUser(userId, eventName, payload);
          console.log(`${logPrefix} Emitted '${eventName}' via WebSocket to user ${userId}`);
        } catch (socketEmitError) {
          console.error(`${logPrefix} !!! Failed to emit WebSocket message to user ${userId}:`, socketEmitError);
          // Log the error, but don't fail the successful HTTP response
        }
      } else if (changesMade && !socketService) {
        console.warn(`${logPrefix} Changes committed, but socketService is not available to emit notification.`);
      }
      // <<< --- END SOCKET.IO INTEGRATION --- >>>

      res.json({ success: true, results });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`${logPrefix} Push changes transaction error:`, error);
      res.status(500).json({
        success: false,
        error: 'Failed to process changes',
        details: error.message // Send back specific error message for debugging
      });
    } finally {
      client.release();
      console.log(`${logPrefix} DB client released.`);
    }
  });


  // --- Other Routes (No socketService needed) ---

  // Get full initial state
  router.get('/state', authenticateJWT, async (req, res) => {
    const userId = req.user.id;
    const logPrefix = `[${new Date().toISOString()}] [GET /sync/state] User ${userId || 'UNKNOWN'}:`;
    console.log(`${logPrefix} Fetching initial state.`);
    try {
      if (!userId) {
        console.error(`${logPrefix} Error: User ID not found after authentication.`);
        return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
      }
      const result = await transaction(async (client) => {
        // Get lists owned or shared with the user
        const listsQuery = `
            SELECT l.*, array_agg(DISTINCT ls.permissions) FILTER (WHERE ls.list_id IS NOT NULL) as sharing_permissions
            FROM lists l
            LEFT JOIN list_sharing ls ON l.id = ls.list_id AND ls.shared_with_user_id = $1::uuid
            WHERE (l.owner_id = $1::uuid OR ls.shared_with_user_id = $1::uuid)
              AND l.deleted_at IS NULL
            GROUP BY l.id`;
        const lists = await client.query(listsQuery, [userId]);
        const listIds = lists.rows.map(list => list.id);

        let items = { rows: [] }; // Default to empty if no lists found
        if (listIds.length > 0) {
          // Get items only for the accessible lists
          // Consider adding tags join if needed: LEFT JOIN item_tags it ON i.id = it.item_id ... array_agg(it.tag_id)
          const itemsQuery = `
                SELECT i.*
                FROM items i
                WHERE i.list_id = ANY($1::uuid[])
                  AND i.deleted_at IS NULL`;
          items = await client.query(itemsQuery, [listIds]);
        } else {
          console.log(`${logPrefix} No lists found for user.`);
        }
        return { lists: lists.rows, items: items.rows };
      });

      console.log(`${logPrefix} Returning state with ${result.lists.length} lists and ${result.items.length} items.`);
      res.json({
        lists: result.lists,
        items: result.items,
        lastSyncTime: new Date().toISOString() // Provide current time as baseline
      });
    } catch (error) {
      console.error(`${logPrefix} Sync state error:`, error);
      res.status(500).json({ message: 'Failed to fetch sync state' });
    }
  });

  // Get single record
  router.get('/:table/:id', authenticateJWT, async (req, res) => {
    const userId = req.user.id;
    const { table, id } = req.params;
    const logPrefix = `[${new Date().toISOString()}] [GET /sync/${table}/${id}] User ${userId || 'UNKNOWN'}:`;
    console.log(`${logPrefix} Fetching single record.`);

    try {
      if (!userId) {
        console.error(`${logPrefix} Error: User ID not found after authentication.`);
        return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
      }
      if (!['lists', 'items'].includes(table)) {
        console.warn(`${logPrefix} Invalid table name requested.`);
        return res.status(400).json({ message: 'Invalid table name' });
      }
      // Basic UUID validation for ID might be good here too

      let result;
      if (table === 'lists') {
        // Check ownership or sharing
        const listQuery = `
                SELECT l.*, array_agg(DISTINCT ls.permissions) FILTER (WHERE ls.list_id IS NOT NULL) as sharing_permissions
                FROM lists l
                LEFT JOIN list_sharing ls ON l.id = ls.list_id AND ls.shared_with_user_id = $2::uuid
                WHERE l.id = $1::uuid
                  AND (l.owner_id = $2::uuid OR ls.shared_with_user_id = $2::uuid)
                  AND l.deleted_at IS NULL
                GROUP BY l.id`;
        result = await query(listQuery, [id, userId]);
      } else if (table === 'items') {
        // Check if user owns the list the item belongs to or if the list is shared with them
        const itemQuery = `
                 SELECT i.* -- Add tags join if needed
                 FROM items i
                 JOIN lists l ON i.list_id = l.id
                 LEFT JOIN list_sharing ls ON l.id = ls.list_id AND ls.shared_with_user_id = $2::uuid
                 WHERE i.id = $1::uuid
                   AND (l.owner_id = $2::uuid OR ls.shared_with_user_id = $2::uuid)
                   AND i.deleted_at IS NULL
                   AND l.deleted_at IS NULL -- Ensure parent list is not deleted
             `;
        result = await query(itemQuery, [id, userId]);
      }

      if (!result || result.rows.length === 0) {
        console.log(`${logPrefix} Record not found or access denied.`);
        return res.status(404).json({ message: 'Record not found or access denied' });
      }

      console.log(`${logPrefix} Record found and returned.`);
      res.json(result.rows[0]);
    } catch (error) {
      console.error(`${logPrefix} Fetch record error:`, error);
      res.status(500).json({ message: 'Failed to fetch record' });
    }
  });


  // Validate sync payload (Removed - validation should happen primarily during the push)
  // router.post('/validate', ...);

  // Get sync conflicts (Assuming a separate conflicts table/mechanism exists)
  router.get('/conflicts', authenticateJWT, async (req, res) => {
    const userId = req.user.id;
    const logPrefix = `[${new Date().toISOString()}] [GET /sync/conflicts] User ${userId || 'UNKNOWN'}:`;
    console.log(`${logPrefix} Fetching conflicts.`);
    try {
      if (!userId) {
        console.error(`${logPrefix} Error: User ID not found after authentication.`);
        return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
      }
      // Placeholder: Implement actual conflict fetching logic if needed
      console.warn(`${logPrefix} Conflict resolution endpoint called, but no implementation provided.`);
      // Example structure if you have a conflicts table:
      // const conflicts = await query(`SELECT ... FROM sync_conflicts WHERE user_id = $1`, [userId]);
      // res.json(conflicts.rows);
      res.json([]); // Return empty array for now
    } catch (error) {
      console.error(`${logPrefix} Fetch conflicts error:`, error);
      res.status(500).json({ message: 'Failed to fetch conflicts' });
    }
  });

  // Get sync queue status (using sync_tracking table)
  router.get('/queue', authenticateJWT, async (req, res) => {
    const userId = req.user.id;
    const logPrefix = `[${new Date().toISOString()}] [GET /sync/queue] User ${userId || 'UNKNOWN'}:`;
    console.log(`${logPrefix} Fetching queue status.`);
    try {
      if (!userId) {
        console.error(`${logPrefix} Error: User ID not found after authentication.`);
        return res.status(401).json({ message: 'Unauthorized: User ID missing.' });
      }
      // Query sync_tracking for counts. Adjust 'sync_status' if you add such a field
      const queueStatus = await query(`
                SELECT
                    COUNT(*) as total_tracked, -- Total records user interacted with
                    MAX(created_at) as last_tracked_change -- Timestamp of the last known change by this user
                FROM sync_tracking
                WHERE user_id = $1::uuid
                  AND deleted_at IS NULL -- Only count active tracking entries
            `, [userId]);

      console.log(`${logPrefix} Queue status retrieved.`);
      res.json(queueStatus.rows[0] || { total_tracked: 0, last_tracked_change: null }); // Provide defaults
    } catch (error) {
      console.error(`${logPrefix} Fetch queue status error:`, error);
      res.status(500).json({ message: 'Failed to fetch queue status' });
    }
  });

  return router; // Return the configured router
}; // End export function