const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

router.get('/link', async (req, res) => {
    // res.json({message: 'link fetch', link: req.query.link})
    try {
        const link = req.query.link;
        if (!link) return res.status(400).json({ error: "Link is required" });

        const response = await fetch(link);
        const data = await response.text();

        res.json(data);
    } catch (error) {
        console.error('Error fetching url:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;