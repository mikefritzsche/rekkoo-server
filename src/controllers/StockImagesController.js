const fetch = require('node-fetch');
const querystring = require('node:querystring');

/**
 * Factory function that creates a StockImagesController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with stock images API methods
 */
function stockImagesControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };
  
  /**
   * Search for stock images from Pexels API
   */
  const searchImages = async (req, res) => {
    const {query, pagingQuery = '', perPage} = req.query;
    const queryParams = {
      query,
      orientation: 'Landscape',
      per_page: perPage || 18
    };

    let baseUrl = 'https://api.pexels.com/v1/search';
    let url;

    if (!pagingQuery) {
      url = `${baseUrl}?${querystring.stringify(queryParams)}`;
    } else {
      // pagingQuery may arrive URI-encoded from the client. Decode it so that node-fetch receives a valid URL.
      const decodedPagingQuery = decodeURIComponent(pagingQuery);
      console.log(`has pagingQuery (decoded): `, decodedPagingQuery);
      url = decodedPagingQuery;
    }
    console.log(`url: `, url);

    try {
      const resp = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: process.env.PEXELS_API_KEY || 'DDqhmYvwX1pBgj94rdHSgsJn1j44rYt5on69A4VnRDDu0hXLO47CH5Cy'
        }
      });
      const data = await resp.json();
      // Ensure the response is never cached so the browser doesn’t receive 304 (empty body) on repeated queries.
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      res.json(data);
    } catch (e) {
      console.log(`error: `, e);
      res.status(500).json({error: e.message});
    }
  };

  /**
   * Get a specific image by ID from Pexels API
   */
  const getImageById = async (req, res) => {
    const { id } = req.params;
    
    try {
      const resp = await fetch(`https://api.pexels.com/v1/photos/${id}`, {
        headers: {
          Authorization: process.env.PEXELS_API_KEY || 'DDqhmYvwX1pBgj94rdHSgsJn1j44rYt5on69A4VnRDDu0hXLO47CH5Cy'
        }
      });
      
      const image = await resp.json();
      res.json(image);
    } catch (e) {
      console.log(`error: `, e);
      res.status(500).json({error: e.message});
    }
  };

  // Return all controller methods
  return {
    searchImages,
    getImageById
  };
}

module.exports = stockImagesControllerFactory; 