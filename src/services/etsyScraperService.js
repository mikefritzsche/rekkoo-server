const fetch = require('node-fetch');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

const ETSY_SHORT_DOMAINS = ['etsy.me'];
const SCRAPE_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 25;
const ETSY_PROXY_URL = process.env.ETSY_PROXY_URL || process.env.SCRAPER_PROXY_URL || '';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scrapeQueue = [];
let processingQueue = false;

const getBaseHostname = (hostname = '') => {
    const cleaned = hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) {
        return parts.slice(-2).join('.');
    }
    return cleaned;
};

const isEtsyHostname = (hostname = '') => getBaseHostname(hostname) === 'etsy.com';

const isEtsyShortHostname = (hostname = '') => ETSY_SHORT_DOMAINS.includes(getBaseHostname(hostname));

const resolveShortEtsyUrl = async (url) => {
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
        console.warn('[etsyScraper] HEAD resolve failed for short Etsy URL:', err?.message || err);
    }

    try {
        const getResolved = await followRedirect('GET');
        if (getResolved) return getResolved;
    } catch (err) {
        console.warn('[etsyScraper] GET resolve failed for short Etsy URL:', err?.message || err);
    }

    return url;
};

const isValidEtsyListingPath = (pathname = '') => /\/listing\/\d+/i.test(pathname);

const normalizeEtsyProductUrl = async (rawUrl) => {
    const candidate = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!candidate) {
        throw new Error('Provide a valid Etsy product URL');
    }

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Provide a valid Etsy product URL');
    }

    const baseHost = getBaseHostname(parsed.hostname);
    let workingUrl = candidate;

    if (!isEtsyHostname(baseHost) && isEtsyShortHostname(baseHost)) {
        workingUrl = await resolveShortEtsyUrl(candidate);
    }

    let finalUrl;
    try {
        finalUrl = new URL(workingUrl);
    } catch {
        throw new Error('Provide a valid Etsy product URL');
    }

    if (!isEtsyHostname(finalUrl.hostname) || !isValidEtsyListingPath(finalUrl.pathname)) {
        throw new Error('Provide a valid Etsy product URL');
    }

    return finalUrl.toString();
};

const collectJsonLdNodes = (node, list) => {
    if (!node) return;
    if (Array.isArray(node)) {
        node.forEach((item) => collectJsonLdNodes(item, list));
        return;
    }
    if (typeof node === 'object') {
        list.push(node);
        if (Array.isArray(node['@graph'])) {
            node['@graph'].forEach((item) => collectJsonLdNodes(item, list));
        }
    }
};

const findProductJsonLd = ($) => {
    const candidates = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            collectJsonLdNodes(parsed, candidates);
        } catch (err) {
            console.warn('[etsyScraper] JSON-LD parse failed:', err?.message || err);
        }
    });

    return candidates.find((item) => {
        const type = item['@type'];
        if (Array.isArray(type)) return type.includes('Product');
        return type === 'Product';
    });
};

const normalizeImages = (images) => {
    if (!images) return [];
    if (typeof images === 'string') return [images];
    if (Array.isArray(images)) return images.filter(Boolean);
    return [];
};

const getPrimaryOffer = (offers) => {
    if (Array.isArray(offers)) return offers.find(Boolean) || null;
    if (offers && typeof offers === 'object') return offers;
    return null;
};

const formatPrice = (offers) => {
    const offer = getPrimaryOffer(offers);
    const price = offer?.price ?? offer?.lowPrice ?? '';
    const currency = offer?.priceCurrency;
    if (!price) return '';
    if (currency) return `${currency} ${price}`;
    return String(price);
};

const getProxyConfig = () => {
    if (!ETSY_PROXY_URL) return null;
    try {
        const parsed = new URL(ETSY_PROXY_URL);
        return {
            server: `${parsed.protocol}//${parsed.host}`,
            username: parsed.username || '',
            password: parsed.password || '',
        };
    } catch (err) {
        console.warn('[etsyScraper] invalid proxy URL provided:', err?.message || err);
        return null;
    }
};

const getMetaContent = ($, selector) => ($(selector).attr('content') || '').trim();

const extractMetaPrice = ($) => {
    const amount =
        getMetaContent($, 'meta[property="product:price:amount"]') ||
        getMetaContent($, 'meta[itemprop="price"]') ||
        getMetaContent($, 'meta[name="twitter:data1"]');
    const currency =
        getMetaContent($, 'meta[property="product:price:currency"]') ||
        getMetaContent($, 'meta[itemprop="priceCurrency"]');
    if (!amount) return '';
    if (currency) return `${currency} ${amount}`;
    return amount;
};

const getPriceText = ($) =>
    $('[data-buy-box-region="price"]')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();

const getMetaImages = ($) =>
    [
        getMetaContent($, 'meta[property="og:image"]'),
        getMetaContent($, 'meta[property="og:image:secure_url"]'),
        getMetaContent($, 'meta[name="twitter:image"]'),
    ].filter(Boolean);

const isBotBlockPage = (html = '') => {
    const lowered = html.toLowerCase();
    return (
        lowered.includes('not a robot') ||
        lowered.includes('unusual traffic') ||
        lowered.includes('access denied') ||
        lowered.includes('captcha')
    );
};

const extractEtsyProductData = ($, finalUrl) => {
    const jsonLd = findProductJsonLd($);
    const metaTitle =
        getMetaContent($, 'meta[property="og:title"]') || getMetaContent($, 'meta[name="twitter:title"]');
    const title =
        jsonLd?.name ||
        metaTitle ||
        $('h1[data-buy-box-listing-title]').first().text().trim() ||
        $('h1.wt-text-body-03').first().text().trim() ||
        $('h1').first().text().trim();
    const description = (
        jsonLd?.description ||
        getMetaContent($, 'meta[property="og:description"]') ||
        getMetaContent($, 'meta[name="description"]') ||
        ''
    ).trim();
    const images = [
        ...normalizeImages(jsonLd?.image || jsonLd?.images),
        ...getMetaImages($),
    ]
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i)
        .filter((u) => typeof u === 'string' && u.startsWith('http'));
    const price = formatPrice(jsonLd?.offers) || extractMetaPrice($) || getPriceText($);

    return {
        title,
        price,
        image: images[0] || '',
        images,
        description,
        resolvedUrl: finalUrl,
        store: 'Etsy',
    };
};

const scrapeEtsyProduct = async (rawUrl) => {
    const normalizedUrl = await normalizeEtsyProductUrl(rawUrl);
    let browser;
    try {
        const proxyConfig = getProxyConfig();
        const launchArgs = ['--no-sandbox'];
        if (proxyConfig?.server) {
            launchArgs.push(`--proxy-server=${proxyConfig.server}`);
        }
        browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
        const page = await browser.newPage();
        if (proxyConfig?.username && proxyConfig?.password) {
            await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
        }
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => null);
        await wait(1200);
        const html = await page.content();
        const finalUrl = page.url();

        if (isBotBlockPage(html)) {
            throw new Error('Blocked by Etsy anti-bot protection');
        }

        const $ = cheerio.load(html);

        const data = extractEtsyProductData($, finalUrl);
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
            const result = await scrapeEtsyProduct(job.url);
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

const enqueueEtsyScrape = (url) =>
    new Promise((resolve) => {
        scrapeQueue.push({ url, resolve });
        if (!processingQueue) {
            processQueue();
        }
    });

module.exports = {
    enqueueEtsyScrape,
    MAX_BATCH_SIZE,
    resolveShortEtsyUrl,
    getBaseHostname,
    isEtsyHostname,
    isEtsyShortHostname,
};
