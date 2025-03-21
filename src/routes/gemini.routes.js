const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config();

// Your Gemini API key should be stored in an environment variable
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent';

// Middleware to validate request body
const validateRequestBody = (req, res, next) => {
  const { listType, title } = req.body;

  if (!listType) {
    return res.status(400).json({
      error: 'Missing required parameter',
      message: 'listType is required'
    });
  }

  if (!title) {
    return res.status(400).json({
      error: 'Missing required parameter',
      message: 'title is required'
    });
  }

  // If mediaType is provided, validate it has a valid value
  if (req.body.mediaType && !['movie', 'tv'].includes(req.body.mediaType)) {
    return res.status(400).json({
      error: 'Invalid parameter value',
      message: 'mediaType must be either "movie" or "tv"'
    });
  }

  next();
};

/**
 * Route to get suggestions similar to a specified title
 * @route POST /
 * @param {Object} req.body - Request body
 * @param {string} req.body.listType - Type of list (books, movies, music, etc.)
 * @param {string} req.body.title - Title to find similar suggestions for
 * @param {string} [req.body.year] - Optional year of the title
 * @param {string} [req.body.mediaType] - Optional parameter to specify 'movie' or 'tv' when listType is 'movies'
 * @param {number} [req.body.page=1] - Page number for pagination, starting at 1
 * @returns {Object} 200 - A JSON string with suggestions
 */
router.post('/', async (req, res) => {
// router.post('/', validateRequestBody, async (req, res) => {
  try {
    // Get parameters from request body
    const {
      listType,
      title,
      year,
      mediaType,
      page = 1 // Default to page 1 if not specified
    } = req.body;

    // Define content type specific fields
    const contentTypes = {
      "books": {
        itemName: "book",
        fields: [
          { name: "title", example: "Book Title" },
          { name: "author", example: "Author Name" }
        ]
      },
      "movies": {
        itemName: "movie or TV show",
        fields: [
          { name: "title", example: "Movie/Show Title" },
          { name: "creator", example: "Director/Creator" },
          { name: "year", example: "Release/First Aired Year" },
          { name: "type", example: "Movie or TV Show" }
        ],
        // Define subtypes for movies list type
        subtypes: {
          "movie": {
            itemName: "movie",
            promptText: "movie suggestions (not TV shows)"
          },
          "tv": {
            itemName: "TV show",
            promptText: "TV show suggestions (not movies)"
          }
        }
      },
      "music": {
        itemName: "music",
        fields: [
          { name: "title", example: "Album/Artist Name" },
          { name: "artist", example: "Artist/Band Name" }
        ]
      },
      "places": {
        itemName: "place",
        fields: [
          { name: "name", example: "Place Name" },
          { name: "location", example: "City, Country" },
          { name: "type", example: "Beach/Mountain/City/etc." }
        ]
      },
      "gifts": {
        itemName: "gift",
        fields: [
          { name: "item", example: "Gift Name" },
          { name: "category", example: "Type of Gift" },
          { name: "priceRange", example: "Approximate Price Range" }
        ]
      }
    };

    // Get content type configuration or use default
    const contentConfig = contentTypes[listType] || {
      itemName: listType,
      fields: [
        { name: "title", example: "Title" },
        { name: "creator", example: "Creator Name" }
      ]
    };

    // Helper function to get ordinal suffix (1st, 2nd, 3rd, etc.)
    const getOrdinal = (n) => {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    // Calculate the suggestion range for this page
    const startNum = (page - 1) * 5 + 1;
    const endNum = page * 5;

    // Create pagination text for the prompt
    const paginationText = page > 1
      ? `This is page ${page} of results. Provide the ${getOrdinal(startNum)} through ${getOrdinal(endNum)} most relevant suggestions. These should be completely different from suggestions that would appear on earlier pages.`
      : '';

    // Determine the appropriate reason text based on list type
    let reasonText;
    if (listType === "places") {
      reasonText = `Why this place would appeal to someone who likes ${title}`;
    } else if (listType === "gifts") {
      reasonText = `Why this would be a good gift for someone who likes ${title}`;
    } else {
      reasonText = `Brief reason why this is similar to ${title}`;
    }

    // Build JSON structure for the prompt
    const jsonStructure = contentConfig.fields.reduce((obj, field) => {
      obj[field.name] = field.example;
      return obj;
    }, { reason: reasonText });

    // Customize prompt intro based on content type
    let promptIntro;
    if (listType === "places") {
      promptIntro = `Please provide five place recommendations for someone who likes "${title}"${year ? ` (${year})` : ''}.`;
    } else if (listType === "gifts") {
      promptIntro = `Please suggest five gift ideas for someone who likes "${title}"${year ? ` (${year})` : ''}.`;
    } else if (listType === "movies") {
      // For movies list type, check if we should specifically recommend movies or TV shows
      if (mediaType && contentTypes.movies.subtypes[mediaType]) {
        const subtype = contentTypes.movies.subtypes[mediaType];
        promptIntro = `Please provide five ${subtype.promptText} that are similar to "${title}"${year ? ` (${year})` : ''}.`;
      } else {
        promptIntro = `Please provide five movie or TV show suggestions that are similar to "${title}"${year ? ` (${year})` : ''}.`;
      }
    } else {
      promptIntro = `Please provide five ${contentConfig.itemName} suggestions that are similar to ${
        ["books"].includes(listType) ? `the ${contentConfig.itemName} titled ` : ""
      }"${title}"${year ? ` (${year})` : ''}.`;
    }

    // Create the prompt
    const prompt = `${promptIntro} 
    ${paginationText}
    For each suggestion, include ${contentConfig.fields.map(f => `the ${f.name}`).join(', ')}, and a brief description of why it's ${listType === "places" || listType === "gifts" ? "appropriate" : "similar"}.
    Return only the list of suggestions in JSON format with the following structure:
    {
      "suggestions": [
        ${JSON.stringify(jsonStructure, null, 2)}
      ]
    }`;

    // Make a request to the Gemini API
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      }
    );

    // Extract the response text
    const responseText = response.data.candidates[0].content.parts[0].text;

    // Clean up the response - remove markdown code blocks if present
    const cleanedResponse = responseText.replace(/```json|```/g, '').trim();

    // Validate that the response is valid JSON
    try {
      // Test parse (but don't save the result)
      const parsedJson = JSON.parse(cleanedResponse);

      // Add pagination metadata to the response
      parsedJson.meta = {
        page: page,
        itemsPerPage: 5,
        currentRange: `${startNum}-${endNum}`
      };

      // If we get here, the JSON is valid
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(parsedJson));
    } catch (jsonError) {
      console.error('Invalid JSON received from Gemini API:', jsonError);
      res.status(500).json({
        error: 'Invalid JSON response from Gemini API',
        message: 'The API returned a response that could not be parsed as valid JSON'
      });
    }
  } catch (error) {
    console.error(`Error fetching ${req.body.listType} suggestions from Gemini API:`, error);

    // Handle different types of errors
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      res.status(error.response.status).json({
        error: 'Error from Gemini API',
        details: error.response.data
      });
    } else if (error.request) {
      // The request was made but no response was received
      res.status(500).json({
        error: 'No response received from Gemini API',
        details: 'The request was made but no response was received'
      });
    } else {
      // Something happened in setting up the request that triggered an Error
      res.status(500).json({
        error: 'Error setting up request to Gemini API',
        message: error.message
      });
    }
  }
});

module.exports = router;