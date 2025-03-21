const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const axios = require('axios');

const API_KEY = process.env.GOOGLE_API_KEY_WEB;



router.post('/search/legacy', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({error: "Query is required"});

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${process.env.GOOGLE_API_KEY_WEB}`;
    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
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
  // let url = `https://places.googleapis.com/v1/places/${id}?key=${process.env.GOOGLE_API_KEY_WEB}`
  let url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&key=${process.env.GOOGLE_API_KEY_WEB}`
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
  // res.json({id, url})
  try {
    const response = await fetch(url);

    if (!response.ok) throw new Error(`Google Places Details API request failed ${JSON.stringify(response)}`);

    const data = await response.json();

    if (!data.result) throw new Error('No details found for this place');

    res.json(data)
  } catch (error) {
    console.error('Place details error:', error);
    // throw new Error('Failed to fetch place details');
    res.status(500).json({error});
  }
})

router.get('/details-new/:id', async (req, res) => {
  const {id} = req.params

  let url = `https://places.googleapis.com/v1/places/${id}`
  // let url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&key=${process.env.GOOGLE_API_KEY_WEB}`
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
        'X-Goog-Api-Key': process.env.GOOGLE_API_KEY_WEB,
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
  const { photoUri } = req.query;
  try {
    const { maxWidth, maxHeight } = req.query;

    // return res.json({photoUri, maxWidth, maxHeight});

    // Check if photoUri is provided
    if (!photoUri) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'photoUri query parameter is required'
      });
    }

    // Make request to the new Google Places API photo endpoint
    const response = await axios({
      method: 'GET',
      url: `https://places.googleapis.com/v1/${photoUri}/media`,
      params: {
        maxWidthPx: maxWidth || 4000,
        maxHeightPx: maxHeight,
        skipHttpRedirect: false
      },
      headers: {
        'X-Goog-Api-Key': process.env.GOOGLE_API_KEY_WEB,
        'Accept': 'image/*'
      },
      responseType: 'stream'
    });

    // Set appropriate content type
    res.set('Content-Type', response.headers['content-type']);

    // Pipe the image data directly to the response
    response.data.pipe(res);

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

    // Generic error handling
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
    const { photoReference } = req.query;
    const { maxWidth = 1000, maxHeight } = req.query;

    // Check if photoReference is provided
    if (!photoReference) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'photoReference query parameter is required'
      });
    }

    // Set up query parameters
    const params = {
      photoreference: photoReference,
      key: process.env.GOOGLE_API_KEY_WEB
    };

    // Add optional size parameters
    if (maxWidth) params.maxwidth = maxWidth;
    if (maxHeight) params.maxheight = maxHeight;

    // Fetch the photo from legacy Google Places API
    const response = await axios({
      method: 'GET',
      url: 'https://maps.googleapis.com/maps/api/place/photo',
      params,
      responseType: 'stream'
    });

    // Set appropriate content type
    res.set('Content-Type', response.headers['content-type']);

    // Pipe the image data directly to the response
    response.data.pipe(res);

  } catch (error) {
    console.error('Error fetching legacy place photo:', error);

    // Handle specific API errors
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: error.response.statusText,
        message: 'Failed to fetch place photo'
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

module.exports = router;