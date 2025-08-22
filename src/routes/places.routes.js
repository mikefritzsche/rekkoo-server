const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const axios = require('axios');
const LRU = require('lru-cache');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_KEY = process.env.GOOGLE_PLACES_KEY;
console.log(`GOOGLE+PLACES_API_KEY: `, API_KEY)
// Simple in-memory cache – 500 images, 7-day TTL
const photoCache = new LRU({
  max: 500,
  ttl: 1000 * 60 * 60 * 24 * 7 // 1 week
});

// Disk cache root
const PHOTO_CACHE_DIR = process.env.PHOTO_CACHE_DIR || path.join(__dirname, '../../photo-cache');
if (!fs.existsSync(PHOTO_CACHE_DIR)) {
  fs.mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
}

/**
 * Generates a file path on disk for a given cache key and mime type.
 */
function getCachedFilePath(cacheKey, mime = 'image/jpeg') {
  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex');
  const ext = mime.includes('png') ? 'png' : 'jpg';
  return path.join(PHOTO_CACHE_DIR, `${hash}.${ext}`);
}

/**
 * Attempts to read a cached image from disk.
 */
function readFromDisk(cacheKey) {
  const possibleExtensions = ['jpg', 'jpeg', 'png'];
  for (const ext of possibleExtensions) {
    const p = path.join(PHOTO_CACHE_DIR, `${crypto.createHash('sha1').update(cacheKey).digest('hex')}.${ext}`);
    if (fs.existsSync(p)) {
      try {
        const buffer = fs.readFileSync(p);
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
        return { buffer, mime };
      } catch (e) {
        console.warn('Failed to read cached image from disk', e);
      }
    }
  }
  return null;
}

/**
 * Writes image buffer to disk cache.
 */
function writeToDisk(cacheKey, buffer, mime) {
  try {
    const filePath = getCachedFilePath(cacheKey, mime);
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    console.warn('Failed to write image to disk cache', e);
  }
}

// --- Field Mapping Configuration ---
// Keys are the exact API response field names.
// Values are objects:
//   - target: The dot-notation path in the processed object.
//   - transform: (Optional) A function that takes the API value
//                and the partially processed target object, then returns
//                the value to be stored. If omitted, direct assignment is used.
//                **Important**: If a transform needs to set MULTIPLE target properties
//                (like geometry -> location + viewport), it should modify the
//                `targetObject` directly and potentially return a special value
//                (like `undefined`) to signal the main loop not to perform assignment.

const placesFieldMappings = {
  // Basic Info
  'place_id': { target: 'placeId' },
  'name': { target: 'name' },
  'formatted_address': { target: 'address' },
  'address_components': { target: 'addressComponents' },
  'adr_address': { target: 'adrAddress' },
  'business_status': { target: 'businessStatus' },
  'types': { target: 'types', transform: (val) => Array.isArray(val) ? val : [] },
  'vicinity': { target: 'vicinity' },

  // Location (Complex Transform)
  'geometry': {
    transform: (value, targetObject) => {
      if (!value) return; // Do nothing if geometry is missing

      // Location
      if (value.location) {
        let loc = null;
        if (typeof value.location.lat === 'function' && typeof value.location.lng === 'function') {
          loc = { lat: value.location.lat(), lng: value.location.lng() }; // JS API
        } else if (typeof value.location.lat === 'number' && typeof value.location.lng === 'number') {
          loc = { lat: value.location.lat, lng: value.location.lng }; // Web Service API
        }
        setPropertyByPath(targetObject, 'location', loc);
      }

      // Viewport
      if (value.viewport) {
        setPropertyByPath(targetObject, 'viewport', value.viewport);
      }
      // Signal that assignment was handled internally
      return undefined;
    }
  },

  // Contact & URLs
  'formatted_phone_number': { target: 'phoneNumber' },
  'international_phone_number': { target: 'internationalPhoneNumber' },
  'website': { target: 'website' },
  'url': { target: 'googleMapsUrl' }, // Renamed

  // Atmosphere & Details
  'rating': { target: 'rating', transform: (val) => typeof val === 'number' ? val : null },
  'user_ratings_total': { target: 'userRatingsTotal', transform: (val) => typeof val === 'number' ? val : null },
  'price_level': { target: 'priceLevel', transform: (val) => typeof val === 'number' ? val : null },
  'utc_offset_minutes': { target: 'utcOffsetMinutes' },
  'utc_offset': { // Handle deprecated field as fallback ONLY if minutes isn't set
    transform: (value, targetObject) => {
      // Check if utcOffsetMinutes was already set by 'utc_offset_minutes' key
      if (targetObject.utcOffsetMinutes === undefined || targetObject.utcOffsetMinutes === null) {
        setPropertyByPath(targetObject, 'utcOffsetMinutes', typeof value === 'number' ? value : null);
      }
      return undefined; // Signal assignment handled
    }
  },


  // Opening Hours (Grouped)
  'current_opening_hours': { target: 'hours.current' },
  'opening_hours': { target: 'hours.regular' }, // Legacy/simpler
  'secondary_opening_hours': { target: 'hours.secondary' },

  // Photos & Reviews
  'photos': {
    target: 'photos',
    transform: (value) => Array.isArray(value) ? value.map(photo => ({
      reference: photo.photo_reference || null,
      height: photo.height || null,
      width: photo.width || null,
      htmlAttributions: photo.html_attributions || []
    })) : []
  },
  'reviews': {
    target: 'reviews',
    transform: (val) => Array.isArray(val) ? val : []
  },

  // Icon
  'icon': { target: 'iconUrl' },
  'icon_background_color': { target: 'iconBackgroundColor' },
  'icon_mask_base_uri': { target: 'iconMaskBaseUri' },

  // Plus Code
  'plus_code': {
    transform: (value, targetObject) => {
      if (value) {
        setPropertyByPath(targetObject, 'plusCode.globalCode', value.global_code || null);
        setPropertyByPath(targetObject, 'plusCode.compoundCode', value.compound_code || null);
      } else {
        setPropertyByPath(targetObject, 'plusCode.globalCode', null);
        setPropertyByPath(targetObject, 'plusCode.compoundCode', null);
      }
      return undefined; // Signal assignment handled
    }
  },

  // Attributes / Capabilities (Grouped)
  'curbside_pickup': { target: 'attributes.curbsidePickup', transform: (val) => typeof val === 'boolean' ? val : null },
  'delivery': { target: 'attributes.delivery', transform: (val) => typeof val === 'boolean' ? val : null },
  'dine_in': { target: 'attributes.dineIn', transform: (val) => typeof val === 'boolean' ? val : null },
  'editorial_summary': { target: 'attributes.editorialSummary' },
  'reservable': { target: 'attributes.reservable', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_beer': { target: 'attributes.servesBeer', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_breakfast': { target: 'attributes.servesBreakfast', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_brunch': { target: 'attributes.servesBrunch', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_dinner': { target: 'attributes.servesDinner', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_lunch': { target: 'attributes.servesLunch', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_vegetarian_food': { target: 'attributes.servesVegetarianFood', transform: (val) => typeof val === 'boolean' ? val : null },
  'serves_wine': { target: 'attributes.servesWine', transform: (val) => typeof val === 'boolean' ? val : null },
  'takeout': { target: 'attributes.takeout', transform: (val) => typeof val === 'boolean' ? val : null },
  'wheelchair_accessible_entrance': { target: 'attributes.wheelchairAccessibleEntrance', transform: (val) => typeof val === 'boolean' ? val : null },

  // --- Ignored Fields (No mapping needed) ---
  'reference': null, // Deprecated
  'scope': null,     // Usually 'GOOGLE'
};

router.post('/search/legacy', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({error: "Query is required"});

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    const processedResults = data.results
    .map(placeResult => parsePlaceDataWithMapping(placeResult, placesFieldMappings)) // Apply parser to each item
    .filter(processedPlace => processedPlace !== null); // Filter out any results that failed parsing (optional)

    res.json({...data, processedResults});
  } catch (error) {
    console.error('Error fetching places:', error);
    res.status(500).json({error: 'Internal Server Error'});
  }
});

/**
 * @route   POST /api/places/search
 * @desc    Search for places using the new Places API
 * @access  Public
 */
router.post('/search', async (req, res) => {
  try {
    const {
      textQuery,
      locationBias,
      includedTypes,
      maxResultCount,
      languageCode
    } = req.body;

    // Verify required parameters
    if (!textQuery) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'textQuery is required'
      });
    }

    // Construct request body
    const requestBody = {
      textQuery,
      languageCode: languageCode || 'en',
      maxResultCount: maxResultCount || 2
    };

    // Add optional parameters if they exist
    if (locationBias) requestBody.locationBias = locationBias;
    if (includedTypes) requestBody.includedTypes = includedTypes;

    // Make request to the new Google Places API search
    const response = await axios.post('https://places.googleapis.com/v1/places:searchText',
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'places.*'
        }
      }
    );

    // Return the search results
    return res.json({
      success: true,
      data: response.data
    });
  } catch (error) {
    console.error('Error searching places:', error);

    // Handle specific API errors
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: error.response.statusText,
        message: error.response.data?.error?.message || 'Failed to search places',
        code: error.response.data?.error?.code
      });
    }

    // Generic error handling
    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: error.message
    });
  }
});

router.get('/detail/:id', async (req, res) => {
  const {id} = req.params
  
  let url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&key=${API_KEY}`
  const fields = [
    'website',
    'formatted_phone_number',
    'current_opening_hours',
    'editorial_summary',
    'reservable',
    'serves_beer',
    'serves_breakfast',
    'serves_brunch',
    'serves_dinner',
    'serves_lunch',
    'serves_vegetarian_food',
    'serves_wine',
    'takeout',
    'url',
    'price_level',
    'rating',
    'user_ratings_total'
  ]
  url = `${url}&fields=${fields.join(',')}`
  // res.json({id, url})

  try {
    const response = await fetch(url);

    if (!response.ok) throw new Error(`Google Places Details API request failed ${JSON.stringify(response)}`);

    const data = await response.json();

    if (!data.result) throw new Error('No details found for this place');

    const parsedPlace = parsePlaceDataWithMapping(data.result, placesFieldMappings)
    res.json({...data, parsedPlace})
  } catch (error) {
    console.error('Place details error:', error);
    // throw new Error('Failed to fetch place details');
    res.status(500).json({error});
  }
})

router.get('/details-new/:id', async (req, res) => {
  const {id} = req.params

  let url = `https://places.googleapis.com/v1/places/${id}`
  
  const fields = [
    'website',
    'formatted_phone_number',
    'current_opening_hours',
    'editorial_summary',
    'reservable',
    'serves_beer',
    'serves_breakfast',
    'serves_brunch',
    'serves_dinner',
    'serves_lunch',
    'serves_vegetarian_food',
    'serves_wine',
    'takeout',
    'url',
  ]

  // url = `${url}&fields=${fields.join(',')}`

  console.log(`place detail url: `, url)
  const fieldsNew = req.query.fields || [
    'addressComponents',
    'businessStatus',
    'displayName',
    'formattedAddress',
    'googleMapsUri',
    'internationalPhoneNumber',
    'location',
    'photos',
    'rating',
    'userRatingCount',
    'priceLevel',
    'primaryType',
    'websiteUri',
    'regularOpeningHours',
    'primaryTypeDisplayName'
  ].join(',');
  // res.json({id, url})
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': fieldsNew
      }
    });

    // if (!response.ok) throw new Error(`Google Places Details API request failed ${JSON.stringify(response)}`);

    const data = await response.json();

    // if (!data.result) throw new Error('No details found for this place');
    console.log(`place detail: `, data)
    res.json(data)
  } catch (error) {
    console.error('Place details error:', error);
    // throw new Error('Failed to fetch place details');
    res.status(500).json({error});
  }
})

/**
 * @route   GET /api/places/photo
 * @desc    Proxy for fetching place photos from Places API v1 without exposing API key
 * @access  Public
 */
router.get('/photo', async (req, res) => {
  const { photoUri, maxWidth = 4000, maxHeight } = req.query;

  try {
    // --- Validate input ---
    if (!photoUri) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'photoUri query parameter is required'
      });
    }

    // --- Try cache first ---
    const cacheKey = `${photoUri}|${maxWidth}|${maxHeight}`;
    const cachedMemory = photoCache.get(cacheKey);
    if (cachedMemory) {
      res.set('Content-Type', cachedMemory.mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(cachedMemory.buffer);
    }

    const cachedDisk = readFromDisk(cacheKey);
    if (cachedDisk) {
      photoCache.set(cacheKey, cachedDisk);
      res.set('Content-Type', cachedDisk.mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(cachedDisk.buffer);
    }

    // --- Fetch from Google once ---
    const response = await axios({
      method: 'GET',
      url: `https://places.googleapis.com/v1/${photoUri}/media`,
      params: {
        maxWidthPx: maxWidth,
        maxHeightPx: maxHeight,
        skipHttpRedirect: false
      },
      headers: {
        'X-Goog-Api-Key': API_KEY,
        Accept: 'image/*'
      },
      responseType: 'arraybuffer'
    });

    const mime = response.headers['content-type'] || 'image/jpeg';
    const buffer = Buffer.from(response.data, 'binary');

    // Cache and respond
    photoCache.set(cacheKey, { buffer, mime });
    writeToDisk(cacheKey, buffer, mime);
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(buffer);

  } catch (error) {
    console.error('Error fetching place photo:', error);
    // Handle specific API errors
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: error.response.statusText,
        message: error.response.data?.error?.message || 'Failed to fetch place photo',
        code: error.response.data?.error?.code,
        photoUri
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: error.message
    });
  }
});

/**
 * @route   GET /api/places/photo/legacy
 * @desc    Proxy for fetching place photos from the legacy Places API without exposing API key
 * @access  Public
 */
router.get('/photo/legacy', async (req, res) => {
  try {
    const { photoReference, maxWidth = 1000, maxHeight } = req.query;

    if (!photoReference) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'photoReference query parameter is required'
      });
    }

    // --- Try cache first ---
    const cacheKey = `${photoReference}|${maxWidth}|${maxHeight}`;
    const cachedMemory = photoCache.get(cacheKey);
    if (cachedMemory) {
      res.set('Content-Type', cachedMemory.mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(cachedMemory.buffer);
    }

    const cachedDisk = readFromDisk(cacheKey);
    if (cachedDisk) {
      photoCache.set(cacheKey, cachedDisk);
      res.set('Content-Type', cachedDisk.mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(cachedDisk.buffer);
    }

    // Set up query parameters
    const params = {
      photoreference: photoReference,
      key: API_KEY,
      maxwidth: maxWidth,
      ...(maxHeight ? { maxheight: maxHeight } : {})
    };

    // Fetch the photo from legacy Google Places API
    const response = await axios({
      method: 'GET',
      url: 'https://maps.googleapis.com/maps/api/place/photo',
      params,
      responseType: 'arraybuffer'
    });

    const mime = response.headers['content-type'] || 'image/jpeg';
    const buffer = Buffer.from(response.data, 'binary');

    // Cache & respond
    photoCache.set(cacheKey, { buffer, mime });
    writeToDisk(cacheKey, buffer, mime);
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(buffer);

  } catch (error) {
    console.error('Error fetching legacy place photo:', error);

    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: error.response.statusText,
        message: 'Failed to fetch place photo'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: error.message
    });
  }
});

router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 2000 } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng query parameters are required' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&key=${API_KEY}`;
    const response = await axios.get(url);
    return res.json(response.data.results || []);
  } catch (error) {
    console.error('Nearby places error:', error?.response?.data || error);
    return res.status(500).json({ error: 'Failed to fetch nearby places' });
  }
});

/**
 * Sets a value on an object using a dot-notation path.
 * Creates intermediate objects if they don't exist.
 *
 * @param {object} obj The object to modify.
 * @param {string} path The dot-notation path (e.g., "a.b.c").
 * @param {*} value The value to set.
 */
function setPropertyByPath(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {}; // Create intermediate object
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}
/**
 * Parses a single place object from the Google Places API using a field mapping config.
 * Assumes ALL possible fields might have been requested.
 *
 * @param {object} placeData The place object from the API response.
 * @param {object} mappings The field mapping configuration object.
 * @returns {object|null} A structured object containing the extracted place information, or null if input is invalid.
 */
function parsePlaceDataWithMapping(placeData, mappings) {
  // --- Basic Validation ---
  if (!placeData || typeof placeData !== 'object') {
    console.error("Invalid input: placeData must be an object.");
    return null;
  }

  // --- Initialize structure with defaults (based on target structure) ---
  // It's helpful to define the ideal empty structure first
  const processedPlace = {
    placeId: null,
    name: null,
    address: null,
    addressComponents: null,
    adrAddress: null,
    businessStatus: null,
    location: null,
    viewport: null,
    iconUrl: null,
    iconBackgroundColor: null,
    iconMaskBaseUri: null,
    phoneNumber: null,
    internationalPhoneNumber: null,
    website: null,
    googleMapsUrl: null,
    types: [],
    rating: null,
    userRatingsTotal: null,
    priceLevel: null,
    utcOffsetMinutes: null,
    hours: {
      current: null,
      regular: null,
      secondary: null
    },
    photos: [],
    reviews: [],
    plusCode: { globalCode: null, compoundCode: null },
    attributes: {
      curbsidePickup: null, delivery: null, dineIn: null, editorialSummary: null, reservable: null,
      servesBeer: null, servesBreakfast: null, servesBrunch: null, servesDinner: null, servesLunch: null,
      servesVegetarianFood: null, servesWine: null, takeout: null, wheelchairAccessibleEntrance: null
    },
    vicinity: null,
    otherData: {} // Catch-all for unmapped fields
  };

  if (!placeData.place_id) {
    console.warn("Received place data object without a place_id:", placeData);
    // return null; // Optional: fail if no place_id
  }

  // --- Iterate through ALL keys in the response object ---
  for (const apiKey in placeData) {
    if (Object.prototype.hasOwnProperty.call(placeData, apiKey)) {
      const apiValue = placeData[apiKey];
      const mappingConfig = mappings[apiKey];

      if (mappingConfig === null) {
        // Explicitly ignore this field (like 'reference', 'scope')
        continue;
      }

      if (mappingConfig) {
        let valueToSet = apiValue; // Default to direct assignment

        // Apply transformation if defined
        if (typeof mappingConfig.transform === 'function') {
          valueToSet = mappingConfig.transform(apiValue, processedPlace);
        }

        // Set the value if the transform didn't handle it internally (returned non-undefined)
        // and if a target path is defined
        if (valueToSet !== undefined && mappingConfig.target) {
          setPropertyByPath(processedPlace, mappingConfig.target, valueToSet);
        }
        // If valueToSet is undefined, it means the transform function handled the assignment.
        // If mappingConfig.target is missing, it implies the transform handles assignment (like 'geometry')
      } else {
        // --- Add any fields not found in the mapping to 'otherData' ---
        console.warn(`Unhandled API key "${apiKey}" found in place data.`);
        processedPlace.otherData[apiKey] = apiValue;
      }
    }
  }

  // --- Post-processing / Fallbacks (Optional) ---
  // Example: Use vicinity as address if formatted_address is missing
  if (!processedPlace.address && processedPlace.vicinity) {
    processedPlace.address = processedPlace.vicinity;
  }

  // Log if any unexpected data was found
  if (Object.keys(processedPlace.otherData).length > 0) {
    console.warn(`Place ${processedPlace.placeId || '(no id)'}: Contains unhandled fields in 'otherData':`, processedPlace.otherData);
  }


  return processedPlace;
}

module.exports = router;