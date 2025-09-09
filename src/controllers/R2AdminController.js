const { listR2Objects, generatePresignedGetUrl, isR2Configured, deleteR2Object } = require('../services/r2Service');
const db = require('../config/db');

/**
 * Factory function that creates an R2AdminController for admin operations
 * @returns {Object} Controller object with R2 admin methods
 */
function r2AdminControllerFactory() {
  /**
   * List objects in R2 bucket with optional filtering
   * Admin endpoint - requires admin authentication
   */
  const listObjects = async (req, res) => {
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File storage service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    // Check if user is admin
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { 
      prefix = '', 
      userId = null,
      continuationToken = null, 
      maxKeys = 50,
      imageOnly = true 
    } = req.query;

    try {
      // Build the prefix based on parameters
      let searchPrefix = prefix;
      if (userId) {
        searchPrefix = `user-uploads/user-${userId}/`;
      }

      // List objects from R2
      const result = await listR2Objects({
        prefix: searchPrefix,
        continuationToken,
        maxKeys: parseInt(maxKeys)
      });

      // Filter for images if requested
      let contents = result.contents;
      if (imageOnly === 'true' || imageOnly === true) {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
        contents = contents.filter(item => {
          const key = item.Key.toLowerCase();
          return imageExtensions.some(ext => key.endsWith(ext));
        });
      }

      // Extract unique user IDs from objects
      const userIds = new Set();
      contents.forEach(item => {
        const userId = item.Key.match(/user-uploads\/user-([^\/]+)/)?.[1];
        if (userId) userIds.add(userId);
      });

      // Fetch user names from database
      let userNames = {};
      if (userIds.size > 0) {
        try {
          const userResult = await db.query(
            `SELECT id, username, email FROM users WHERE id = ANY($1::uuid[])`,
            [Array.from(userIds)]
          );
          userResult.rows.forEach(user => {
            userNames[user.id] = {
              username: user.username,
              email: user.email
            };
          });
        } catch (dbError) {
          console.error('Failed to fetch user names:', dbError);
          // Continue without user names if database query fails
        }
      }

      // Generate presigned URLs for each object
      const itemsWithUrls = await Promise.all(
        contents.map(async (item) => {
          try {
            const presignedUrl = await generatePresignedGetUrl(item.Key, 3600); // 1 hour expiry
            const userId = item.Key.match(/user-uploads\/user-([^\/]+)/)?.[1] || null;
            return {
              key: item.Key,
              size: item.Size,
              lastModified: item.LastModified,
              etag: item.ETag,
              publicUrl: item.PublicUrl,
              presignedUrl,
              userId,
              userName: userId && userNames[userId] ? userNames[userId].username : null,
              userEmail: userId && userNames[userId] ? userNames[userId].email : null,
            };
          } catch (error) {
            console.error(`Failed to generate URL for ${item.Key}:`, error);
            const userId = item.Key.match(/user-uploads\/user-([^\/]+)/)?.[1] || null;
            return {
              key: item.Key,
              size: item.Size,
              lastModified: item.LastModified,
              etag: item.ETag,
              publicUrl: item.PublicUrl,
              presignedUrl: null,
              userId,
              userName: userId && userNames[userId] ? userNames[userId].username : null,
              userEmail: userId && userNames[userId] ? userNames[userId].email : null,
            };
          }
        })
      );

      res.json({
        items: itemsWithUrls,
        isTruncated: result.isTruncated,
        nextContinuationToken: result.nextContinuationToken,
        totalCount: result.keyCount,
      });
    } catch (error) {
      console.error('[R2AdminController] Error listing objects:', error);
      res.status(500).json({ 
        error: 'Failed to list objects', 
        details: error.message 
      });
    }
  };

  /**
   * Get presigned URL for a specific object
   * Admin endpoint - requires admin authentication
   */
  const getObjectUrl = async (req, res) => {
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File storage service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { key } = req.params;
    const { expiresIn = 3600 } = req.query;

    if (!key) {
      return res.status(400).json({ error: 'Object key is required' });
    }

    try {
      const presignedUrl = await generatePresignedGetUrl(
        decodeURIComponent(key), 
        parseInt(expiresIn)
      );
      
      const publicBase = process.env.R2_PUBLIC_URL_BASE;
      const publicUrl = publicBase ? `${publicBase}/${key}` : null;

      res.json({
        key,
        presignedUrl,
        publicUrl,
        expiresIn: parseInt(expiresIn),
      });
    } catch (error) {
      console.error('[R2AdminController] Error generating URL:', error);
      res.status(500).json({ 
        error: 'Failed to generate object URL', 
        details: error.message 
      });
    }
  };

  /**
   * Delete an object from R2
   * Admin endpoint - requires admin authentication
   */
  const deleteObject = async (req, res) => {
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File storage service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { key } = req.params;

    if (!key) {
      return res.status(400).json({ error: 'Object key is required' });
    }

    try {
      await deleteR2Object(decodeURIComponent(key));
      res.json({ 
        success: true, 
        message: 'Object deleted successfully',
        key 
      });
    } catch (error) {
      console.error('[R2AdminController] Error deleting object:', error);
      res.status(500).json({ 
        error: 'Failed to delete object', 
        details: error.message 
      });
    }
  };

  /**
   * Get storage statistics
   * Admin endpoint - requires admin authentication
   */
  const getStorageStats = async (req, res) => {
    if (!isR2Configured()) {
      return res.status(503).json({ 
        error: 'File storage service is currently unavailable', 
        details: 'R2 storage is not configured' 
      });
    }

    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    try {
      // Get all objects to calculate stats
      let allObjects = [];
      let continuationToken = null;
      let totalSize = 0;
      const userStats = {};

      do {
        const result = await listR2Objects({
          prefix: 'user-uploads/',
          continuationToken,
          maxKeys: 1000
        });

        allObjects = allObjects.concat(result.contents);
        continuationToken = result.nextContinuationToken;

        // Calculate stats
        result.contents.forEach(item => {
          totalSize += item.Size || 0;
          
          // Extract user ID and accumulate stats
          const userId = item.Key.match(/user-uploads\/user-([^\/]+)/)?.[1];
          if (userId) {
            if (!userStats[userId]) {
              userStats[userId] = { count: 0, size: 0 };
            }
            userStats[userId].count++;
            userStats[userId].size += item.Size || 0;
          }
        });
      } while (continuationToken);

      // Sort users by storage size
      const topUsers = Object.entries(userStats)
        .map(([userId, stats]) => ({ userId, ...stats }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 10);

      res.json({
        totalObjects: allObjects.length,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        uniqueUsers: Object.keys(userStats).length,
        topUsersByStorage: topUsers,
      });
    } catch (error) {
      console.error('[R2AdminController] Error getting storage stats:', error);
      res.status(500).json({ 
        error: 'Failed to get storage statistics', 
        details: error.message 
      });
    }
  };

  return {
    listObjects,
    getObjectUrl,
    deleteObject,
    getStorageStats,
  };
}

module.exports = r2AdminControllerFactory;