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
                  WHEN st.table_name = 'list_items' THEN li.title
                  ELSE NULL
                END as record_title
         FROM sync_tracking st
         LEFT JOIN lists l ON st.table_name = 'lists' AND st.record_id::uuid = l.id AND l.owner_id = $2::uuid AND l.deleted_at IS NULL
         LEFT JOIN list_items li ON st.table_name = 'list_items' AND st.record_id::uuid = li.id AND li.deleted_at IS NULL 
           AND li.list_id IN (SELECT id FROM lists WHERE owner_id = $2::uuid AND deleted_at IS NULL)
         WHERE st.created_at > $1
           AND st.deleted_at IS NULL
           AND (
             (st.table_name = 'lists' AND l.owner_id = $2::uuid)
             OR
             (st.table_name = 'list_items' AND li.list_id IS NOT NULL)
             OR
             (st.table_name = 'user_settings' AND st.record_id = $2::uuid)
             OR
             (st.table_name = 'users' AND st.record_id = $2::uuid)
           )
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
        let originalOperation = operation; 
        
        const changeLogPrefix = `${logPrefix} Change [${table_name}/${record_id}/${originalOperation}]:`;

        // --- Early Validation --- 
        
        // Basic structure/type validation
        if (!table_name || !record_id || !originalOperation || !['lists', 'list_items', 'user_settings', 'users'].includes(table_name) || !['create', 'update', 'delete'].includes(originalOperation)) {
          console.error(`${changeLogPrefix} Invalid change structure/values (table_name: ${table_name}, operation: ${originalOperation}).`);
          results.push({ success: false, operation: originalOperation, record_id, message: `Invalid change structure/values.` });
          continue; 
        }
        // Data presence validation
        if ((originalOperation === 'create' || originalOperation === 'update') && !data) {
          console.error(`${changeLogPrefix} Missing data for create/update.`);
          results.push({ success: false, operation: originalOperation, record_id, message: `Data is required for ${originalOperation} operation.` });
          continue;
        }
        // UUID Format Validation for record_id (especially important for create)
        const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        if (!uuidRegex.test(record_id)) {
            console.error(`${changeLogPrefix} Invalid UUID format for record_id: ${record_id}`);
            results.push({ success: false, operation: originalOperation, record_id, message: `Invalid format for record_id. UUID expected.` });
            continue; // Skip processing this change
        }

        // Prepare filteredData (do this once)
        let filteredData = null;
        if (data) {
          filteredData = { ...data };
          delete filteredData.id; 
          delete filteredData.created_at;
          delete filteredData.updated_at;
          delete filteredData.deleted_at;
          
          console.log(`${changeLogPrefix} Received table_name: '${table_name}'`); 
          
          // Table-specific filtering AND R2 URL Construction
          if (table_name === 'lists') {
            const r2Key = filteredData.image_r2_key; // Get the key from incoming data
            let finalImageUrl = null;

            if (r2Key) {
              console.log(`${changeLogPrefix} Found R2 key: ${r2Key}`);
              const r2BaseUrl = process.env.R2_PUBLIC_URL_BASE;
              if (r2BaseUrl) {
                finalImageUrl = `${r2BaseUrl.replace(/\/$/, '')}/${r2Key}`; 
                console.log(`${changeLogPrefix} Constructed final image URL: ${finalImageUrl}`);
                
                // <<< Set dedicated columns >>>
                filteredData.image_url = finalImageUrl; // Store final URL
                filteredData.local_image_key = r2Key; // Persist the R2 key
                filteredData.local_image_upload_status = 'completed'; // Mark as completed
                
                // <<< Update background object for consistency >>>
                filteredData.background = { 
                  type: 'image', 
                  value: finalImageUrl, // Include URL here too for convenience
                  imageId: null 
                }; 
                console.log(`${changeLogPrefix} Set image_url, local_image_key, status, and background fields`);
              } else {
                console.warn(`${changeLogPrefix} R2_PUBLIC_URL_BASE not set! Cannot construct/save final image URL.`);
                // Decide how to handle - maybe just save the key and status?
                filteredData.image_url = null;
                filteredData.local_image_key = r2Key;
                filteredData.local_image_upload_status = 'failed_url_construction'; // New status?
                filteredData.background = null; // Clear background if URL fails
              }
            } else {
              // No R2 key provided by client
              // Ensure fields are cleared if client didn't intend an image upload
              // or preserve existing image_url if it's just a metadata update without image change
              if (operation === 'create') {
                  filteredData.image_url = null;
                  filteredData.local_image_key = null;
                  filteredData.local_image_upload_status = null;
                  // Keep background as sent by client (color/pattern) unless it was erroneously image
                  if (filteredData.background?.type === 'image') filteredData.background = null;
              } else { // operation === 'update'
                  // If client explicitly sends null/different background, clear image fields
                  if (data.background?.type !== 'image') {
                      filteredData.image_url = null;
                      filteredData.local_image_key = null;
                      filteredData.local_image_upload_status = null;
                  } 
                  // Otherwise, don't touch existing image_url/key/status during unrelated updates
                  // (Unless client explicitly sends image_r2_key = null to clear image? - Add logic if needed)
              }
            }
            
            // <<< Remove temporary/client-only fields BEFORE SQL build >>>
            delete filteredData.image_r2_key; // Don't save the incoming key directly
            delete filteredData.local_image_uri; 
            delete filteredData.local_image_mime_type;
            // Don't delete local_image_upload_status here, we set it above
            // Don't delete local_image_key here, we set it above
            
            // Existing list-specific filtering
            if ('type' in filteredData) delete filteredData.type; 
            if ('items' in filteredData) delete filteredData.items;
          } else if (table_name === 'user_settings') {
             // Keep user_id for user_settings as it might be the key
          } else if (table_name === 'list_items') {
            // For list_items, remove user_id if present in data (shouldn't be)
            delete filteredData.user_id;
          } else {
            // Default: remove user_id for other tables unless it's the key
            delete filteredData.user_id; 
          }
          
          console.log(`${changeLogPrefix} Keys in filteredData before SQL build: ${Object.keys(filteredData).join(', ')}`);
        }

        // Verify ownership before update for lists and list_items
        let ownerCheckField = 'owner_id';
        let ownerCheckValue = userId;
        if (table_name === 'list_items') {
          // For list_items, check if the user owns the list the item belongs to
          if (originalOperation === 'create') {
            // For create, verify the list_id belongs to the user
            const listCheck = await client.query(
              `SELECT owner_id FROM lists WHERE id = $1::uuid AND deleted_at IS NULL`,
              [filteredData.list_id]
            );
            if (listCheck.rows.length === 0) {
              throw new Error(`List ${filteredData.list_id} not found or already deleted.`);
            }
            if (listCheck.rows[0].owner_id !== userId) {
              throw new Error(`User ${userId} does not own the list ${filteredData.list_id}.`);
            }
          } else {
            // For update/delete, check the item's list ownership
            const itemCheck = await client.query(
              `SELECT l.owner_id FROM list_items li JOIN lists l ON li.list_id = l.id WHERE li.id = $1::uuid AND li.deleted_at IS NULL`,
              [record_id]
            );
            if (itemCheck.rows.length === 0) {
              throw new Error(`Item ${record_id} not found or already deleted.`);
            }
            if (itemCheck.rows[0].owner_id !== userId) {
              throw new Error(`User ${userId} does not own the list containing item ${record_id}.`);
            }
          }
        } else if (table_name === 'lists') {
          if (originalOperation === 'create') {
            // For create, verify the owner_id matches the authenticated user
            filteredData.owner_id = userId; 
          } else {
            // For update/delete, check list ownership
            const listCheck = await client.query(
              `SELECT owner_id FROM lists WHERE id = $1::uuid AND deleted_at IS NULL`,
              [record_id]
            );
            if (listCheck.rows.length === 0) {
              throw new Error(`List ${record_id} not found or already deleted.`);
            }
            if (listCheck.rows[0].owner_id !== userId) {
              throw new Error(`User ${userId} does not own list ${record_id}.`);
            }
          }
        } else if (table_name === 'user_settings' || table_name === 'users') {
          // For user_settings and users, the record_id is the user_id
          if (record_id !== userId) {
            throw new Error(`User ${userId} cannot modify settings/user data for ${record_id}.`);
          }
        }

        // Build SQL params using the potentially modified filteredData (now includes cover_image_url, excludes R2 key)
        const updateClauses = filteredData ? Object.keys(filteredData).map((key, i) => `"${key}" = $${i + 2}`) : []; // Ensure keys are quoted
        let updateValues = filteredData ? [record_id, ...Object.values(filteredData)] : [record_id];

        let queryResult;
        if (originalOperation === 'create') {
          // Check if record already exists
          const existingCheck = await client.query(
            `SELECT "id", "created_at" FROM "${table_name}" WHERE "id" = $1::uuid AND "deleted_at" IS NULL`,
            [record_id]
          );

          if (existingCheck.rows.length > 0) {
            console.log(`${changeLogPrefix} Record already exists, checking timestamps`);
            const existingRecord = existingCheck.rows[0];
            
            // If the existing record is newer, skip the update
            if (new Date(existingRecord.created_at) > new Date()) {
              console.log(`${changeLogPrefix} Existing record is newer, skipping update`);
              results.push({ 
                success: true, 
                operation: 'create', 
                record_id, 
                message: 'Record already exists with newer timestamp' 
              });
              continue;
            }

            // Record exists and is older, proceed with update
            console.log(`${changeLogPrefix} Converting to update operation`);
            const finalUpdateClauses = [...updateClauses, `"updated_at" = CURRENT_TIMESTAMP`];
            updateValues = filteredData ? [record_id, ...Object.values(filteredData)] : [record_id]; 
            
            const updateQueryString = `
              UPDATE "${table_name}"
              SET ${finalUpdateClauses.join(', ')}, "updated_at" = CURRENT_TIMESTAMP
              WHERE "id" = $1::uuid AND "deleted_at" IS NULL
              RETURNING *`;
            console.log(`${changeLogPrefix} Executing update query:`, updateQueryString);
            console.log(`${changeLogPrefix} With values:`, updateValues);
            queryResult = await client.query(updateQueryString, updateValues);
          } else {
            // Record doesn't exist, proceed with create
            const insertColumns = filteredData ? Object.keys(filteredData) : []; // e.g., ["title", "description", ...]
            
            // Generate placeholders starting from $2 for data columns
            const dataPlaceholders = insertColumns.map((_, i) => `$${i + 2}`).join(', '); // $2, $3, ...
            
            // Prepare values array: only record_id and data values
            const insertValues = filteredData ? [record_id, ...Object.values(filteredData)] : [record_id];
            
            // Construct the query using $1::uuid for id, dataPlaceholders for data, and NOW() for timestamps
            const insertQuery = `
              INSERT INTO "${table_name}" 
                ("id", ${insertColumns.map(col => `"${col}"`).join(', ')}, "created_at", "updated_at") 
              VALUES 
                ($1::uuid, ${dataPlaceholders}, NOW(), NOW()) 
              ON CONFLICT ("id") DO NOTHING RETURNING *`;

            console.log(`${changeLogPrefix} Executing insert query:`, insertQuery);
            console.log(`${changeLogPrefix} With values:`, insertValues); // Pass only record_id + data values
            queryResult = await client.query(insertQuery, insertValues);
          }
        } else if (originalOperation === 'delete') {
          // For delete operations, set deleted_at timestamp
          const deleteQuery = `
            UPDATE "${table_name}"
            SET "deleted_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
            WHERE "id" = $1::uuid AND "deleted_at" IS NULL
            RETURNING "id", "deleted_at" 
          `;
          console.log(`${changeLogPrefix} Executing delete query:`, deleteQuery);
          console.log(`${changeLogPrefix} With values:`, [record_id]);
          queryResult = await client.query(deleteQuery, [record_id]);
        } else {
          // For update operations, use UPDATE
          let updateQueryString = `
            UPDATE "${table_name}"
            SET ${updateClauses.join(', ')}, "updated_at" = CURRENT_TIMESTAMP
            WHERE "id" = $1::uuid AND "deleted_at" IS NULL
            RETURNING *`;

          // Special handling for user_settings table (assuming PK is user_id)
          if (table_name === 'user_settings') {
            updateQueryString = `
              UPDATE "${table_name}"
              SET ${updateClauses.join(', ')}, "updated_at" = CURRENT_TIMESTAMP
              WHERE "user_id" = $1::uuid AND "deleted_at" IS NULL 
              RETURNING "user_id" 
            `;
            // IMPORTANT: Use the authenticated userId for the WHERE clause value
            updateValues[0] = userId; 
            console.log(`${changeLogPrefix} Using user_id specific update query and ensuring userId ('${userId}') is used for WHERE clause.`);
          }

          console.log(`${changeLogPrefix} Executing update query:`, updateQueryString);
          console.log(`${changeLogPrefix} With values:`, updateValues);
          queryResult = await client.query(updateQueryString, updateValues);

          // Use the correct column name from the result
          if (queryResult.rows.length > 0) {
             console.log(`${changeLogPrefix} Update returned column: ${Object.keys(filteredData)[0]} = ${queryResult.rows[0][Object.keys(filteredData)[0]]}`);
          }
        }

        if (queryResult.rowCount === 1) {
          console.log(`${changeLogPrefix} Operation completed successfully.`);
          changesMade = true;

          // Store the change in sync_tracking
          const trackingData = {
            ...filteredData,
            id: record_id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          // For delete operations, preserve the record's data
          if (originalOperation === 'delete') {
            const recordData = await client.query(
              `SELECT * FROM "${table_name}" WHERE "id" = $1::uuid`,
              [record_id]
            );
            if (recordData.rows.length > 0) {
              trackingData.deleted_at = new Date().toISOString();
              Object.assign(trackingData, recordData.rows[0]);
            }
          }

          // For user_settings, ensure JSON fields are properly stringified
          if (table_name === 'user_settings') {
            if (trackingData.notification_preferences && typeof trackingData.notification_preferences === 'object') {
              trackingData.notification_preferences = JSON.stringify(trackingData.notification_preferences);
            }
            if (trackingData.privacy_settings && typeof trackingData.privacy_settings === 'object') {
              trackingData.privacy_settings = JSON.stringify(trackingData.privacy_settings);
            }
          }

          // For lists, ensure custom_fields is properly stringified
          if (table_name === 'lists' && trackingData.custom_fields && typeof trackingData.custom_fields === 'object') {
            trackingData.custom_fields = JSON.stringify(trackingData.custom_fields);
          }

          const trackingQuery = `
            INSERT INTO sync_tracking
              (table_name, record_id, operation, data, created_at)
            VALUES ($1, $2::uuid, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (table_name, record_id) DO UPDATE SET
              operation = EXCLUDED.operation,
              data = EXCLUDED.data,
              created_at = CURRENT_TIMESTAMP,
              deleted_at = NULL
          `;

          console.log(`${changeLogPrefix} Executing tracking query:`, trackingQuery);
          console.log(`${changeLogPrefix} With values:`, [table_name, record_id, originalOperation, JSON.stringify(trackingData)]);

          await client.query(trackingQuery, [table_name, record_id, originalOperation, JSON.stringify(trackingData)]);
        } else {
          console.warn(`${changeLogPrefix} Operation failed (record not found or already deleted).`);
          results.push({ success: false, operation: originalOperation, record_id, error: 'Operation failed, record potentially missing or deleted' });
          continue;
        }

        // Only record success if the operation was attempted and didn't throw/continue earlier
        const existingResultIndex = results.findIndex(r => r.record_id === record_id);
        if (existingResultIndex === -1) {
          results.push({ success: true, operation: originalOperation, record_id });
        } else {
          // Update existing result if needed (e.g., if a create was skipped but delete succeeded)
          results[existingResultIndex] = { success: true, operation: originalOperation, record_id };
        }

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
            FROM "lists" l
            LEFT JOIN "list_sharing" ls ON l.id = ls.list_id AND ls.shared_with_user_id = $1::uuid
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
                FROM "list_items" i -- Use quoted table name
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
                FROM "lists" l
                LEFT JOIN "list_sharing" ls ON l.id = ls.list_id AND ls.shared_with_user_id = $2::uuid
                WHERE l.id = $1::uuid
                  AND (l.owner_id = $2::uuid OR ls.shared_with_user_id = $2::uuid)
                  AND l.deleted_at IS NULL
                GROUP BY l.id`;
        result = await query(listQuery, [id, userId]);
      } else if (table === 'items') {
        // Check if user owns the list the item belongs to or if the list is shared with them
        const itemQuery = `
                 SELECT i.* -- Add tags join if needed
                 FROM "list_items" i
                 JOIN "lists" l ON i.list_id = l.id
                 LEFT JOIN "list_sharing" ls ON l.id = ls.list_id AND ls.shared_with_user_id = $2::uuid
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