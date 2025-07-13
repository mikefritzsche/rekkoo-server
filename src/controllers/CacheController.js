// server/src/controllers/CacheController.js
import { redis } from '../utils/cache.js';

async function getStats(req, res) {
  try {
    // HITS & MISSES, MEMORY
    const info = await redis.info('stats');
    const memoryInfo = await redis.info('memory');

    res.type('text/plain').send(`${info}\n${memoryInfo}`);
  } catch (err) {
    console.error('Cache stats error:', err);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
}

async function listKeys(req, res) {
  try {
    const pattern = req.query.pattern || '*';
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

    let cursor = '0';
    const keys = [];
    while (keys.length < limit) {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      keys.push(...batch);
      if (nextCursor === '0') break;
      cursor = nextCursor;
    }

    const trimmed = keys.slice(0, limit);
    const withMem = await Promise.all(
      trimmed.map(async (k) => {
        const bytes = await redis.call('MEMORY', 'USAGE', k) || 0;
        return { key: k, bytes: Number(bytes) };
      })
    );

    res.json({ keys: withMem });
  } catch (err) {
    console.error('Cache list keys error', err);
    res.status(500).json({ error: 'Failed to list cache keys' });
  }
}

async function getKey(req, res) {
  try {
    const { key } = req.params;
    if (!key) return res.status(400).json({ error: 'Key required' });
    const val = await redis.get(key);
    if (val === null) return res.status(404).json({ error: 'Key not found' });
    res.json({ key, value: JSON.parse(val) });
  } catch (err) {
    console.error('Cache get key error', err);
    res.status(500).json({ error: 'Failed to get cache key' });
  }
}

async function deleteKey(req, res) {
  try {
    const { key } = req.params;
    await redis.del(key);
    res.json({deleted:true});
  } catch (err) {
    console.error('Cache delete key error', err);
    res.status(500).json({ error: 'Failed to delete key' });
  }
}

async function clearCache(req, res) {
  try {
    await redis.flushdb();
    res.json({ cleared: true });
  } catch (err) {
    console.error('Cache clear error', err);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
}

import { isCacheEnabled, setCacheEnabled } from '../utils/cache.js';

export const getCacheSettings = (req, res) =>
  res.json({ enabled: isCacheEnabled() });

export const updateCacheSettings = (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean')
    return res.status(400).json({ error: 'enabled must be boolean' });
  setCacheEnabled(enabled);
  res.json({ enabled });
};

export { getStats, listKeys, getKey, deleteKey, clearCache }; 