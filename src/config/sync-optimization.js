const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../utils/logger');

class SyncOptimization {
  constructor() {
    this.memoryCache = new Map();
    this.userSyncCache = new Map();
    this.syncLocks = new Map();
    this.rateLimitCache = new Map();
    this.activityCache = new Map();
    this.cacheFile = path.join(__dirname, '../../data/sync-cache.json');
    this.maxCacheSize = 10000; // Maximum cache entries
    this.cacheStats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0
    };
    this.initializeCache();
  }

  async initializeCache() {
    try {
      // Create data directory if it doesn't exist
      const dataDir = path.dirname(this.cacheFile);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Load existing cache from file if it exists
      try {
        const cacheData = await fs.readFile(this.cacheFile, 'utf8');
        const parsed = JSON.parse(cacheData);
        
        // Restore cache entries that haven't expired
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed)) {
          if (!entry.expiresAt || entry.expiresAt > now) {
            this.memoryCache.set(key, entry);
          }
        }
        logger.info(`[SyncOptimization] Loaded ${this.memoryCache.size} cache entries from disk`);
      } catch (readError) {
        // File doesn't exist or is invalid, start with empty cache
        logger.info('[SyncOptimization] Starting with empty cache');
      }
      
      // Set up periodic cache persistence (every 5 minutes)
      this.persistInterval = setInterval(() => this.persistCache(), 5 * 60 * 1000);
      
      // Set up periodic cleanup (every minute)
      this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
      
      logger.info('[SyncOptimization] In-memory cache with file persistence initialized');
    } catch (error) {
      logger.error('[SyncOptimization] Cache initialization failed:', error);
    }
  }

  async persistCache() {
    try {
      const cacheData = {};
      for (const [key, value] of this.memoryCache.entries()) {
        cacheData[key] = value;
      }
      await fs.writeFile(this.cacheFile, JSON.stringify(cacheData), 'utf8');
      logger.debug(`[SyncOptimization] Persisted ${Object.keys(cacheData).length} cache entries`);
    } catch (error) {
      logger.error('[SyncOptimization] Cache persistence failed:', error);
    }
  }

  /**
   * Get cached sync data for user
   */
  async getCachedSyncData(userId, lastPulledAt) {
    const cacheKey = `sync:${userId}:${lastPulledAt}`;
    
    try {
      const cached = this.memoryCache.get(cacheKey);
      if (cached) {
        // Check if cache entry has expired
        if (!cached.expiresAt || cached.expiresAt > Date.now()) {
          this.cacheStats.hits++;
          logger.info(`[SyncOptimization] Cache hit for user ${userId}`);
          return cached.data;
        } else {
          // Remove expired entry
          this.memoryCache.delete(cacheKey);
        }
      }
      this.cacheStats.misses++;
    } catch (error) {
      logger.error('[SyncOptimization] Cache retrieval error:', error);
    }
    
    return null;
  }

  /**
   * Cache sync data for user
   */
  async cacheSyncData(userId, lastPulledAt, data, ttlSeconds = 300) {
    const cacheKey = `sync:${userId}:${lastPulledAt}`;
    
    try {
      // Enforce cache size limit
      if (this.memoryCache.size >= this.maxCacheSize) {
        // Remove oldest entries (simple LRU)
        const sortedEntries = Array.from(this.memoryCache.entries())
          .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
        
        // Remove oldest 10% of entries
        const toRemove = Math.ceil(this.maxCacheSize * 0.1);
        for (let i = 0; i < toRemove && i < sortedEntries.length; i++) {
          this.memoryCache.delete(sortedEntries[i][0]);
          this.cacheStats.deletes++;
        }
      }

      const cacheEntry = {
        data,
        createdAt: Date.now(),
        expiresAt: Date.now() + (ttlSeconds * 1000)
      };
      
      this.memoryCache.set(cacheKey, cacheEntry);
      this.cacheStats.sets++;
      logger.info(`[SyncOptimization] Cached sync data for user ${userId} (TTL: ${ttlSeconds}s)`);
    } catch (error) {
      logger.error('[SyncOptimization] Cache storage error:', error);
    }
  }

  /**
   * In-memory lock for sync operations
   */
  async acquireSyncLock(userId, timeout = 5000) {
    try {
      // Check if lock already exists and hasn't expired
      const existingLock = this.syncLocks.get(userId);
      if (existingLock && Date.now() < existingLock.expiresAt) {
        return false; // Lock is still active
      }
      
      // Acquire new lock
      const lockInfo = {
        acquiredAt: Date.now(),
        expiresAt: Date.now() + timeout,
        timeout: timeout
      };
      
      this.syncLocks.set(userId, lockInfo);
      
      // Auto-cleanup expired lock
      setTimeout(() => {
        const currentLock = this.syncLocks.get(userId);
        if (currentLock && currentLock.acquiredAt === lockInfo.acquiredAt) {
          this.syncLocks.delete(userId);
        }
      }, timeout);
      
      logger.debug(`[SyncOptimization] Acquired sync lock for user ${userId} (timeout: ${timeout}ms)`);
      return true;
    } catch (error) {
      logger.error('[SyncOptimization] Lock acquisition error:', error);
      return false;
    }
  }

  /**
   * Release sync lock
   */
  async releaseSyncLock(userId) {
    try {
      this.syncLocks.delete(userId);
      logger.debug(`[SyncOptimization] Released sync lock for user ${userId}`);
    } catch (error) {
      logger.error('[SyncOptimization] Lock release error:', error);
    }
  }

  /**
   * Check if user has recent sync activity
   */
  async hasRecentSyncActivity(userId, windowMs = 10000) {
    const activityKey = `sync_activity:${userId}`;
    
    try {
      if (this.redis) {
        const lastActivity = await this.redis.get(activityKey);
        if (lastActivity && Date.now() - parseInt(lastActivity) < windowMs) {
          return true;
        }
        await this.redis.setEx(activityKey, 60, Date.now().toString());
      } else {
        // In-memory tracking
        const lastActivity = this.userSyncCache.get(activityKey);
        if (lastActivity && Date.now() - lastActivity < windowMs) {
          return true;
        }
        this.userSyncCache.set(activityKey, Date.now());
      }
    } catch (error) {
      logger.error('[SyncOptimization] Activity check error:', error);
    }
    
    return false;
  }

  /**
   * Rate limiting for sync requests
   */
  async isRateLimited(userId, maxRequests = 60, windowMs = 60000) {
    const rateLimitKey = `rate_limit:${userId}`;
    
    try {
      if (this.redis) {
        const current = await this.redis.incr(rateLimitKey);
        if (current === 1) {
          await this.redis.expire(rateLimitKey, Math.ceil(windowMs / 1000));
        }
        return current > maxRequests;
      } else {
        // Simple in-memory rate limiting
        const now = Date.now();
        const requests = this.userSyncCache.get(rateLimitKey) || [];
        const recentRequests = requests.filter(time => now - time < windowMs);
        
        if (recentRequests.length >= maxRequests) {
          return true;
        }
        
        recentRequests.push(now);
        this.userSyncCache.set(rateLimitKey, recentRequests);
        return false;
      }
    } catch (error) {
      logger.error('[SyncOptimization] Rate limit check error:', error);
      return false;
    }
  }

  /**
   * Cleanup old cache entries
   */
  async cleanup() {
    try {
      if (this.redis) {
        // Redis TTL handles cleanup automatically
        return;
      }
      
      // Clean in-memory cache
      const now = Date.now();
      for (const [key, value] of this.userSyncCache.entries()) {
        if (value.timestamp && now - value.timestamp > 300000) { // 5 minutes
          this.userSyncCache.delete(key);
        }
      }
      
      // Clean old locks
      for (const [userId, timestamp] of this.syncLocks.entries()) {
        if (now - timestamp > 30000) { // 30 seconds
          this.syncLocks.delete(userId);
        }
      }
    } catch (error) {
      logger.error('[SyncOptimization] Cleanup error:', error);
    }
  }

  /**
   * Get optimization statistics
   */
  getStats() {
    return {
      has_redis: !!this.redis,
      in_memory_cache_size: this.userSyncCache.size,
      active_locks: this.syncLocks.size,
      cache_type: this.redis ? 'Redis' : 'In-Memory'
    };
  }
}

module.exports = new SyncOptimization(); 