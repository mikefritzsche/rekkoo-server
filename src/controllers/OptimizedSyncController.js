const db = require('../config/db');
const { logger } = require('../utils/logger');
const syncOptimization = require('../config/sync-optimization');

function optimizedSyncControllerFactory(socketService) {
  
  /**
   * Optimized pull changes using unified change log
   * Reduces from 9+ queries per user to 1 query per user
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
      // Single query to get all changes for user since last sync
      const changesQuery = `
        SELECT 
          cl.table_name,
          cl.record_id,
          cl.operation,
          cl.created_at,
          cl.change_data,
          -- Get current record data for creates/updates
          CASE 
            WHEN cl.operation != 'delete' AND cl.table_name = 'lists' THEN
              (SELECT row_to_json(l.*) FROM public.lists l 
               WHERE l.id = CASE 
                 WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                 THEN cl.record_id::uuid 
                 ELSE NULL 
               END 
               AND l.deleted_at IS NULL
               AND (
                 l.owner_id = $1 
                 OR l.id IN (
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
               ))
            WHEN cl.operation != 'delete' AND cl.table_name = 'list_items' THEN
              (SELECT json_build_object(
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
                -- Include gift details if available
                'quantity', gd.quantity,
                'where_to_buy', gd.where_to_buy,
                'amazon_url', gd.amazon_url,
                'web_link', gd.web_link,
                'rating', gd.rating
              ) FROM public.list_items li
              LEFT JOIN public.gift_details gd ON li.gift_detail_id = gd.id 
               WHERE li.id = CASE 
                 WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                 THEN cl.record_id::uuid 
                 ELSE NULL 
               END 
               AND li.deleted_at IS NULL
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
               ))
            WHEN cl.operation != 'delete' AND cl.table_name = 'favorites' THEN
              (SELECT row_to_json(f.*) FROM public.favorites f WHERE f.id = CASE 
                WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                THEN cl.record_id::uuid 
                ELSE NULL 
              END AND f.user_id = $1 AND f.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'user_settings' THEN
              (SELECT row_to_json(us.*) FROM public.user_settings us WHERE us.user_id = $1)
            WHEN cl.operation != 'delete' AND cl.table_name = 'users' THEN
              (SELECT row_to_json(u.*) FROM public.users u WHERE u.id = CASE 
                WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                THEN cl.record_id::uuid 
                ELSE NULL 
              END)
            WHEN cl.operation != 'delete' AND cl.table_name = 'followers' THEN
              (SELECT row_to_json(f.*) FROM public.followers f WHERE f.id = CASE 
                WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                THEN cl.record_id::uuid 
                ELSE NULL 
              END AND (f.follower_id = $1 OR f.followed_id = $1) AND f.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'notifications' THEN
              (SELECT row_to_json(n.*) FROM public.notifications n WHERE n.id = CASE 
                WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                THEN cl.record_id::uuid 
                ELSE NULL 
              END AND n.user_id = $1 AND n.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'list_categories' THEN
              (SELECT row_to_json(c.*) FROM public.list_categories c WHERE c.id = CASE 
                WHEN cl.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
                THEN cl.record_id::uuid 
                ELSE NULL 
              END AND c.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'item_tags' THEN
              (SELECT row_to_json(it.*) FROM public.item_tags it WHERE it.item_id::text = cl.record_id AND it.deleted_at IS NULL)
            ELSE cl.change_data::json
          END as current_data
        FROM public.change_log cl
        WHERE cl.user_id = $1 
          AND cl.created_at > to_timestamp($2 / 1000.0)
        ORDER BY cl.created_at ASC
        LIMIT 1000
      `;

      const result = await db.query(changesQuery, [userId, lastPulledAt]);
      
      // Group changes by table and operation
      const changes = {
        list_items: { created: [], updated: [], deleted: [] },
        lists: { created: [], updated: [], deleted: [] },
        user_settings: { created: [], updated: [], deleted: [] },
        users: { created: [], updated: [], deleted: [] },
        favorites: { created: [], updated: [], deleted: [] },
        followers: { created: [], updated: [], deleted: [] },
        notifications: { created: [], updated: [], deleted: [] },
        list_categories: { created: [], updated: [], deleted: [] },
        item_tags: { created: [], updated: [], deleted: [] }
      };

      // Process each change record
      for (const change of result.rows) {
        const { table_name, record_id, operation, current_data } = change;
        
        if (!changes[table_name]) continue; // Skip unknown tables
        
        if (operation === 'delete') {
          changes[table_name].deleted.push(record_id);
        } else if (current_data) {
          // Convert timestamps to milliseconds for client compatibility
          if (current_data.created_at) {
            current_data.created_at = new Date(current_data.created_at).getTime();
          }
          if (current_data.updated_at) {
            current_data.updated_at = new Date(current_data.updated_at).getTime();
          }
          
          if (operation === 'create') {
            changes[table_name].created.push(current_data);
          } else {
            changes[table_name].updated.push(current_data);
          }
        }
      }
      
      // Add gift status to gift list items for non-owners
      try {
        // Get all gift lists being synced
        const allListIds = new Set();
        [...changes.lists.created, ...changes.lists.updated].forEach(list => {
          if (list.list_type === 'gifts') {
            allListIds.add(list.id);
          }
        });
        
        if (allListIds.size > 0) {
          // Check which gift lists the user doesn't own
          const giftListsToEnrich = [];
          for (const listId of allListIds) {
            const list = [...changes.lists.created, ...changes.lists.updated].find(l => l.id === listId);
            if (list && list.owner_id !== userId) {
              giftListsToEnrich.push(listId);
            }
          }
          
          if (giftListsToEnrich.length > 0) {
            // Fetch gift reservations for these lists
            const reservationsQuery = `
              SELECT 
                gr.item_id,
                gr.reserved_by,
                gr.is_purchased,
                u.username as reserved_by_username,
                u.full_name as reserved_by_full_name
              FROM gift_reservations gr
              LEFT JOIN users u ON gr.reserved_by = u.id
              WHERE gr.item_id IN (
                SELECT id FROM list_items 
                WHERE list_id = ANY($1::uuid[])
              )
            `;
            const reservationsResult = await db.query(reservationsQuery, [giftListsToEnrich]);
            
            // Create a map of item_id to gift status
            const giftStatusMap = {};
            reservationsResult.rows.forEach(row => {
              giftStatusMap[row.item_id] = {
                is_reserved: !!row.reserved_by,
                is_purchased: !!row.is_purchased,
                reserved_by: row.reserved_by ? {
                  id: row.reserved_by,
                  username: row.reserved_by_username,
                  full_name: row.reserved_by_full_name,
                  is_me: row.reserved_by === userId
                } : null
              };
            });
            
            // Add giftStatus to items
            [...changes.list_items.created, ...changes.list_items.updated].forEach(item => {
              if (giftListsToEnrich.includes(item.list_id)) {
                const status = giftStatusMap[item.id];
                if (status) {
                  item.giftStatus = status;
                }
              }
            });
            
            logger.info(`[OptimizedSyncController] Added gift status to ${Object.keys(giftStatusMap).length} items for user ${userId}`);
          }
        }
      } catch (err) {
        logger.error('[OptimizedSyncController] Error adding gift status:', err);
        // Continue without gift status - non-critical error
      }

      // --- Baseline data: if this is the very first sync (no lastPulledAt) ---
      if (lastPulledAt === 0) {
        try {
          // Include all tags
          const catRes = await db.query(`SELECT * FROM public.tags WHERE deleted_at IS NULL`);
          for (const row of catRes.rows) {
            // normalise timestamps to millis to stay consistent with client-side inserts
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.tags = changes.tags || { created: [], updated: [], deleted: [] };
            changes.tags.created.push(row);
          }
          
          // Include all lists the user has access to (owned and shared)
          const listsQuery = `
            SELECT DISTINCT l.* FROM public.lists l 
            WHERE l.deleted_at IS NULL
            AND (
              l.owner_id = $1 
              OR l.id IN (
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
          `;
          const listsRes = await db.query(listsQuery, [userId]);
          for (const row of listsRes.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.lists.created.push(row);
          }
          
          // Include all items from lists the user has access to
          const itemsQuery = `
            SELECT DISTINCT 
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
              -- Include gift details if available
              gd.quantity,
              gd.where_to_buy,
              gd.amazon_url,
              gd.web_link,
              gd.rating
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
          `;
          const itemsRes = await db.query(itemsQuery, [userId]);
          for (const row of itemsRes.rows) {
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.list_items.created.push(row);
          }
          
          // Add gift status to initial sync items for gift lists not owned by user
          const giftListsNotOwned = listsRes.rows.filter(l => l.list_type === 'gifts' && l.owner_id !== userId);
          if (giftListsNotOwned.length > 0) {
            const giftListIds = giftListsNotOwned.map(l => l.id);
            const reservationsQuery = `
              SELECT 
                gr.item_id,
                gr.reserved_by,
                gr.is_purchased,
                u.username as reserved_by_username,
                u.full_name as reserved_by_full_name
              FROM gift_reservations gr
              LEFT JOIN users u ON gr.reserved_by = u.id
              WHERE gr.item_id IN (
                SELECT id FROM list_items 
                WHERE list_id = ANY($1::uuid[])
              )
            `;
            const reservationsResult = await db.query(reservationsQuery, [giftListIds]);
            
            // Add giftStatus to items
            const giftStatusMap = {};
            reservationsResult.rows.forEach(row => {
              giftStatusMap[row.item_id] = {
                is_reserved: !!row.reserved_by,
                is_purchased: !!row.is_purchased,
                reserved_by: row.reserved_by ? {
                  id: row.reserved_by,
                  username: row.reserved_by_username,
                  full_name: row.reserved_by_full_name,
                  is_me: row.reserved_by === userId
                } : null
              };
            });
            
            changes.list_items.created.forEach(item => {
              if (giftListIds.includes(item.list_id) && giftStatusMap[item.id]) {
                item.giftStatus = giftStatusMap[item.id];
              }
            });
            
            logger.info(`[OptimizedSyncController] Added gift status to initial sync items for ${giftListsNotOwned.length} gift lists`);
          }
          
          logger.info(`[OptimizedSyncController] Initial sync for user ${userId}: ${listsRes.rows.length} lists, ${itemsRes.rows.length} items`);
        } catch (err) {
          logger.error('[OptimizedSyncController] Failed to fetch baseline data:', err);
        }
      }

      res.status(200).json({
        changes: changes,
        timestamp: Date.now(),
        optimization: 'unified_change_log',
        records_processed: result.rows.length
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
   * Health check endpoint with cache status
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
        }
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