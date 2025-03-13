const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

router.get('/places', async (req, res) => {
    try {
        const query = req.query.query;
        if (!query) return res.status(400).json({ error: "Query is required" });

        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${process.env.GOOGLE_API_KEY_WEB}`;
        const response = await fetch(url);
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error('Error fetching places:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/places/details', async (req, res) => {
    try {
        const response = await fetch(
            `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,website,formatted_phone_number&key=${API_KEYS.GOOGLE_PLACES}`
        );

        if (!response.ok) throw new Error('Google Places Details API request failed');

        const data = await response.json();

        if (!data.result) throw new Error('No details found for this place');

        return {
            name: data.result.name,
            website: data.result.website || 'No website available',
            phoneNumber: data.result.formatted_phone_number || 'No phone number available'
        };
    } catch (error) {
        console.error('Place details error:', error);
        throw new Error('Failed to fetch place details');
    }
})

router.get('/books', async (req, res) => {
    try {
        const query = req.query.query;
        if (!query) return res.status(400).json({ error: "Query is required" });

        const response = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=40`
        );

        // if (!response.ok) throw new Error('Google Books API request failed');

        const data = await response.json();

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
        res.status(500).json({ error: 'Internal Server Error' });
    }
})

module.exports = router;