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
              (SELECT row_to_json(l.*) FROM public.lists l WHERE l.id = cl.record_id::uuid AND l.owner_id = $1 AND l.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'list_items' THEN
              (SELECT row_to_json(li.*) FROM public.list_items li WHERE li.id = cl.record_id::uuid AND li.owner_id = $1 AND li.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'favorites' THEN
              (SELECT row_to_json(f.*) FROM public.favorites f WHERE f.id = cl.record_id::uuid AND f.user_id = $1 AND f.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'user_settings' THEN
              (SELECT row_to_json(us.*) FROM public.user_settings us WHERE us.user_id = $1)
            WHEN cl.operation != 'delete' AND cl.table_name = 'users' THEN
              (SELECT row_to_json(u.*) FROM public.users u WHERE u.id = cl.record_id::uuid)
            WHEN cl.operation != 'delete' AND cl.table_name = 'followers' THEN
              (SELECT row_to_json(f.*) FROM public.followers f WHERE f.id = cl.record_id::uuid AND (f.follower_id = $1 OR f.followed_id = $1) AND f.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'notifications' THEN
              (SELECT row_to_json(n.*) FROM public.notifications n WHERE n.id = cl.record_id::uuid AND n.user_id = $1 AND n.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'list_categories' THEN
              (SELECT row_to_json(c.*) FROM public.list_categories c WHERE c.id = cl.record_id::uuid AND c.deleted_at IS NULL)
            WHEN cl.operation != 'delete' AND cl.table_name = 'list_item_categories' THEN
              (SELECT row_to_json(ic.*) FROM public.list_item_categories ic WHERE ic.item_id = cl.record_id::uuid AND ic.deleted_at IS NULL)
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
        list_item_categories: { created: [], updated: [], deleted: [] }
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

      // --- Baseline data: if this is the very first sync (no lastPulledAt) include all non-deleted categories ---
      if (lastPulledAt === 0) {
        try {
          const catRes = await db.query(`SELECT * FROM public.list_categories WHERE deleted_at IS NULL`);
          for (const row of catRes.rows) {
            // normalise timestamps to millis to stay consistent with client-side inserts
            if (row.created_at) row.created_at = new Date(row.created_at).getTime();
            if (row.updated_at) row.updated_at = new Date(row.updated_at).getTime();
            changes.list_categories.created.push(row);
          }
        } catch (err) {
          logger.error('[OptimizedSyncController] Failed to fetch baseline categories:', err);
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