const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

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

router.post('/scrape', async (req, res) => {
    const url = req.body.url;
    if (!url || !url.includes('amazon.')) {
        return res.status(400).json({ error: 'Provide a valid Amazon product URL' });
    }
    console.log('amazon associate ID:', process.env.AMAZON_ASSOCIATE_ID);

    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36'
        );
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const html = await page.content();
        const $ = cheerio.load(html);

        const title = $('#productTitle').text().trim();
        const price = $('span.a-price.a-text-price.a-size-medium.apexPriceToPay span.a-offscreen')
            .first().text().trim() ||
            $('span.a-price span.a-offscreen').first().text().trim();
        const image = $('#landingImage').attr('src') || $('#imgBlkFront').attr('src');
        const bullets = $('#feature-bullets ul li span')
            .map((_, el) => $(el).text().trim())
            .get()
            .filter(t => t.length > 0);

        /* ---------- collect ALL product images ---------- */
        const images = [
            // primary image
            $('#landingImage').attr('src'),
            $('#imgBlkFront').attr('src'),

            // alternate shots from the left-thumbnail strip
            ...$('#altImages img[src], #altImages img[data-old-hires]')
                .map((_, el) => $(el).attr('data-old-hires') || $(el).attr('src'))
                .get(),

            // additional hi-res images in the imageBlock
            ...$('#imageBlock img[src]').map((_, el) => $(el).attr('src')).get()
        ]
            .filter(Boolean)           // remove null/undefined
            .filter((u, i, arr) => arr.indexOf(u) === i) // unique
            .filter(u => u.startsWith('http'));

        if (!title) return res.status(404).json({ error: 'Product data not found' });
        res.json({ title, price, image, images, bullets });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Scraping failed', err });
    } finally {
        if (browser) await browser.close();
    }

});

module.exports = router;