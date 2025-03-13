const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
// const rateLimit = require('express-rate-limit');

// Rate limiting configuration
// const limiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 100 // limit each IP to 100 requests per windowMs
// });

// TMDB configuration
const TMDB_CONFIG = {
    apiKey: process.env.TMDB_API_KEY,
    baseUrl: 'https://api.themoviedb.org/3'
};

// Utility function for movie search
async function searchSingleMovie(title) {
    const searchUrl = `${TMDB_CONFIG.baseUrl}/search/multi?api_key=${TMDB_CONFIG.apiKey}&query=${encodeURIComponent(title)}`;

    const response = await fetch(searchUrl);

    if (!response.ok) {
        throw new Error(`TMDB API error: ${response.status}`);
    }

    return await response.json();
    // return data.results.map(movie => ({
    //     id: movie.id,
    //     title: movie.title,
    //     releaseDate: movie.release_date,
    //     overview: movie.overview,
    //     posterPath: movie.poster_path ?
    //         `https://image.tmdb.org/t/p/w500${movie.poster_path}` :
    //         null,
    //     voteAverage: movie.vote_average
    // }));
}

// Apply rate limiting to all TMDB routes
// router.use(limiter);

router.get('/search', async (req, res) => {
    try {
        // Input validation
        const { query } = req.query;

        // Search for all movies
        const searchResults = await searchSingleMovie(query)

        res.json(searchResults);
    } catch (error) {
        console.error('TMDB search error:', error);
        res.status(500).json({
            error: 'Internal server error'
        });
    }
});
// Search multiple movies endpoint
router.post('/search/multiple', async (req, res) => {
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
});

module.exports = router;