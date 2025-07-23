const fetch = require('node-fetch');

// TMDB configuration
const TMDB_CONFIG = {
  apiKey: process.env.TMDB_API_KEY,
  baseUrl: 'https://api.themoviedb.org/3'
};

/**
 * Factory function that creates a TMDBController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with TMDB API methods
 */
function tmdbControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  async function getConfiguration(req, res) {
    try {
      const response = await fetch(`${TMDB_CONFIG.baseUrl}/configuration?api_key=${TMDB_CONFIG.apiKey}`);
      const data = await response.json();
      
      res.json({...data});
    } catch (error) {
      res.status(500).json({error});
    }
  }

  /**
   * Utility function for movie search
   */
  async function searchSingleMovie(query, page = 1, include_adult) {
    const searchUrl = `${TMDB_CONFIG.baseUrl}/search/multi?api_key=${TMDB_CONFIG.apiKey}&query=${encodeURIComponent(query)}&page=${page}&include_adult=${include_adult}`;

    const response = await fetch(searchUrl);

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    return await response.json();
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
   * Get movie or TV show details
   */
  const getMediaDetails = async (req, res) => {
    const { mediaType, id } = req.params;
    console.log('getMediaDetails mediaType', mediaType);

    const appendToResponseString = 'append_to_response';
    // Include watch provider availability in the same request
    const appendToResponse = 'recommendations,similar,videos,external_ids,people,images,credits,watch/providers';
    const searchUrl = `${TMDB_CONFIG.baseUrl}/${mediaType}/${id}?api_key=${TMDB_CONFIG.apiKey}&language=en-US&${appendToResponseString}=${appendToResponse}`;
    console.log('searchUrl', searchUrl);
    try {
      const response = await fetch(searchUrl);
      const data = await response.json();
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

  // Return all controller methods
  return {
    getConfiguration,
    searchMedia,
    getMediaDetails,
    searchMultipleMedia
  };
}

module.exports = tmdbControllerFactory; 