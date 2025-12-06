const fetch = require('node-fetch');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

const AMAZON_SHORT_DOMAINS = ['a.co', 'amzn.to'];
const SCRAPE_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 25;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scrapeQueue = [];
let processingQueue = false;

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
        console.warn('[amazonScraper] HEAD resolve failed for short Amazon URL:', err?.message || err);
    }

    try {
        const getResolved = await followRedirect('GET');
        if (getResolved) return getResolved;
    } catch (err) {
        console.warn('[amazonScraper] GET resolve failed for short Amazon URL:', err?.message || err);
    }

    return url;
};

const normalizeAmazonProductUrl = async (rawUrl) => {
    const candidate = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!candidate) {
        throw new Error('Provide a valid Amazon product URL');
    }
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Provide a valid Amazon product URL');
    }
    const baseHost = getBaseHostname(parsed.hostname);
    let workingUrl = candidate;

    if (!isAmazonHostname(baseHost) && isAmazonShortHostname(baseHost)) {
        workingUrl = await resolveShortAmazonUrl(candidate);
    }

    try {
        const finalHost = getBaseHostname(new URL(workingUrl).hostname);
        if (!isAmazonHostname(finalHost)) {
            throw new Error('Provide a valid Amazon product URL');
        }
    } catch {
        throw new Error('Provide a valid Amazon product URL');
    }

    return workingUrl;
};

const extractAmazonProductData = ($, finalUrl) => {
    const title = $('#productTitle').text().trim();
    const price =
        $('span.a-price.a-text-price.a-size-medium.apexPriceToPay span.a-offscreen').first().text().trim() ||
        $('span.a-price span.a-offscreen').first().text().trim();
    const image = $('#landingImage').attr('src') || $('#imgBlkFront').attr('src');
    const bullets = $('#feature-bullets ul li span')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length > 0);
    const description =
        bullets.length > 0
            ? bullets.join('\n\n')
            : $('#productDescription p')
                  .map((_, el) => $(el).text().trim())
                  .get()
                  .join('\n\n');

    const images = [
        image,
        $('#altImages img[src], #altImages img[data-old-hires]')
            .map((_, el) => $(el).attr('data-old-hires') || $(el).attr('src'))
            .get(),
        $('#imageBlock img[src]').map((_, el) => $(el).attr('src')).get(),
    ]
        .flat()
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i)
        .filter((u) => u.startsWith('http'));

    return {
        title,
        price,
        image,
        images,
        bullets,
        description,
        resolvedUrl: finalUrl,
        store: 'Amazon',
    };
};

const scrapeAmazonProduct = async (rawUrl) => {
    const normalizedUrl = await normalizeAmazonProductUrl(rawUrl);
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36'
        );
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const html = await page.content();
        const finalUrl = page.url();
        const $ = cheerio.load(html);

        const data = extractAmazonProductData($, finalUrl);
        if (!data.title) {
            throw new Error('Product data not found');
        }
        return { ...data, normalizedUrl };
    } finally {
        if (browser) await browser.close();
    }
};

const processQueue = async () => {
    if (processingQueue) return;
    processingQueue = true;
    while (scrapeQueue.length > 0) {
        const job = scrapeQueue.shift();
        if (!job) break;
        const startedAt = Date.now();
        try {
            const result = await scrapeAmazonProduct(job.url);
            job.resolve({ ok: true, result });
        } catch (err) {
            job.resolve({
                ok: false,
                error: err?.message || 'Scraping failed',
            });
        }
        const remainingDelay = SCRAPE_DELAY_MS - (Date.now() - startedAt);
        if (scrapeQueue.length > 0 && remainingDelay > 0) {
            await wait(remainingDelay);
        }
    }
    processingQueue = false;
};

const enqueueAmazonScrape = (url) =>
    new Promise((resolve) => {
        scrapeQueue.push({ url, resolve });
        if (!processingQueue) {
            processQueue();
        }
    });

module.exports = {
    enqueueAmazonScrape,
    MAX_BATCH_SIZE,
    resolveShortAmazonUrl,
    getBaseHostname,
    isAmazonHostname,
    isAmazonShortHostname,
};
