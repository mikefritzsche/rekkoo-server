const express = require('express');
const axios = require('axios');
const LRU = require('lru-cache');

const router = express.Router();

// Simple in-memory cache – keyed by lat,lng,radius rounded to 2 decimals
const cache = new LRU({ max: 500, ttl: 1000 * 60 * 30 }); // 30 min

/**
 * GET /v1.0/osm/nearby?lat=..&lng=..&radius=1000
 * Optional: type (amenity tag or comma-sep list)
 */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 1000, type } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat & lng required' });

    // Snap coordinates to 0.002 (~200 m) to maximise cache hits
    const latSnap = (+lat).toFixed(3);
    const lngSnap = (+lng).toFixed(3);
    const key = `${latSnap},${lngSnap},${radius},${type || 'all'}`;
    const cached = cache.get(key);
    if (cached) return res.json(cached);

    // Build Overpass QL
    const radiusNum = Math.min(Math.max(+radius, 1), 5000); // 5 km hard-cap
    const amenityFilter = type
      ? `[amenity~"^(${type.split(',').join('|')})$"]`
      : '[amenity]';

    const query = `
      [out:json][timeout:25];
      (
        node${amenityFilter}(around:${radiusNum},${lat},${lng});
        way${amenityFilter}(around:${radiusNum},${lat},${lng});
        relation${amenityFilter}(around:${radiusNum},${lat},${lng});
      );
      out center 50;
    `;

    const url = 'https://overpass-api.de/api/interpreter';
    const response = await axios.post(url, query, {
      headers: { 'Content-Type': 'text/plain' },
    });

    const elements = response.data?.elements || [];
    const results = elements.map((el) => {
      const id = `${el.type}/${el.id}`;
      const latVal = el.lat || el.center?.lat;
      const lngVal = el.lon || el.center?.lon;
      return {
        id,
        title: el.tags?.name || el.tags?.amenity || 'Unknown',
        latitude: latVal,
        longitude: lngVal,
        tags: el.tags || {},
      };
    });

    cache.set(key, results);
    res.json(results);
  } catch (e) {
    console.error('OSM nearby error', e?.response?.data || e);
    res.status(500).json({ error: 'OSM search failed' });
  }
});

module.exports = router; 