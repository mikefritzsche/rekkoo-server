const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config(); // Ensure environment variables are loaded

// --- Environment Variables & Constants ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEY_DEVONE = process.env.GEMINI_API_KEY_DEVONE;
if (!GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY environment variable not set.");
  // Consider how your application should behave if the key is missing
  // process.exit(1); // Exit? Throw? Log and continue with limited functionality?
}

// *** USE THE USER-PROVIDED EXPERIMENTAL MODEL NAME ***
const MODEL_NAME = "gemini-2.0-flash"; // Using your specific model name

// Construct the API URL dynamically using the model name and v1beta endpoint
// v1beta is often necessary for experimental or newer models
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY_DEVONE}`;

const DEFAULT_MAX_RESULTS = 5;    // Default suggestions per page if frontend doesn't specify
const ABSOLUTE_MAX_RESULTS = 20;  // Hard cap to prevent overly large requests

/**
 * Configuration for different content types.
 * Defines the item name, expected fields for suggestions, and specific prompt instructions.
 */
const contentTypes = {
  "books": {
    itemName: "book",
    fields: [
      { name: "title", example: "The Midnight Library" },
      { name: "authors", example: ["Matt Haig"] },
      { name: "year", example: 2020 },
    ],
    promptInstructions: [
      "For the `authors` field, provide an array of strings, with each string being the full name of an author.",
      "For the `year` field, provide the original publication year as an integer.",
    ],
    titleContext: {
      "Treasure of Khan": "(part of the Fargo Adventure series by Clive Cussler et al.)"
    }
  },
  "movies": {
    itemName: "movie or TV show",
    fields: [
      { name: "title", example: "Everything Everywhere All at Once" },
      { name: "creator", example: "Daniel Kwan, Daniel Scheinert" },
      { name: "year", example: 2022 },
      { name: "type", example: "Movie" } // "Movie" or "TV Show"
    ],
    promptInstructions: [
      "For the `type` field, specify if it's a 'Movie' or 'TV Show'.",
      "For the `creator` field, list the primary director(s) or show creator(s)."
    ],
    subtypes: {
      "movie": { itemName: "movie", promptText: "movie suggestions (not TV shows)" },
      "tv": { itemName: "TV show", promptText: "TV show suggestions (not movies)" }
    }
  },
  "music": {
    itemName: "music item (album, song, or artist)",
    fields: [
      { name: "title", example: "Rumours" },
      { name: "artist", example: "Fleetwood Mac" },
      { name: "year", example: 1977 },
      { name: "type", example: "Album" } // "Album", "Song", "Artist"
    ],
    promptInstructions: [
      "For the `type` field, specify if it's an 'Album', 'Song', or 'Artist'."
    ]
  },
  "places": {
    itemName: "place",
    fields: [
      { name: "name", example: "Machu Picchu" },
      { name: "location", example: "Cusco Region, Peru" },
      { name: "type", example: "Historical Site" }
    ]
  },
  "gifts": {
    itemName: "gift idea",
    fields: [
      { name: "item", example: "Smart Reusable Notebook Set" },
      { name: "category", example: "Stationery/Tech" },
      { name: "price_range", example: "$30-$50" }
    ]
  }
  // Add other list types here following the same structure
};

// Helper function for ordinal numbers (e.g., 1st, 2nd, 3rd)
const getOrdinal = (n) => {
  if (typeof n !== 'number' || isNaN(n) || n < 1) return n?.toString() || ''; // Handle invalid input gracefully
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0] || "th");
};


/**
 * @route POST /v1.0/suggestions
 * @description Generates content suggestions using the specified Google Gemini model.
 * Accepts pagination and variable result count.
 */
router.post('/', async (req, res) => {
  console.log("Received POST /v1.0/suggestions request. Body:", req.body); // Log incoming request body
  try {
    // --- Parameter Extraction and Validation ---
    const {
      listType,
      title,
      year,
      mediaType,
      page = 1,  // Default to page 1
      maxResults // Get from frontend
    } = req.body;

    // Basic required field validation
    if (!listType) return res.status(400).json({ error: 'Missing required parameter: listType' });
    if (!title) return res.status(400).json({ error: 'Missing required parameter: title' });

    // Validate and determine resultsPerPage
    // Use default if maxResults is missing, invalid, or non-positive
    const requestedResults = parseInt(maxResults, 10);
    let resultsPerPage = (!isNaN(requestedResults) && requestedResults > 0) ? requestedResults : DEFAULT_MAX_RESULTS;
    // Apply hard cap
    resultsPerPage = Math.min(resultsPerPage, ABSOLUTE_MAX_RESULTS);
    console.log(`Determined resultsPerPage: ${resultsPerPage} (Requested: ${maxResults})`);

    // Validate mediaType if provided for movies
    if (listType === "movies" && mediaType && !['movie', 'tv'].includes(mediaType)) {
      return res.status(400).json({ error: 'Invalid mediaType value. Must be "movie" or "tv".' });
    }

    // Ensure page is a valid positive integer
    const currentPage = parseInt(page, 10);
    if (isNaN(currentPage) || currentPage < 1) {
      return res.status(400).json({ error: 'Invalid page value. Must be a positive integer starting from 1.' });
    }

    // --- Get Content Configuration ---
    const contentConfig = contentTypes[listType];
    if (!contentConfig) {
      return res.status(400).json({ error: `Unsupported listType: ${listType}` });
    }

    // --- Pagination Calculation ---
    const startNum = (currentPage - 1) * resultsPerPage + 1;
    const endNum = currentPage * resultsPerPage;
    const paginationText = currentPage > 1
      ? ` This is page ${currentPage}. Provide the ${getOrdinal(startNum)} through ${getOrdinal(endNum)} most relevant suggestions, distinct from suggestions provided on previous pages.`
      : ` Provide the ${resultsPerPage} most relevant suggestions.`;

    // --- Reason Text Logic ---
    const reasonTextFieldName = "reason";
    let reasonPromptText;
    if (listType === "places") reasonPromptText = `Why this place would appeal to someone who likes ${title}`;
    else if (listType === "gifts") reasonPromptText = `Why this would be a good gift for someone who likes ${title}`;
    else reasonPromptText = `Brief reason why this ${contentConfig.itemName} is similar to "${title}"`;

    // --- Build JSON Structure Example for Prompt ---
    const jsonStructureExample = contentConfig.fields.reduce((obj, field) => {
      obj[field.name] = field.example; return obj;
    }, { [reasonTextFieldName]: "Brief reason..." });

    // --- Build Prompt Introduction ---
    const sourceItemDetails = `"${title}"${year ? ` (${year})` : ''}${contentConfig.titleContext?.[title] || ''}`;
    let promptIntro;
    if (listType === "places") promptIntro = `Act as a travel recommender. Provide ${resultsPerPage} place recommendations for someone who likes ${sourceItemDetails}.`;
    else if (listType === "gifts") promptIntro = `Act as a gift advisor. Suggest ${resultsPerPage} gift ideas for someone who likes ${sourceItemDetails}.`;
    else if (listType === "movies" && mediaType && contentConfig.subtypes[mediaType]) {
      const subtype = contentConfig.subtypes[mediaType];
      promptIntro = `Act as a ${subtype.itemName} recommender. Provide ${resultsPerPage} ${subtype.promptText} similar to ${sourceItemDetails}.`;
    } else {
      const itemTypeText = ["books"].includes(listType) ? `the ${contentConfig.itemName} titled ` : "";
      promptIntro = `Act as a ${contentConfig.itemName} recommender. Provide ${resultsPerPage} ${contentConfig.itemName} suggestions similar to ${itemTypeText}${sourceItemDetails}.`;
    }

    // --- Assemble Final Prompt ---
    const fieldListText = contentConfig.fields.map(f => `\`${f.name}\``).join(', ');
    const detailedInstructions = contentConfig.promptInstructions ? `\n${contentConfig.promptInstructions.join('\n')}` : '';
    const prompt = `${promptIntro}${paginationText}\n\nFor each suggestion, include the fields: ${fieldListText}, and \`${reasonTextFieldName}\`.\n${detailedInstructions}\nThe \`${reasonTextFieldName}\` field should contain: ${reasonPromptText}.\n\nReturn *only* the raw JSON object with a root key "suggestions" containing a JSON list. Adhere strictly to the example format. Do not include explanations or markdown formatting.\n\nExample Format:\n\`\`\`json\n{\n  "suggestions": [\n    ${JSON.stringify(jsonStructureExample, null, 2)}\n    // ... more suggestions up to ${resultsPerPage} ...\n  ]\n}\n\`\`\``;

    // --- Log Prompt (Optional) ---
    console.log(`Sending prompt to Gemini Model: ${MODEL_NAME} (Page: ${currentPage}, Requesting: ${resultsPerPage} results)...`);
    // console.log("Prompt Content:\n", prompt); // Uncomment to debug the full generated prompt

    // --- Make API Call to Gemini ---
    const geminiResponse = await axios.post(
      GEMINI_API_URL, // URL includes model and API key
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          // Request JSON output directly if supported by the model
          responseMimeType: "application/json",
          temperature: 0.65, // Adjust creativity vs. consistency
          // maxOutputTokens: 4096 // Adjust if necessary based on expected response size
        }
        // safetySettings: [...] // Add safety settings if required
      },
      { // Axios request config
        headers: { 'Content-Type': 'application/json' }
      }
    );

    // --- Process Response ---
    console.log("Gemini Raw Response Status:", geminiResponse.status);
    // Log the full raw data for detailed debugging if needed
    // console.log("Gemini Raw Response Data:", JSON.stringify(geminiResponse.data, null, 2));

    // Robustly check for the expected response structure
    const candidate = geminiResponse.data?.candidates?.[0];
    const responseText = candidate?.content?.parts?.[0]?.text;

    if (!responseText) {
      console.error('Invalid response structure from Gemini API:', geminiResponse.data);
      const finishReason = candidate?.finishReason;
      const safetyRatings = candidate?.safetyRatings;
      // Check for specific blocking reasons
      if (finishReason === 'SAFETY') {
        return res.status(400).json({ error: 'Content blocked due to safety settings.', details: { finishReason, safetyRatings } });
      }
      if (finishReason === 'RECITATION') {
        return res.status(400).json({ error: 'Content blocked due to potential recitation.', details: { finishReason } });
      }
      // Other potential finish reasons: MAX_TOKENS, OTHER
      return res.status(500).json({ error: 'Received incomplete or unexpected response from Gemini.', details: { finishReason, safetyRatings } });
    }

    console.log("Raw response text from Gemini:\n", responseText);

    // --- Parse and Validate JSON ---
    let parsedJson;
    try {
      // Clean potential markdown wrappers, though responseMimeType should prevent this
      const cleanedResponse = responseText.replace(/^```json\s*|```$/g, '').trim();
      parsedJson = JSON.parse(cleanedResponse);

      // Validate the expected structure
      if (!parsedJson || !Array.isArray(parsedJson.suggestions)) {
        console.error('Parsed JSON missing "suggestions" array:', parsedJson);
        throw new Error('Parsed JSON does not contain the expected "suggestions" array.');
      }
      console.log(`Parsed ${parsedJson.suggestions.length} suggestions successfully.`);

    } catch (jsonError) {
      console.error('Invalid JSON received from Gemini API after cleaning:', jsonError);
      console.error('Cleaned response text that failed parsing:', responseText.replace(/^```json\s*|```$/g, '').trim());
      return res.status(500).json({
        error: 'Invalid JSON response format from Gemini API',
        message: jsonError.message,
        rawResponse: responseText // Send back the raw text for debugging
      });
    }

    // --- Prepare and Send Final Response ---
    const actualSuggestionsReceived = parsedJson.suggestions.length;
    parsedJson.meta = {
      page: currentPage,
      itemsPerPage: resultsPerPage, // The number requested
      itemsReceived: actualSuggestionsReceived, // The number actually received in this batch
      // Calculate range based on actual received items
      currentRange: actualSuggestionsReceived > 0 ? `${startNum}-${startNum + actualSuggestionsReceived - 1}` : '',
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(parsedJson); // Send the final object

  } catch (error) {
    // --- Catch-All Error Handling ---
    console.error(`Error in POST /v1.0/suggestions:`, error.message);

    if (axios.isAxiosError(error)) { // Handle Axios-specific errors
      if (error.response) {
        console.error('Gemini API Error Status:', error.response.status);
        console.error('Gemini API Error Data:', JSON.stringify(error.response.data, null, 2));
        const errorDetails = error.response.data?.error || error.response.data || 'Unknown API Error';
        const errorMessage = `Gemini API Error (${error.response.status})`;
        return res.status(error.response.status || 500).json({ error: errorMessage, details: errorDetails });
      } else if (error.request) {
        console.error('Gemini API No Response:', error.request);
        return res.status(504).json({ error: 'No response received from Gemini API', details: 'Gateway Timeout or network issue.' });
      }
    }
    // Generic fallback for other errors
    console.error('Generic Server Error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

module.exports = router;