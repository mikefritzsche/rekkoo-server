const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

puppeteer.use(StealthPlugin());

const AMAZON_SHORT_DOMAINS = ['a.co', 'amzn.to'];

const getBaseHostname = (hostname = '') => {
    const cleaned = hostname.toLowerCase().replace(/^www\./, '').replace(/^smile\./, '').replace(/^m\./, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) {
        return parts.slice(-2).join('.');
    }
    return cleaned;
};

const isAmazonHostname = (hostname = '') => {
    const base = getBaseHostname(hostname);
    return base === 'amazon.com' || base.startsWith('amazon.');
};

const isAmazonShortHostname = (hostname = '') => {
    const base = getBaseHostname(hostname);
    return AMAZON_SHORT_DOMAINS.includes(base);
};

const resolveShortAmazonUrl = async (url) => {
    const followRedirect = async (method) => {
        const response = await fetch(url, { method, redirect: 'follow' });
        if (response?.url && response.url !== url) {
            return response.url;
        }
        const location = response?.headers?.get?.('location');
        if (location) {
            return new URL(location, url).toString();
        }
        return null;
    };

    try {
        const headResolved = await followRedirect('HEAD');
        if (headResolved) return headResolved;
    } catch (err) {
        console.warn('[products.scrape] HEAD resolve failed for short Amazon URL:', err?.message || err);
    }

    try {
        const getResolved = await followRedirect('GET');
        if (getResolved) return getResolved;
    } catch (err) {
        console.warn('[products.scrape] GET resolve failed for short Amazon URL:', err?.message || err);
    }

    return url;
};

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
        const parsed = new URL(url);
        const baseHost = getBaseHostname(parsed.hostname);
        if (!isAmazonHostname(baseHost) && isAmazonShortHostname(baseHost)) {
            url = await resolveShortAmazonUrl(url);
        }

        const finalHost = getBaseHostname(new URL(url).hostname);
        if (!isAmazonHostname(finalHost)) {
            return res.status(400).json({ error: 'Provide a valid Amazon product URL' });
        }
    } catch (err) {
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
        const finalUrl = page.url();
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
        res.json({ title, price, image, images, bullets, resolvedUrl: finalUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Scraping failed', err });
    } finally {
        if (browser) await browser.close();
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

module.exports = router;
