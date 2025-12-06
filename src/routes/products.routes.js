const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const puppeteer = require('puppeteer-extra');
const { enqueueAmazonScrape, MAX_BATCH_SIZE } = require('../services/amazonScraperService');

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

router.post('/resolve', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Provide a URL to resolve' });

    const AMAZON_REGEX = /(https?:\/\/)?(www\.)?amazon\.[^"'\s]+/i;
    const resolveWithFetch = async (method, redirect = 'follow', captureBody = false) => {
        const response = await fetch(url, {
            method,
            redirect,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36'
            }
        });
        if (response?.url && response.url !== url) return response.url;
        const location = response?.headers?.get?.('location');
        if (location) return new URL(location, url).toString();
        if (captureBody) {
            const text = await response.text();
            const match = text.match(AMAZON_REGEX);
            if (match && match[0]) {
                return match[0].startsWith('http') ? match[0] : `https://${match[0].replace(/^\/\//, '')}`;
            }
        }
        return null;
    };

    let browser;
    try {
        let resolved = null;
        try {
            resolved = await resolveWithFetch('HEAD');
        } catch (err) {
            console.warn('[products.resolve] HEAD failed:', err?.message || err);
        }
        if (!resolved) {
            try {
                resolved = await resolveWithFetch('GET');
            } catch (err) {
                console.warn('[products.resolve] GET failed:', err?.message || err);
            }
        }
        // Final fallback: use puppeteer to follow client-side redirects (e.g., a.co short links).
        if (!resolved) {
            try {
                browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36');
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
                resolved = page.url();
            } catch (err) {
                console.warn('[products.resolve] puppeteer resolve failed:', err?.message || err);
            }
        }
        // If still unresolved, try to parse HTML from a manual GET for an Amazon URL.
        if (!resolved) {
            try {
                resolved = await resolveWithFetch('GET', 'manual', true);
            } catch (err) {
                console.warn('[products.resolve] GET manual with body failed:', err?.message || err);
            }
        }
        res.json({ resolvedUrl: resolved || url });
    } catch (err) {
        console.error('[products.resolve] resolution failed:', err);
        res.status(500).json({ error: 'Resolution failed', resolvedUrl: url });
    } finally {
        if (browser) await browser.close();
    }
});

router.post('/scrape', async (req, res) => {
    let url = req.body.url;
    if (!url) {
        return res.status(400).json({ error: 'Provide a valid Amazon product URL' });
    }
    try {
        const result = await enqueueAmazonScrape(url);
        if (!result?.ok) {
            return res.status(400).json({ error: result?.error || 'Scraping failed' });
        }
        return res.json(result.result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Scraping failed' });
    }
});

router.post('/data', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Provide a valid URL' });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                `--proxy-server=http://USER:PASS@proxy-provider:PORT`
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
        );
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const html = await page.content();
        res.type('html').send(html);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Scraping failed', details: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

router.post('/scrape/batch', async (req, res) => {
    const urls = req.body?.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Provide at least one URL to scrape' });
    }
    if (urls.length > MAX_BATCH_SIZE) {
        return res.status(400).json({ error: `Batch limit is ${MAX_BATCH_SIZE} URLs` });
    }

    const normalizedInputs = urls
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => u.length > 0);

    if (normalizedInputs.length === 0) {
        return res.status(400).json({ error: 'Provide at least one URL to scrape' });
    }

    try {
        const jobMap = new Map();
        normalizedInputs.forEach((u) => {
            if (!jobMap.has(u)) {
                jobMap.set(u, enqueueAmazonScrape(u));
            }
        });

        const results = await Promise.all(
            normalizedInputs.map(async (inputUrl) => {
                const outcome = await jobMap.get(inputUrl);
                if (!outcome?.ok) {
                    return { inputUrl, error: outcome?.error || 'Scraping failed' };
                }
                return { inputUrl, ...outcome.result };
            })
        );

        res.json({ results });
    } catch (err) {
        console.error('[products.scrape.batch] failed', err);
        res.status(500).json({ error: 'Batch scraping failed' });
    }
});

module.exports = router;
