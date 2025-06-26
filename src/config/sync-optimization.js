const Redis = require('redis');
const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../utils/logger');

class SyncOptimization {
  constructor() {
    this.redis = null;
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
    this.isRedisConnected = false;
    this.initializeCache();
  }

  async initializeCache() {
    try {
      // First try to connect to Valkey/Redis
      if (process.env.VALKEY_URL || process.env.REDIS_URL) {
        const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL;
        this.redis = Redis.createClient({ url: redisUrl });
        
        this.redis.on('error', (err) => {
          logger.error('[SyncOptimization] Redis/Valkey connection error:', err);
          this.isRedisConnected = false;
        });

        this.redis.on('connect', () => {
          logger.info('[SyncOptimization] Connected to Valkey/Redis');
          this.isRedisConnected = true;
        });

        this.redis.on('ready', () => {
          logger.info('[SyncOptimization] Valkey/Redis ready for operations');
          this.isRedisConnected = true;
        });

        await this.redis.connect();
        logger.info('[SyncOptimization] Valkey/Redis cache initialized');
      } else {
        logger.info('[SyncOptimization] No Redis/Valkey URL provided, using in-memory cache');
      }
    } catch (error) {
      logger.error('[SyncOptimization] Redis/Valkey initialization failed, falling back to in-memory:', error);
      this.isRedisConnected = false;
    }

    // Initialize file-based persistence for fallback
    if (!this.isRedisConnected) {
      await this.initializeFileCache();
    }

    // Set up periodic cleanup
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
  }

  async initializeFileCache() {
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
        logger.info('[SyncOptimization] Starting with empty in-memory cache');
      }
      
      // Set up periodic cache persistence (every 5 minutes)
      this.persistInterval = setInterval(() => this.persistCache(), 5 * 60 * 1000);
      
      logger.info('[SyncOptimization] In-memory cache with file persistence initialized');
    } catch (error) {
      logger.error('[SyncOptimization] File cache initialization failed:', error);
    }
  }

  async persistCache() {
    if (this.isRedisConnected) return; // No need to persist if using Redis

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
      if (this.isRedisConnected && this.redis) {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.cacheStats.hits++;
          logger.info(`[SyncOptimization] Valkey cache hit for user ${userId}`);
          return JSON.parse(cached);
        }
      } else {
        // In-memory fallback
        const cached = this.memoryCache.get(cacheKey);
        if (cached) {
          // Check if cache entry has expired
          if (!cached.expiresAt || cached.expiresAt > Date.now()) {
            this.cacheStats.hits++;
            logger.info(`[SyncOptimization] In-memory cache hit for user ${userId}`);
            return cached.data;
          } else {
            // Remove expired entry
            this.memoryCache.delete(cacheKey);
          }
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
      if (this.isRedisConnected && this.redis) {
        await this.redis.setEx(cacheKey, ttlSeconds, JSON.stringify(data));
        this.cacheStats.sets++;
        logger.info(`[SyncOptimization] Cached sync data in Valkey for user ${userId} (TTL: ${ttlSeconds}s)`);
      } else {
        // In-memory fallback with size limit
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
        logger.info(`[SyncOptimization] Cached sync data in memory for user ${userId} (TTL: ${ttlSeconds}s)`);
      }
    } catch (error) {
      logger.error('[SyncOptimization] Cache storage error:', error);
    }
  }

  /**
   * Acquire sync lock for user
   */
  async acquireSyncLock(userId, timeout = 5000) {
    const lockKey = `sync_lock:${userId}`;
    
    try {
      if (this.isRedisConnected && this.redis) {
        const acquired = await this.redis.set(lockKey, 'locked', 'PX', timeout, 'NX');
        if (acquired) {
          logger.debug(`[SyncOptimization] Acquired Valkey sync lock for user ${userId} (timeout: ${timeout}ms)`);
          return true;
        }
        return false;
      } else {
        // In-memory lock fallback
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
        
        logger.debug(`[SyncOptimization] Acquired in-memory sync lock for user ${userId} (timeout: ${timeout}ms)`);
        return true;
      }
    } catch (error) {
      logger.error('[SyncOptimization] Lock acquisition error:', error);
      return false;
    }
  }

  /**
   * Release sync lock
   */
  async releaseSyncLock(userId) {
    const lockKey = `sync_lock:${userId}`;
    
    try {
      if (this.isRedisConnected && this.redis) {
        await this.redis.del(lockKey);
        logger.debug(`[SyncOptimization] Released Valkey sync lock for user ${userId}`);
      } else {
        this.syncLocks.delete(userId);
        logger.debug(`[SyncOptimization] Released in-memory sync lock for user ${userId}`);
      }
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
      if (this.isRedisConnected && this.redis) {
        const lastActivity = await this.redis.get(activityKey);
        if (lastActivity && Date.now() - parseInt(lastActivity) < windowMs) {
          return true;
        }
        await this.redis.setEx(activityKey, 60, Date.now().toString());
      } else {
        // In-memory tracking
        const lastActivity = this.activityCache.get(activityKey);
        if (lastActivity && Date.now() - lastActivity < windowMs) {
          return true;
        }
        this.activityCache.set(activityKey, Date.now());
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
      if (this.isRedisConnected && this.redis) {
        const current = await this.redis.incr(rateLimitKey);
        if (current === 1) {
          await this.redis.expire(rateLimitKey, Math.ceil(windowMs / 1000));
        }
        return current > maxRequests;
      } else {
        // Simple in-memory rate limiting
        const now = Date.now();
        const requests = this.rateLimitCache.get(rateLimitKey) || [];
        const recentRequests = requests.filter(time => now - time < windowMs);
        
        if (recentRequests.length >= maxRequests) {
          return true;
        }
        
        recentRequests.push(now);
        this.rateLimitCache.set(rateLimitKey, recentRequests);
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
      if (this.isRedisConnected) {
        // Redis/Valkey TTL handles cleanup automatically
        return;
      }
      
      // Clean in-memory caches
      const now = Date.now();
      
      // Clean main cache
      for (const [key, value] of this.memoryCache.entries()) {
        if (value.expiresAt && now > value.expiresAt) {
          this.memoryCache.delete(key);
          this.cacheStats.deletes++;
        }
      }
      
      // Clean activity cache
      for (const [key, timestamp] of this.activityCache.entries()) {
        if (now - timestamp > 300000) { // 5 minutes
          this.activityCache.delete(key);
        }
      }
      
      // Clean rate limit cache
      for (const [key, requests] of this.rateLimitCache.entries()) {
        const recentRequests = requests.filter(time => now - time < 60000); // 1 minute
        if (recentRequests.length === 0) {
          this.rateLimitCache.delete(key);
        } else {
          this.rateLimitCache.set(key, recentRequests);
        }
      }
      
      // Clean locks
      for (const [userId, lockInfo] of this.syncLocks.entries()) {
        if (now > lockInfo.expiresAt) {
          this.syncLocks.delete(userId);
        }
      }
      
      logger.debug('[SyncOptimization] Completed in-memory cache cleanup');
    } catch (error) {
      logger.error('[SyncOptimization] Cleanup error:', error);
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      type: this.isRedisConnected ? 'valkey' : 'memory',
      connected: this.isRedisConnected,
      stats: this.cacheStats,
      cacheSize: this.isRedisConnected ? 'managed_by_valkey' : this.memoryCache.size,
      lockCount: this.syncLocks.size
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      
      if (this.persistInterval) {
        clearInterval(this.persistInterval);
      }
      
      // Final persistence for in-memory cache
      if (!this.isRedisConnected) {
        await this.persistCache();
      }
      
      // Close Redis connection
      if (this.redis && this.isRedisConnected) {
        await this.redis.quit();
        logger.info('[SyncOptimization] Valkey connection closed');
      }
      
      logger.info('[SyncOptimization] Shutdown completed');
    } catch (error) {
      logger.error('[SyncOptimization] Shutdown error:', error);
    }
  }
}

// Create singleton instance
const syncOptimization = new SyncOptimization();

// Graceful shutdown handling
process.on('SIGTERM', () => syncOptimization.shutdown());
process.on('SIGINT', () => syncOptimization.shutdown());

module.exports = syncOptimization; 