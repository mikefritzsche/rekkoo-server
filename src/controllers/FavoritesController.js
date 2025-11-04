const db = require('../config/db');

function favoritesControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  /**
   * Add a list or list item to favorites
   */
  const addToFavorites = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { list_id, list_item_id, category_id, is_public, notes, sort_order } = req.body;
    console.log('addToFavorites', req.body);
    

    // Validate that either list_id or list_item_id is provided, but not both
    if ((!list_id && !list_item_id) || (list_id && list_item_id)) {
      return res.status(400).json({ error: 'Either list_id or list_item_id must be provided, but not both' });
    }

    try {
      // Check if favorite already exists (handle soft-deleted favorites)
      const existingQuery = `
        SELECT id, deleted_at FROM public.favorites 
        WHERE user_id = $1 
        AND ${list_id ? 'list_id = $2' : 'list_item_id = $2'}
      `;
      const existingParams = [userId, list_id || list_item_id];
      const existingResult = await db.query(existingQuery, existingParams);

      let favoriteId;

      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        
        if (existing.deleted_at) {
          // Restore soft-deleted favorite
          const restoreQuery = `
            UPDATE public.favorites 
            SET deleted_at = NULL,
                category_id = $3,
                is_public = $4,
                notes = $5,
                sort_order = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id
          `;
          const restoreParams = [
            existing.id, 
            userId, 
            category_id || null, 
            is_public || false, 
            notes || null, 
            sort_order || 0
          ];
          const restoreResult = await db.query(restoreQuery, restoreParams);
          favoriteId = restoreResult.rows[0].id;
        } else {
          // Already exists and not deleted - just update it
          const updateQuery = `
            UPDATE public.favorites 
            SET category_id = $3,
                is_public = $4,
                notes = $5,
                sort_order = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id
          `;
          const updateParams = [
            existing.id, 
            userId, 
            category_id || null, 
            is_public || false, 
            notes || null, 
            sort_order || 0
          ];
          const updateResult = await db.query(updateQuery, updateParams);
          favoriteId = updateResult.rows[0].id;
        }
      } else {
        // Create new favorite
        const insertQuery = `
          INSERT INTO public.favorites (
            user_id, 
            ${list_id ? 'list_id' : 'list_item_id'}, 
            category_id, 
            is_public, 
            notes,
            sort_order
          ) 
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `;
        const insertParams = [
          userId, 
          list_id || list_item_id, 
          category_id || null, 
          is_public || false, 
          notes || null,
          sort_order || 0
        ];
        const insertResult = await db.query(insertQuery, insertParams);
        favoriteId = insertResult.rows[0].id;
      }

      // Sync tracking is now handled automatically by database triggers

      // Send realtime update if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function') {
        safeSocketService.emitToUser(userId, 'favorite:added', { 
          id: favoriteId, 
          list_id, 
          list_item_id 
        });
      }

      // Return the favorite
      const favoriteQuery = `
        SELECT * FROM public.favorites WHERE id = $1
      `;
      const favoriteResult = await db.query(favoriteQuery, [favoriteId]);
      
      return res.status(200).json(favoriteResult.rows[0]);
    } catch (error) {
      console.error('[FavoritesController] Error adding to favorites:', error);
      return res.status(500).json({ error: 'Failed to add to favorites' });
    }
  };

  /**
   * Remove a favorite by ID
   */
  const removeFromFavorites = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Favorite ID is required' });
    }

    try {
      // Check if favorite exists and belongs to the user
      const checkQuery = `
        SELECT id, list_id, list_item_id FROM public.favorites 
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `;
      const checkResult = await db.query(checkQuery, [id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Favorite not found or not owned by you' });
      }

      const favorite = checkResult.rows[0];

      // Soft delete the favorite
      const deleteQuery = `
        UPDATE public.favorites 
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `;
      await db.query(deleteQuery, [id, userId]);

      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      // Send realtime update if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function') {
        safeSocketService.emitToUser(userId, 'favorite:removed', { 
          id, 
          list_id: favorite.list_id, 
          list_item_id: favorite.list_item_id 
        });
      }

      return res.status(200).json({ 
        message: 'Favorite removed successfully',
        id
      });
    } catch (error) {
      console.error('[FavoritesController] Error removing favorite:', error);
      return res.status(500).json({ error: 'Failed to remove favorite' });
    }
  };

  /**
   * Get all favorites for a user with optional filtering
   */
  const getUserFavorites = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const { type, category_id, offset = 0, limit = 100 } = req.query;
      
      let queryParams = [userId];
      let queryFilters = [];
      
      // Build filters based on query parameters
      if (type === 'lists') {
        queryFilters.push('f.list_id IS NOT NULL');
      } else if (type === 'items') {
        queryFilters.push('f.list_item_id IS NOT NULL');
      }
      
      if (category_id) {
        queryFilters.push('f.category_id = $' + (queryParams.length + 1));
        queryParams.push(category_id);
      }
      
      const filterClause = queryFilters.length > 0 
        ? 'AND ' + queryFilters.join(' AND ') 
        : '';

      // Build query with left joins to get related data
      const query = `
        SELECT 
          f.*,
          fc.name as category_name,
          fc.color as category_color,
          fc.icon as category_icon,
          CASE 
            WHEN f.list_id IS NOT NULL THEN json_build_object(
              'id', l.id,
              'title', l.title,
              'description', l.description,
              'is_public', l.is_public,
              'list_type', l.list_type,
              'background', l.background
            )
            ELSE NULL
          END as list_data,
          CASE 
            WHEN f.list_item_id IS NOT NULL THEN json_build_object(
              'id', li.id,
              'title', li.title,
              'description', li.description,
              'image_url', li.image_url,
              'list_id', li.list_id,
              'status', li.status
            )
            ELSE NULL
          END as list_item_data
        FROM 
          public.favorites f
        LEFT JOIN 
          public.favorite_categories fc ON f.category_id = fc.id
        LEFT JOIN 
          public.lists l ON f.list_id = l.id
        LEFT JOIN 
          public.list_items li ON f.list_item_id = li.id
        WHERE 
          f.user_id = $1
          AND f.deleted_at IS NULL
          AND (l.deleted_at IS NULL OR l.id IS NULL)
          AND (li.deleted_at IS NULL OR li.id IS NULL)
          ${filterClause}
        ORDER BY 
          COALESCE(f.sort_order, 0) ASC,
          f.created_at DESC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
      `;
      
      queryParams.push(parseInt(limit), parseInt(offset));
      
      const result = await db.query(query, queryParams);
      
      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM public.favorites f
        LEFT JOIN public.lists l ON f.list_id = l.id
        LEFT JOIN public.list_items li ON f.list_item_id = li.id
        WHERE 
          f.user_id = $1
          AND f.deleted_at IS NULL
          AND (l.deleted_at IS NULL OR l.id IS NULL)
          AND (li.deleted_at IS NULL OR li.id IS NULL)
          ${filterClause}
      `;
      
      const countResult = await db.query(countQuery, queryParams.slice(0, -2));
      const total = parseInt(countResult.rows[0].total);
      
      return res.status(200).json({
        data: result.rows,
        pagination: {
          total,
          offset: parseInt(offset),
          limit: parseInt(limit),
          has_more: total > (parseInt(offset) + result.rows.length)
        }
      });
    } catch (error) {
      console.error('[FavoritesController] Error getting user favorites:', error);
      return res.status(500).json({ error: 'Failed to retrieve favorites' });
    }
  };

  /**
   * Check if an item is favorited by the current user
   */
  const checkFavoriteStatus = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { list_id, list_item_id } = req.query;
    
    // Validate that either list_id or list_item_id is provided, but not both
    if ((!list_id && !list_item_id) || (list_id && list_item_id)) {
      return res.status(400).json({ error: 'Either list_id or list_item_id must be provided, but not both' });
    }

    try {
      const query = `
        SELECT id, category_id, is_public, notes, sort_order
        FROM public.favorites 
        WHERE user_id = $1 
        AND ${list_id ? 'list_id = $2' : 'list_item_id = $2'}
        AND deleted_at IS NULL
      `;
      const params = [userId, list_id || list_item_id];
      
      const result = await db.query(query, params);
      
      if (result.rows.length > 0) {
        return res.status(200).json({
          is_favorited: true,
          favorite: result.rows[0]
        });
      } else {
        return res.status(200).json({
          is_favorited: false
        });
      }
    } catch (error) {
      console.error('[FavoritesController] Error checking favorite status:', error);
      return res.status(500).json({ error: 'Failed to check favorite status' });
    }
  };

  /**
   * Get total count of favorites for a given target (list or list_item)
   */
  const getFavoriteCount = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { list_id, list_item_id } = req.query;
    if ((!list_id && !list_item_id) || (list_id && list_item_id)) {
      return res.status(400).json({ error: 'Either list_id or list_item_id must be provided, but not both' });
    }
    try {
      // Detect schema: legacy uses target_type/target_id; new uses list_id/list_item_id
      const colCheck = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='favorites'`
      );
      const columnNames = colCheck.rows.map(r => r.column_name);
      const hasListColumns = columnNames.includes('list_id') && columnNames.includes('list_item_id');

      let result;
      if (hasListColumns) {
        const query = `
          SELECT COUNT(*)::int as count
          FROM public.favorites
          WHERE ${list_id ? 'list_id = $1' : 'list_item_id = $1'}
            AND deleted_at IS NULL
        `;
        const params = [list_id || list_item_id];
        result = await db.query(query, params);
      } else {
        // Legacy schema
        const isList = !!list_id;
        const query = `
          SELECT COUNT(*)::int as count
          FROM public.favorites
          WHERE target_type = $1 AND target_id = $2 AND deleted_at IS NULL
        `;
        const params = [isList ? 'list' : 'item', list_id || list_item_id];
        result = await db.query(query, params);
      }
      return res.status(200).json({ count: result.rows?.[0]?.count ?? 0 });
    } catch (error) {
      console.error('[FavoritesController] Error getting favorite count:', error);
      return res.status(500).json({ error: 'Failed to get favorite count' });
    }
  };

  /**
   * Get users who liked/favorited a target (owner-only)
   */
  const getLikersForTarget = async (req, res) => {
    console.log('getLikersForTarget', req.query);
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const listIdParam = req.query.list_id ? String(req.query.list_id) : null;
    const listItemIdParam = req.query.list_item_id ? String(req.query.list_item_id) : null;

    if (!listIdParam && !listItemIdParam) {
      return res.status(400).json({ error: 'Either list_id or list_item_id must be provided' });
    }

    try {
      let resolvedListId = listIdParam;
      let resolvedListItemId = listItemIdParam;

      if (!resolvedListId && resolvedListItemId) {
        const itemQuery = `
          SELECT li.list_id
          FROM public.list_items li
          WHERE li.id = $1 AND li.deleted_at IS NULL
        `;
        const itemRes = await db.query(itemQuery, [resolvedListItemId]);
        if (itemRes.rows.length === 0) {
          return res.status(404).json({ error: 'List item not found' });
        }
        resolvedListId = String(itemRes.rows[0].list_id);
      }

      if (!resolvedListId) {
        return res.status(400).json({ error: 'Unable to determine parent list for favorites lookup' });
      }

      if (listIdParam && resolvedListId && String(listIdParam) !== String(resolvedListId)) {
        return res.status(400).json({ error: 'Provided list_id does not match the list for the specified list_item_id' });
      }

      // Verify viewer access (owner, public list, or collaborator/group member)
      const listMetaQuery = `
        SELECT l.owner_id, COALESCE(l.is_public, false) AS is_public
        FROM public.lists l
        WHERE l.id = $1 AND l.deleted_at IS NULL
      `;
      const listMetaRes = await db.query(listMetaQuery, [resolvedListId]);
      if (listMetaRes.rows.length === 0) {
        return res.status(404).json({ error: 'List not found' });
      }

      const { owner_id: ownerId, is_public: isPublic } = listMetaRes.rows[0];
      const isOwner = String(ownerId) === String(userId);
      let canView = isOwner || Boolean(isPublic);

      if (!canView) {
        const directAccessRes = await db.query(
          `
            SELECT 1
            FROM public.list_collaborators lc
            WHERE lc.list_id = $1
              AND lc.user_id = $2
            LIMIT 1
          `,
          [resolvedListId, userId]
        );

        if (directAccessRes.rows.length > 0) {
          canView = true;
        } else {
          try {
            const groupAccessRes = await db.query(
              `SELECT public.user_can_access_list_through_group($2::uuid, $1::uuid) AS can_access`,
              [resolvedListId, userId]
            );
            canView = Boolean(groupAccessRes.rows?.[0]?.can_access);
          } catch (groupErr) {
            // Function might not exist on older schemas – fallback to explicit join
            const legacyGroupRes = await db.query(
              `
                SELECT 1
                FROM public.collaboration_group_lists cgl
                JOIN public.collaboration_group_members cgm ON cgl.group_id = cgm.group_id
                WHERE cgl.list_id = $1
                  AND cgm.user_id = $2
                  AND (cgm.deleted_at IS NULL OR cgm.deleted_at > NOW())
                LIMIT 1
              `,
              [resolvedListId, userId]
            );
            canView = legacyGroupRes.rows.length > 0;
          }
        }
      }

      if (!canView) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Detect schema
      const colCheck = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='favorites'`
      );
      const columnNames = colCheck.rows.map(r => r.column_name);
      const hasListColumns = columnNames.includes('list_id') && columnNames.includes('list_item_id');

      let result;
      const targetValue = resolvedListItemId ?? resolvedListId;
      const useListItem = Boolean(resolvedListItemId);

      if (hasListColumns) {
        const query = `
          SELECT f.id,
                 f.user_id,
                 f.created_at,
                 u.username,
                 CASE
                   WHEN u.full_name IS NOT NULL AND trim(u.full_name) <> '' THEN u.full_name::text
                   ELSE u.username::text
                 END AS display_name,
                 NULLIF(u.profile_image_url::text, '') AS avatar_url
          FROM public.favorites f
          JOIN public.users u ON u.id = f.user_id
          WHERE ${useListItem ? 'f.list_item_id = $1' : 'f.list_id = $1'}
            AND f.deleted_at IS NULL
          ORDER BY f.created_at DESC
        `;
        const params = [targetValue];
        result = await db.query(query, params);
      } else {
        const isList = !useListItem;
        const query = `
          SELECT f.id,
                 f.user_id,
                 f.created_at,
                 u.username,
                 CASE
                   WHEN u.full_name IS NOT NULL AND trim(u.full_name) <> '' THEN u.full_name::text
                   ELSE u.username::text
                 END AS display_name,
                 NULLIF(u.profile_image_url::text, '') AS avatar_url
          FROM public.favorites f
          JOIN public.users u ON u.id = f.user_id
          WHERE f.target_type = $1 AND f.target_id = $2 AND f.deleted_at IS NULL
          ORDER BY f.created_at DESC
        `;
        const params = [isList ? 'list' : 'item', targetValue];
        result = await db.query(query, params);
      }

      return res.status(200).json({ data: result.rows });
    } catch (error) {
      console.log('[FavoritesController] Error getting likers:', error);
      return res.status(500).json({ error: 'Failed to get likers' });
    }
  };

  /**
   * Manage favorite categories (CRUD operations)
   */
  const createCategory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { name, color, icon, description, sort_order } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    try {
      const query = `
        INSERT INTO public.favorite_categories (
          user_id, name, color, icon, description, sort_order
        ) 
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;
      const params = [
        userId, 
        name, 
        color || null, 
        icon || null, 
        description || null, 
        sort_order || 0
      ];
      
      const result = await db.query(query, params);
      
      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      return res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('[FavoritesController] Error creating category:', error);
      return res.status(500).json({ error: 'Failed to create category' });
    }
  };

  const updateCategory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { name, color, icon, description, sort_order } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Category ID is required' });
    }

    try {
      // Check if category exists and belongs to the user
      const checkQuery = `
        SELECT id FROM public.favorite_categories 
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `;
      const checkResult = await db.query(checkQuery, [id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found or not owned by you' });
      }

      // Update fields that are provided
      const updateFields = [];
      const updateParams = [id, userId];
      let paramIndex = 3;

      if (name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`);
        updateParams.push(name);
      }
      
      if (color !== undefined) {
        updateFields.push(`color = $${paramIndex++}`);
        updateParams.push(color);
      }
      
      if (icon !== undefined) {
        updateFields.push(`icon = $${paramIndex++}`);
        updateParams.push(icon);
      }
      
      if (description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        updateParams.push(description);
      }
      
      if (sort_order !== undefined) {
        updateFields.push(`sort_order = $${paramIndex++}`);
        updateParams.push(sort_order);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const updateQuery = `
        UPDATE public.favorite_categories 
        SET ${updateFields.join(', ')}
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `;
      
      const result = await db.query(updateQuery, updateParams);
      
      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      return res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error('[FavoritesController] Error updating category:', error);
      return res.status(500).json({ error: 'Failed to update category' });
    }
  };

  const deleteCategory = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Category ID is required' });
    }

    try {
      // Check if category exists and belongs to the user
      const checkQuery = `
        SELECT id FROM public.favorite_categories 
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `;
      const checkResult = await db.query(checkQuery, [id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found or not owned by you' });
      }

      // Begin transaction
      await db.transaction(async (client) => {
        // Update favorites that use this category to NULL
        const updateFavoritesQuery = `
          UPDATE public.favorites 
          SET category_id = NULL
          WHERE category_id = $1 AND user_id = $2
        `;
        await client.query(updateFavoritesQuery, [id, userId]);
        
        // Soft delete the category
        const deleteCategoryQuery = `
          UPDATE public.favorite_categories 
          SET deleted_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2
          RETURNING id
        `;
        await client.query(deleteCategoryQuery, [id, userId]);
        
        // Sync tracking is now handled automatically by database triggers
      });

      return res.status(200).json({ 
        message: 'Category deleted successfully',
        id
      });
    } catch (error) {
      console.error('[FavoritesController] Error deleting category:', error);
      return res.status(500).json({ error: 'Failed to delete category' });
    }
  };

  const getCategories = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const query = `
        SELECT fc.*, 
               COUNT(f.id) as favorites_count
        FROM public.favorite_categories fc
        LEFT JOIN public.favorites f ON fc.id = f.category_id AND f.deleted_at IS NULL
        WHERE fc.user_id = $1 AND fc.deleted_at IS NULL
        GROUP BY fc.id
        ORDER BY fc.sort_order ASC, fc.name ASC
      `;
      
      const result = await db.query(query, [userId]);
      
      return res.status(200).json(result.rows);
    } catch (error) {
      console.error('[FavoritesController] Error getting categories:', error);
      return res.status(500).json({ error: 'Failed to retrieve categories' });
    }
  };

  /**
   * Update favorite sort order (batch operation)
   */
  const updateFavoriteSortOrder = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { items } = req.body;
    
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    try {
      // Begin transaction
      await db.transaction(async (client) => {
        for (let i = 0; i < items.length; i++) {
          const { id, sort_order } = items[i];
          
          // Verify ownership
          const checkQuery = `
            SELECT id FROM public.favorites 
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          `;
          const checkResult = await client.query(checkQuery, [id, userId]);
          
          if (checkResult.rows.length === 0) {
            console.warn(`[FavoritesController] Favorite ${id} not found or not owned by user ${userId}`);
            continue; // Skip this item
          }
          
          // Update sort order
          const updateQuery = `
            UPDATE public.favorites 
            SET sort_order = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND user_id = $3
          `;
          await client.query(updateQuery, [sort_order, id, userId]);
          
          // Sync tracking is now handled automatically by database triggers
        }
      });
      
      return res.status(200).json({ 
        message: 'Sort order updated successfully',
        updated_count: items.length
      });
    } catch (error) {
      console.error('[FavoritesController] Error updating sort order:', error);
      return res.status(500).json({ error: 'Failed to update sort order' });
    }
  };

  /**
   * Share a favorite with another user or group
   */
  const shareFavorite = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { favorite_id, shared_with_user_id, shared_with_group_id, permissions } = req.body;
    
    if (!favorite_id) {
      return res.status(400).json({ error: 'Favorite ID is required' });
    }
    
    if ((!shared_with_user_id && !shared_with_group_id) || (shared_with_user_id && shared_with_group_id)) {
      return res.status(400).json({ error: 'Either shared_with_user_id or shared_with_group_id must be provided, but not both' });
    }

    try {
      // Check if favorite exists and belongs to the user
      const checkQuery = `
        SELECT id FROM public.favorites 
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `;
      const checkResult = await db.query(checkQuery, [favorite_id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Favorite not found or not owned by you' });
      }

      // Check if sharing already exists (handle soft-deleted sharing)
      const existingQuery = `
        SELECT id, deleted_at FROM public.favorite_sharing 
        WHERE favorite_id = $1 
        AND shared_by_user_id = $2
        AND ${shared_with_user_id ? 'shared_with_user_id = $3' : 'shared_with_group_id = $3'}
      `;
      const existingParams = [favorite_id, userId, shared_with_user_id || shared_with_group_id];
      const existingResult = await db.query(existingQuery, existingParams);

      let sharingId;

      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        
        if (existing.deleted_at) {
          // Restore soft-deleted sharing
          const restoreQuery = `
            UPDATE public.favorite_sharing 
            SET deleted_at = NULL,
                permissions = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND shared_by_user_id = $2
            RETURNING id
          `;
          const restoreParams = [existing.id, userId, permissions || 'view'];
          const restoreResult = await db.query(restoreQuery, restoreParams);
          sharingId = restoreResult.rows[0].id;
        } else {
          // Already exists and not deleted - just update permissions
          const updateQuery = `
            UPDATE public.favorite_sharing 
            SET permissions = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND shared_by_user_id = $2
            RETURNING id
          `;
          const updateParams = [existing.id, userId, permissions || 'view'];
          const updateResult = await db.query(updateQuery, updateParams);
          sharingId = updateResult.rows[0].id;
        }
      } else {
        // Create new sharing
        const insertQuery = `
          INSERT INTO public.favorite_sharing (
            favorite_id,
            shared_by_user_id,
            ${shared_with_user_id ? 'shared_with_user_id' : 'shared_with_group_id'},
            permissions
          ) 
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `;
        const insertParams = [
          favorite_id,
          userId,
          shared_with_user_id || shared_with_group_id,
          permissions || 'view'
        ];
        const insertResult = await db.query(insertQuery, insertParams);
        sharingId = insertResult.rows[0].id;
      }

      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      // Send realtime notification if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function' && shared_with_user_id) {
        safeSocketService.emitToUser(shared_with_user_id, 'favorite:shared', { 
          favorite_id,
          shared_by: userId
        });
      }

      // Get the complete sharing record
      const sharingQuery = `
        SELECT * FROM public.favorite_sharing WHERE id = $1
      `;
      const sharingResult = await db.query(sharingQuery, [sharingId]);
      
      return res.status(200).json(sharingResult.rows[0]);
    } catch (error) {
      console.error('[FavoritesController] Error sharing favorite:', error);
      return res.status(500).json({ error: 'Failed to share favorite' });
    }
  };

  /**
   * Remove a sharing
   */
  const removeSharing = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Sharing ID is required' });
    }

    try {
      // Check if sharing exists and user is the sharer
      const checkQuery = `
        SELECT id, shared_with_user_id FROM public.favorite_sharing 
        WHERE id = $1 AND shared_by_user_id = $2 AND deleted_at IS NULL
      `;
      const checkResult = await db.query(checkQuery, [id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Sharing not found or not created by you' });
      }

      const shared_with_user_id = checkResult.rows[0].shared_with_user_id;

      // Soft delete the sharing
      const deleteQuery = `
        UPDATE public.favorite_sharing 
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND shared_by_user_id = $2
        RETURNING id
      `;
      await db.query(deleteQuery, [id, userId]);

      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      // Send realtime notification if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function' && shared_with_user_id) {
        safeSocketService.emitToUser(shared_with_user_id, 'favorite:unshared', { 
          sharing_id: id,
          unshared_by: userId
        });
      }

      return res.status(200).json({ 
        message: 'Sharing removed successfully',
        id
      });
    } catch (error) {
      console.error('[FavoritesController] Error removing sharing:', error);
      return res.status(500).json({ error: 'Failed to remove sharing' });
    }
  };

  /**
   * Get favorites shared with the current user
   */
  const getSharedWithMe = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const { offset = 0, limit = 100 } = req.query;
      
      const query = `
        SELECT 
          fs.*,
          f.*,
          u.username as shared_by_username,
          u.display_name as shared_by_display_name,
          u.avatar_url as shared_by_avatar,
          CASE 
            WHEN f.list_id IS NOT NULL THEN json_build_object(
              'id', l.id,
              'title', l.title,
              'description', l.description,
              'is_public', l.is_public,
              'list_type', l.list_type,
              'background', l.background
            )
            ELSE NULL
          END as list_data,
          CASE 
            WHEN f.list_item_id IS NOT NULL THEN json_build_object(
              'id', li.id,
              'title', li.title,
              'description', li.description,
              'image_url', li.image_url,
              'list_id', li.list_id,
              'status', li.status
            )
            ELSE NULL
          END as list_item_data
        FROM 
          public.favorite_sharing fs
        JOIN 
          public.favorites f ON fs.favorite_id = f.id
        JOIN 
          public.users u ON fs.shared_by_user_id = u.id
        LEFT JOIN 
          public.lists l ON f.list_id = l.id
        LEFT JOIN 
          public.list_items li ON f.list_item_id = li.id
        WHERE 
          fs.shared_with_user_id = $1
          AND fs.deleted_at IS NULL
          AND f.deleted_at IS NULL
          AND (l.deleted_at IS NULL OR l.id IS NULL)
          AND (li.deleted_at IS NULL OR li.id IS NULL)
        ORDER BY 
          fs.created_at DESC
        LIMIT $2 OFFSET $3
      `;
      
      const result = await db.query(query, [userId, parseInt(limit), parseInt(offset)]);
      
      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM public.favorite_sharing fs
        JOIN public.favorites f ON fs.favorite_id = f.id
        LEFT JOIN public.lists l ON f.list_id = l.id
        LEFT JOIN public.list_items li ON f.list_item_id = li.id
        WHERE 
          fs.shared_with_user_id = $1
          AND fs.deleted_at IS NULL
          AND f.deleted_at IS NULL
          AND (l.deleted_at IS NULL OR l.id IS NULL)
          AND (li.deleted_at IS NULL OR li.id IS NULL)
      `;
      
      const countResult = await db.query(countQuery, [userId]);
      const total = parseInt(countResult.rows[0].total);
      
      return res.status(200).json({
        data: result.rows,
        pagination: {
          total,
          offset: parseInt(offset),
          limit: parseInt(limit),
          has_more: total > (parseInt(offset) + result.rows.length)
        }
      });
    } catch (error) {
      console.error('[FavoritesController] Error getting shared favorites:', error);
      return res.status(500).json({ error: 'Failed to retrieve shared favorites' });
    }
  };

  /**
   * Set notification preferences for a favorite
   */
  const setNotificationPreferences = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { favorite_id, notify_on_update, notify_on_comment } = req.body;
    
    if (!favorite_id) {
      return res.status(400).json({ error: 'Favorite ID is required' });
    }

    try {
      // Check if favorite exists (either owned by user or shared with user)
      const checkQuery = `
        SELECT id FROM (
          SELECT id FROM public.favorites 
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          UNION
          SELECT f.id FROM public.favorites f
          JOIN public.favorite_sharing fs ON fs.favorite_id = f.id
          WHERE f.id = $1 AND fs.shared_with_user_id = $2 AND fs.deleted_at IS NULL AND f.deleted_at IS NULL
        ) as combined_favorites
      `;
      const checkResult = await db.query(checkQuery, [favorite_id, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Favorite not found, not owned by you, or not shared with you' });
      }

      // Check if preferences already exist
      const existingQuery = `
        SELECT id FROM public.favorite_notification_preferences 
        WHERE favorite_id = $1 AND user_id = $2 AND deleted_at IS NULL
      `;
      const existingResult = await db.query(existingQuery, [favorite_id, userId]);

      let preferenceId;

      if (existingResult.rows.length > 0) {
        // Update existing preferences
        const updateQuery = `
          UPDATE public.favorite_notification_preferences 
          SET notify_on_update = $3,
              notify_on_comment = $4,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2
          RETURNING id
        `;
        const updateParams = [
          existingResult.rows[0].id, 
          userId, 
          notify_on_update !== undefined ? notify_on_update : true, 
          notify_on_comment !== undefined ? notify_on_comment : true
        ];
        const updateResult = await db.query(updateQuery, updateParams);
        preferenceId = updateResult.rows[0].id;
      } else {
        // Create new preferences
        const insertQuery = `
          INSERT INTO public.favorite_notification_preferences (
            user_id,
            favorite_id,
            notify_on_update,
            notify_on_comment
          ) 
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `;
        const insertParams = [
          userId,
          favorite_id,
          notify_on_update !== undefined ? notify_on_update : true,
          notify_on_comment !== undefined ? notify_on_comment : true
        ];
        const insertResult = await db.query(insertQuery, insertParams);
        preferenceId = insertResult.rows[0].id;
      }

      // Add to sync tracking
      // Sync tracking is now handled automatically by database triggers

      // Get the complete notification preferences
      const preferencesQuery = `
        SELECT * FROM public.favorite_notification_preferences WHERE id = $1
      `;
      const preferencesResult = await db.query(preferencesQuery, [preferenceId]);
      
      return res.status(200).json(preferencesResult.rows[0]);
    } catch (error) {
      console.error('[FavoritesController] Error setting notification preferences:', error);
      return res.status(500).json({ error: 'Failed to set notification preferences' });
    }
  };

  // Return all controller methods
  return {
    addToFavorites,
    removeFromFavorites,
    getUserFavorites,
    checkFavoriteStatus,
    getFavoriteCount,
    getLikersForTarget,
    createCategory,
    updateCategory,
    deleteCategory,
    getCategories,
    updateFavoriteSortOrder,
    shareFavorite,
    removeSharing,
    getSharedWithMe,
    setNotificationPreferences
  };
}

module.exports = favoritesControllerFactory; 
