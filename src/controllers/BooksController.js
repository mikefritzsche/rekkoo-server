const fetch = require('node-fetch');
const { cacheFetch } = require('../utils/cache.js');

/**
 * Factory function that creates a BooksController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with book search methods
 */
function booksControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => { } // No-op function
  };

  /**
   * Search for books via Google Books API
   */
  const searchBooks = async (req, res) => {
    console.log(`query: `, req.query);
    try {
      const { query, orderBy = 'relevance', startIndex = 0, maxResults = 40 } = req.query;
      if (!query) return res.status(400).json({ error: "Query is required" });

      // All params that influence the result become the “payload”
      const payload = { q: query, startIndex, maxResults, orderBy };
      // 5-minute cache for book suggestions
      const data = await cacheFetch(
        'books',            // namespace
        payload,            // cache key payload
        async () => {
          const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams(payload)}`;
          const r = await fetch(url);
          return r.json();
        },
        60 * 5              // TTL in seconds
      );

      const { safeStoreSearchEmbedding } = require('../utils/searchEmbeddingUtils');
      await safeStoreSearchEmbedding(req, query);

      data.items?.map(item => ({
        id: `${item.id}`,
        title: item.volumeInfo.title,
        subtitle: item.volumeInfo.authors?.join(', '),
        additionalInfo: item.volumeInfo.publishedDate,
        imageUrl: item.volumeInfo.imageLinks?.thumbnail,
        item
      })) || [];

      res.json({ kind: data.kind, totalItems: data.totalItems, items: data.items });
    } catch (error) {
      console.error('Book search error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };

  /**
   * Get book details by volume ID
   */
  const getBookDetails = async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) return res.status(400).json({ error: "Volume id is required" });

      const url = `https://www.googleapis.com/books/v1/volumes/${id}`;
      const response = await fetch(url);
      const data = await response.json();

      return res.json(data);
    } catch (error) {
      console.error('Book search error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };

  // Return all controller methods
  return {
    searchBooks,
    getBookDetails
  };
}

module.exports = booksControllerFactory; 