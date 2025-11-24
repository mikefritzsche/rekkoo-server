const fetch = require('node-fetch');
const { cacheFetch, redis } = require('../utils/cache');

// TMDB configuration
const TMDB_CONFIG = {
  apiKey: process.env.TMDB_API_KEY,
  baseUrl: 'https://api.themoviedb.org/3'
};

// Rate limiting configuration
const RATE_LIMITS = {
  // TMDB allows ~40 requests per 10 seconds
  requestsPer10Seconds: 40,
  windowMs: 10000, // 10 seconds
  retryDelay: 250 // Base delay between requests
};

// Simple in-memory rate limiter for concurrent requests
const requestQueue = [];
let lastRequestTime = 0;

/**
 * Rate limiting wrapper for TMDB requests
 */
async function rateLimitedFetch(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  // Calculate minimum delay needed
  const minDelay = RATE_LIMITS.windowMs / RATE_LIMITS.requestsPer10Seconds;
  const delay = Math.max(0, minDelay - timeSinceLastRequest);

  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
  return fetch(url);
}

/**
 * Factory function that creates a TMDBController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with TMDB API methods
 */
function tmdbControllerFactory(socketService = null, db = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  // Lazy-load db pool to avoid circular imports when not provided
  const pool = db || require('../config/db');

  async function getConfiguration(req, res) {
    try {
      const cacheKey = {
        type: 'configuration'
      };

      const data = await cacheFetch('tmdb', cacheKey, async () => {
        const response = await rateLimitedFetch(`${TMDB_CONFIG.baseUrl}/configuration?api_key=${TMDB_CONFIG.apiKey}`);

        if (!response.ok) {
          throw new Error(`TMDB API error: ${response.status}`);
        }

        return await response.json();
      }, 30 * 24 * 60 * 60); // Cache for 30 days (configuration rarely changes)

      res.json({...data});
    } catch (error) {
      res.status(500).json({error});
    }
  }

  /**
   * Utility function for movie search with caching
   */
  async function searchSingleMovie(query, page = 1, include_adult = false) {
    const cacheKey = {
      query,
      page,
      include_adult,
      type: 'search'
    };

    return cacheFetch('tmdb', cacheKey, async () => {
      const searchUrl = `${TMDB_CONFIG.baseUrl}/search/multi?api_key=${TMDB_CONFIG.apiKey}&query=${encodeURIComponent(query)}&page=${page}&include_adult=${include_adult}`;

      const response = await rateLimitedFetch(searchUrl);

      if (!response.ok) {
        throw new Error(`TMDB API error: ${response.status}`);
      }

      return await response.json();
    }, 24 * 60 * 60); // Cache for 24 hours
  }

  /**
   * Search for movies and TV shows
   */
  const searchMedia = async (req, res) => {
    try {
      // Input validation
      const { query, page, include_adult } = req.query;

      // Search for all movies
      const searchResults = await searchSingleMovie(query, page, include_adult);

      /* Persist search embedding for personalization */
      const { safeStoreSearchEmbedding } = require('../utils/searchEmbeddingUtils');
      await safeStoreSearchEmbedding(req, query);

      res.json(searchResults);
    } catch (error) {
      console.error('media search error:', error);
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };

  /**
   * Get movie or TV show details with caching
   */
  const getMediaDetails = async (req, res) => {
    const { mediaType, id } = req.params;
    console.log('getMediaDetails mediaType', mediaType);

    // Guard: if the requested id belongs to a gift item, skip TMDB lookups
    try {
      const { rows } = await pool.query(
        `SELECT li.id, li.api_source, l.list_type
           FROM public.list_items li
           JOIN public.lists l ON l.id = li.list_id
          WHERE li.item_id_from_api = $1
          LIMIT 1`,
        [id]
      );
      if (rows.length) {
        const row = rows[0];
        const isGift = (row.api_source && row.api_source.toLowerCase() === 'gift') ||
                       (row.list_type && row.list_type.toLowerCase() === 'gifts') ||
                       Boolean(row.id);
        if (isGift) {
          return res.status(404).json({ error: 'No media details for gift items' });
        }
      }
    } catch (guardErr) {
      console.error('getMediaDetails guard failed:', guardErr);
      // continue to TMDB lookup rather than fail hard
    }

    const appendToResponseString = 'append_to_response';
    // Include watch provider availability in the same request
    const appendToResponse = 'recommendations,similar,videos,external_ids,images,credits,watch/providers';
    const searchUrl = `${TMDB_CONFIG.baseUrl}/${mediaType}/${id}?api_key=${TMDB_CONFIG.apiKey}&language=en-US&${appendToResponseString}=${appendToResponse}`;
    console.log('searchUrl', searchUrl);

    try {
      const cacheKey = {
        mediaType,
        id,
        appendToResponse,
        type: 'details'
      };

      const data = await cacheFetch('tmdb', cacheKey, async () => {
        const response = await rateLimitedFetch(searchUrl);

        if (!response.ok) {
          throw new Error(`TMDB API error: ${response.status}`);
        }

        return await response.json();
      }, 7 * 24 * 60 * 60); // Cache for 7 days (details change less frequently)

      res.json({...data});
    } catch (error) {
      res.status(500).json({error, searchUrl});
    }
  };

  /**
   * Search for multiple movies at once
   */
  const searchMultipleMedia = async (req, res) => {
    try {
      // Input validation
      const { titles } = req.body;
      if (!Array.isArray(titles) || titles.length === 0) {
        return res.status(400).json({
          error: 'Please provide an array of movie titles'
        });
      }

      if (titles.length > 10) {
        return res.status(400).json({
          error: 'Maximum 10 titles per request'
        });
      }

      // Search for all movies
      const searchResults = await Promise.allSettled(
        titles.map(title => searchSingleMovie(title))
      );

      // Process results
      const formattedResults = {
        successful: {},
        failed: {}
      };

      searchResults.forEach((result, index) => {
        const title = titles[index];
        if (result.status === 'fulfilled') {
          formattedResults.successful[title] = result.value;
        } else {
          formattedResults.failed[title] = result.reason.message;
        }
      });

      res.json(formattedResults);
    } catch (error) {
      console.error('TMDB search error:', error);
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };

  /**
   * Clear TMDB cache entries
   */
  async function clearTMDBCache(req, res) {
    try {
      const pattern = 'tmdb:*';
      let cursor = '0';
      let deletedCount = 0;

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        if (keys.length > 0) {
          deletedCount += await redis.del(...keys);
        }
        cursor = nextCursor;
      } while (cursor !== '0');

      res.json({
        success: true,
        deletedKeys: deletedCount,
        message: `Cleared ${deletedCount} TMDB cache entries`
      });
    } catch (error) {
      console.error('Error clearing TMDB cache:', error);
      res.status(500).json({ error: 'Failed to clear TMDB cache' });
    }
  }

  /**
   * Get TMDB cache statistics
   */
  async function getTMDBCacheStats(req, res) {
    try {
      const pattern = 'tmdb:*';
      let cursor = '0';
      const cacheKeys = [];
      let totalMemory = 0;

      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cacheKeys.push(...keys);
        cursor = nextCursor;
      } while (cursor !== '0');

      // Get memory usage for each key
      const keyInfo = await Promise.all(
        cacheKeys.map(async (key) => {
          const memory = await redis.call('MEMORY', 'USAGE', key) || 0;
          const ttl = await redis.ttl(key);
          totalMemory += memory;
          return { key, memory: Number(memory), ttl };
        })
      );

      // Group by type
      const byType = keyInfo.reduce((acc, { key, memory, ttl }) => {
        const type = key.split(':')[1] || 'unknown';
        if (!acc[type]) {
          acc[type] = { count: 0, memory: 0, keys: [] };
        }
        acc[type].count++;
        acc[type].memory += memory;
        acc[type].keys.push({ key, memory, ttl });
        return acc;
      }, {});

      res.json({
        totalKeys: cacheKeys.length,
        totalMemory,
        byType,
        cacheHitRate: 'Cache stats available via /cache/stats endpoint'
      });
    } catch (error) {
      console.error('Error getting TMDB cache stats:', error);
      res.status(500).json({ error: 'Failed to get TMDB cache stats' });
    }
  }

  // Return all controller methods
  return {
    getConfiguration,
    searchMedia,
    getMediaDetails,
    searchMultipleMedia,
    clearTMDBCache,
    getTMDBCacheStats
  };
}

module.exports = tmdbControllerFactory; 
