const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const API_KEY = process.env.GOOGLE_API_KEY_WEB;

router.get('/', async (req, res) => {
  try {
    const { query, orderBy = 'relevance', startIndex = 0, maxResults = 40 } = req.query;
    if (!query) return res.status(400).json({error: "Query is required"});

    const queryParams = {
      q: query,
      orderBy,
      startIndex,
      maxResults,
    }
    const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams(queryParams)}`
    console.log(`books url: `, url)
    const response = await fetch(url);

    // if (!response.ok) throw new Error('Google Books API request failed');

    const data = await response.json();
    console.log(`data: `, data)

    data.items?.map(item => ({
      id: `book_${item.id}`,
      title: item.volumeInfo.title,
      subtitle: item.volumeInfo.authors?.join(', '),
      additionalInfo: item.volumeInfo.publishedDate,
      imageUrl: item.volumeInfo.imageLinks?.thumbnail,
      item
    })) || []
    res.json({kind: data.kind, totalItems: data.totalItems, items: data.items})
  } catch (error) {
    console.error('Book search error:', error);
    res.status(500).json({error: 'Internal Server Error'});
  }
})

module.exports = router;