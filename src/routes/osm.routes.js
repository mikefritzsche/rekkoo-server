const express = require('express');
const axios = require('axios');
const LRU = require('lru-cache');

const router = express.Router();

// Simple in-memory cache (30 min)
const cache = new LRU({ max: 500, ttl: 1000 * 60 * 30 });

/**
 * GET /v1.0/osm/nearby?lat=..&lng=..&radius=1000[&type=restaurant,cafe]
 */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 1000, type } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    // Cache key rounds coords to 3 decimals (~100 m) to increase hits
    const key = `${(+lat).toFixed(3)},${(+lng).toFixed(3)},${radius},${type || 'all'}`;
    const cached = cache.get(key);
    if (cached) return res.json(cached);

    const radiusNum = Math.min(Math.max(+radius, 10), 5000);
    const amenityFilter = type ? `[amenity~"^(${type.split(',').join('|')})$"]` : '[amenity]';

    const query = `
      [out:json][timeout:25];
      (
        node${amenityFilter}(around:${radiusNum},${lat},${lng});
        way${amenityFilter}(around:${radiusNum},${lat},${lng});
        relation${amenityFilter}(around:${radiusNum},${lat},${lng});
      );
      out center 50;
    `;

    const overpassUrl = 'https://overpass-api.de/api/interpreter';
    const response = await axios.post(overpassUrl, query, {
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'rekkoo-app/1.0' },
    });

    const results = (response.data?.elements || []).map((el) => {
      const id = `${el.type}/${el.id}`;
      const latVal = el.lat ?? el.center?.lat;
      const lonVal = el.lon ?? el.center?.lon;
      return {
        id,
        title: el.tags?.name || el.tags?.amenity || 'Unknown',
        latitude: latVal,
        longitude: lonVal,
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

router.get('/search', async (req, res) => {
  try {
    const { q, limit = 15, lat, lng } = req.query;
    if (!q) return res.status(400).json({ error: 'q query param required' });

    const key = `search:${q}:${limit}:${lat || 'none'}:${lng || 'none'}`;
    const cached = cache.get(key);
    if (cached) return res.json(cached);

    // Base Nominatim search URL
    let url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&extratags=1&limit=${limit}&q=${encodeURIComponent(q)}`;

    // If lat & lng provided, bias the search within a ~10 km square viewbox
    if (lat && lng && !Number.isNaN(+lat) && !Number.isNaN(+lng)) {
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      // ~10 km bbox (approx 0.09° lat/lng)
      const DELTA = 0.09;
      const left = lngNum - DELTA;
      const right = lngNum + DELTA;
      const top = latNum + DELTA;
      const bottom = latNum - DELTA;
      url += `&viewbox=${left},${top},${right},${bottom}&bounded=1`;
    }

    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'rekkoo-app/1.0' },
    });

    const data = resp.data.map((el) => ({
      id: `${el.osm_type}/${el.osm_id}`,
      title: el.display_name.split(',')[0],
      latitude: parseFloat(el.lat),
      longitude: parseFloat(el.lon),
      address: el.address,
      extratags: el.extratags,
    }));

    cache.set(key, data);
    res.json(data);
  } catch (e) {
    console.error('OSM search error', e?.response?.data || e);
    res.status(500).json({ error: 'OSM search failed' });
  }
});

module.exports = router; 