import Redis from 'ioredis';
import crypto from 'crypto';

// Fallback to localhost if VALKEY_URL not set (docker-compose injects one)
const redis = new Redis(process.env.VALKEY_URL || 'redis://valkey:6379');

/**
 * Create a deterministic key from any serialisable object.
 * prefix = "spotify", "tmdb", etc.
 */
function makeKey(prefix, payload) {
  const hash = crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
  return `${prefix}:${hash}`;
}

let cacheEnabled = true;
export const setCacheEnabled = (val) => (cacheEnabled = !!val);
export const isCacheEnabled = () => cacheEnabled;

/**
 * Cache-first wrapper
 * @param {String} prefix  logical namespace (e.g. "spotify")
 * @param {Object} payload axios config, params, anything serialisable
 * @param {Function} fn    async function that actually does the fetch
 * @param {Number} ttlSec  seconds to keep the response
 */
export async function cacheFetch(prefix, payload, fn, ttlSec = 3600) {
  if (!cacheEnabled) return fn();          // bypass
  const key = makeKey(prefix, payload);

  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const fresh = await fn();          // let errors propagate – we only cache good calls
  await redis.set(key, JSON.stringify(fresh), 'EX', ttlSec);
  return fresh;
}

export { redis };
