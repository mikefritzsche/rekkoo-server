const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const axios = require('axios')

const API_KEY = process.env.GOOGLE_API_KEY_WEB;
const OPENLIBRARY_BASE_URL = 'https://openlibrary.org';
const OPENLIBRARY_COVERS_URL = 'https://covers.openlibrary.org';

// --- User-Agent Configuration ---
const APP_NAME = process.env.APP_NAME || 'RekkooApp';
const CONTACT_INFO = process.env.APP_CONTACT || 'support@mikefritzsche.com';
const USER_AGENT_STRING = `${APP_NAME} (${CONTACT_INFO})`;

// --- Axios Configuration (including User-Agent and optional Proxy) ---
const axiosConfig = {
  headers: {
    'User-Agent': USER_AGENT_STRING
  },
  // Default timeout for all requests unless overridden
  timeout: 8000 // 8 seconds general timeout
};

// --- Helper Functions ---
// Extracts author names from author objects linked in work/edition records
const formatWorkAuthors = (authorLinks) => {
  if (!Array.isArray(authorLinks)) return ['Unknown Author'];
  // The structure is often { author: { key: '/authors/OL...' } } but name isn't directly here.
  // We need *another* lookup to get names reliably. For simplicity NOW, we return keys or a placeholder.
  // A full implementation would fetch author details based on the key.
  const keys = authorLinks.map(a => a.author?.key).filter(Boolean);
  return keys.length > 0 ? keys.map(k => `Author Key: ${k}`) : ['Unknown Author'];
  // TODO: Implement author name lookup if needed for final output
};

const formatSubjectForUrl = (subject) => {
  return subject.toLowerCase().replace(/[- ]/g, '_').replace(/[^\w_]/g, '');
};

// Extracts description, handling string or object format
const extractDescription = (descriptionData) => {
  if (!descriptionData) return null;
  if (typeof descriptionData === 'string') return descriptionData;
  if (typeof descriptionData === 'object' && descriptionData.value) return descriptionData.value;
  return null;
};

// Constructs cover image URL
const getImageUrl = (coverIds, size = 'M') => {
  if (!Array.isArray(coverIds) || coverIds.length === 0) return null;
  // Use the first cover ID
  const coverId = coverIds[0];
  if (!coverId || typeof coverId !== 'number') return null;
  return `${OPENLIBRARY_COVERS_URL}/b/id/${coverId}-${size}.jpg`;
};

// Deduplicates and filters subjects for a specific book
const filterAndDeduplicateSubjects = (subjectsRaw = [], maxSubjects = 5) => {
  const ignoredSubjects = new Set(['accessible book', 'protected daisy', 'internet archive books', 'american libraries', 'large type books', 'fiction', 'juvenile fiction', 'history', 'biography']);
  const uniqueSubjectsMap = new Map();
  subjectsRaw.forEach(s => {
    if (typeof s === 'string' && s.trim()) {
      let cleanedSubject = s.replace(/\s+/g, ' ').trim();
      const lowerSubject = cleanedSubject.toLowerCase();
      if (!ignoredSubjects.has(lowerSubject) && !uniqueSubjectsMap.has(lowerSubject)) {
        uniqueSubjectsMap.set(lowerSubject, cleanedSubject);
      }
    }
  });
  return Array.from(uniqueSubjectsMap.values()).slice(0, maxSubjects);
}

router.get('/openlibrary', async (req, res) => {
  const { title, author } = req.query;
  const MAX_FINAL_RECOMMENDATIONS = 15;
  const MAX_SUBJECTS_TO_QUERY = 3;
  const RESULTS_PER_AUTHOR_QUERY = 10; // Slightly increased author results pool
  const RESULTS_PER_SUBJECT_QUERY = 25; // Slightly increased subject results pool

  if (!title || !author) {
    return res.status(400).json({ error: 'Missing required query parameters: title, author' });
  }

  console.log(`Fetching Open Library recommendations for Title: "${title}", Author: "${author}"`);

  try {
    let inputBookKey = null;
    let authorKeys = []; // Keys of the *original* author(s)
    let subjectsToQuery = []; // Subjects from the *original* book for finding similar
    const recommendedWorkKeys = new Set(); // Store unique keys (/works/OL...) of recommendations

    // --- Step 1 & 1b: Find Input Book, Get Subjects (including fallback) ---
    // ... (This logic remains the same as the previous complete version, finding inputBookKey, authorKeys, and populating subjectsToQuery) ...
    // --- Start copy from previous version ---
    console.log('Step 1: Finding input book on Open Library...');
    let bookData = null;
    try {
      const searchUrl = `${OPENLIBRARY_BASE_URL}/search.json`;
      const searchResponse = await axios.get(searchUrl, { ...axiosConfig, params: { title: title, author: author, limit: 1 } });
      if (searchResponse.data.docs && searchResponse.data.docs.length > 0) {
        bookData = searchResponse.data.docs[0];
        inputBookKey = bookData.key;
        authorKeys = bookData.author_key || [];
        const authorNames = bookData.author_name || [author]; // Keep for author step placeholder
        if (inputBookKey) recommendedWorkKeys.add(inputBookKey); // Add input book to avoid recommending itself
        console.log(`Found initial record: Key=${inputBookKey}, Type=${bookData.type?.key}, AuthorKeys=${authorKeys.join(', ')}`);
        const initialSubjects = bookData.subject || [];
        subjectsToQuery = filterAndDeduplicateSubjects(initialSubjects, MAX_SUBJECTS_TO_QUERY); // Use helper
        console.log(`  Subjects from initial search (dedup & sliced): ${subjectsToQuery.length > 0 ? subjectsToQuery.join(' || ') : 'None found'}`);
      } else {
        console.log('Input book not found via initial search.'); return res.json([]);
      }
    } catch (error) { console.error('Error during initial book search:', error.message); return res.status(500).json({ error: 'Failed initial book lookup' }); }

    if (subjectsToQuery.length === 0 && inputBookKey && inputBookKey.startsWith('/works/')) {
      console.log(`Step 1b: Fallback fetch for work key ${inputBookKey}...`);
      try {
        const workUrl = `${OPENLIBRARY_BASE_URL}${inputBookKey}.json`;
        const workResponse = await axios.get(workUrl, { ...axiosConfig, timeout: 5000 });
        if (workResponse.data && workResponse.data.subjects) {
          subjectsToQuery = filterAndDeduplicateSubjects(workResponse.data.subjects, MAX_SUBJECTS_TO_QUERY); // Use helper
          console.log(`  Subjects via work fallback (dedup & sliced): ${subjectsToQuery.length > 0 ? subjectsToQuery.join(' || ') : 'None found'}`);
        } else { console.log(`  Work details fetched, but no subjects found for ${inputBookKey}.`); }
      } catch (fallbackError) { console.error(`Error fetching work details fallback for ${inputBookKey}:`, fallbackError.message); }
    } else if (subjectsToQuery.length === 0) { console.log("Step 1b: Skipping work details fallback."); }
    // --- End copy from previous version ---


    // --- Step 2: Collect Keys - More by the Same Author ---
    const primaryAuthorKey = authorKeys[0];
    if (primaryAuthorKey) {
      console.log(`Step 2: Finding max ${RESULTS_PER_AUTHOR_QUERY} works by author key ${primaryAuthorKey}...`);
      try {
        const authorWorksUrl = `${OPENLIBRARY_BASE_URL}/authors/${primaryAuthorKey}/works.json`;
        const authorWorksResponse = await axios.get(authorWorksUrl, { ...axiosConfig, params: { limit: RESULTS_PER_AUTHOR_QUERY } });
        if (authorWorksResponse.data.entries) {
          authorWorksResponse.data.entries.forEach(work => {
            if (work.key && work.key.startsWith('/works/')) { // Ensure it's a work key
              recommendedWorkKeys.add(work.key); // Add key to the set
            }
          });
          console.log(`Collected ${authorWorksResponse.data.entries.length} potential works by author.`);
        }
      } catch (error) { console.error(`Error fetching works for author key ${primaryAuthorKey}:`, error.message); }
    } else { console.log('Step 2: Skipped fetching by author key.'); }


    // --- Step 3: Collect Keys - Books in the Same Subjects ---
    if (subjectsToQuery.length > 0) {
      console.log(`Step 3: Querying up to ${subjectsToQuery.length} subjects (${subjectsToQuery.join(' || ')})...`);
      for (const subject of subjectsToQuery) {
        const subjectUrlName = formatSubjectForUrl(subject);
        console.log(` -> Querying subject "${subject}" (URL: ${subjectUrlName})...`);
        try {
          const subjectUrl = `${OPENLIBRARY_BASE_URL}/subjects/${subjectUrlName}.json`;
          const subjectResponse = await axios.get(subjectUrl, { ...axiosConfig, params: { limit: RESULTS_PER_SUBJECT_QUERY }, timeout: 10000 });
          if (subjectResponse.data.works) {
            let addedCount = 0;
            subjectResponse.data.works.forEach(work => {
              // Ensure it's a work key and the author is different
              const isDifferentAuthor = !work.authors?.some(a => authorKeys.includes(a.key));
              if (work.key && work.key.startsWith('/works/') && isDifferentAuthor) {
                recommendedWorkKeys.add(work.key); // Add key to the set
                addedCount++;
              }
            });
            if (addedCount > 0) console.log(`    Collected ${addedCount} potential works from subject "${subject}".`);
          }
        } catch (error) { console.warn(`    Error/Timeout fetching subject "${subject}":`, error.message); } // Warn instead of error
      }
      console.log(`Step 3 completed.`);
    } else { console.log("Step 3: Skipped subject query."); }

    // Remove the original input book key from the set of recommendations
    if (inputBookKey) {
      recommendedWorkKeys.delete(inputBookKey);
    }
    const finalKeysToFetch = Array.from(recommendedWorkKeys);
    console.log(`Collected a total of ${finalKeysToFetch.length} unique recommendation keys to fetch details for.`);


    // --- Step 4: Fetch Details for Recommended Work Keys ---
    console.log(`Step 4: Fetching details for up to ${MAX_FINAL_RECOMMENDATIONS} recommendations...`);
    const detailPromises = finalKeysToFetch
    .slice(0, MAX_FINAL_RECOMMENDATIONS * 2) // Fetch slightly more initially in case some fail
    .map(async (workKey) => {
      try {
        console.log(` -> Fetching details for ${workKey}`);
        const workUrl = `${OPENLIBRARY_BASE_URL}${workKey}.json`;
        const response = await axios.get(workUrl, { ...axiosConfig, timeout: 6000 }); // Shorter timeout per item
        const data = response.data;

        // Introduce a small delay to be polite to the API
        await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay

        return {
          title: data.title || 'Untitled',
          // TODO: Replace placeholder author formatting with real lookup if needed
          authors: formatWorkAuthors(data.authors), // Placeholder, see function
          description: extractDescription(data.description),
          publishedDate: data.first_publish_date || null,
          imageUrl: getImageUrl(data.covers),
          subjects: filterAndDeduplicateSubjects(data.subjects, 5), // Filter/dedup subjects for this book
          openLibraryKey: workKey
        };
      } catch (error) {
        console.warn(`    Failed to fetch details for ${workKey}: ${error.message}`);
        return null; // Return null if fetching fails for this specific item
      }
    });

    // Wait for all detail fetches to complete (or fail)
    const detailedRecommendationsRaw = await Promise.all(detailPromises);

    // Filter out any null results (failed fetches) and limit the final count
    const finalRecommendations = detailedRecommendationsRaw
    .filter(rec => rec !== null) // Remove failed lookups
    .slice(0, MAX_FINAL_RECOMMENDATIONS); // Apply final limit

    console.log(`Step 4 completed. Returning ${finalRecommendations.length} detailed recommendations.`);
    res.json(finalRecommendations);

  } catch (error) {
    console.error("General error during recommendation process:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch recommendations', details: error.message });
    }
  }
});

module.exports = router;