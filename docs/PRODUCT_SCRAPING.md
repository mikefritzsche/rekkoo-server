# Product Scraping Endpoints

## Amazon

- `POST /v1.0/products/scrape`
  - Body: `{ "url": "https://www.amazon.com/..." }`
  - Response: product metadata (title, price, images, description, resolvedUrl)
- `POST /v1.0/products/scrape/batch`
  - Body: `{ "urls": ["https://www.amazon.com/...", "..."] }`
  - Response: `{ results: [{ inputUrl, title, ... } | { inputUrl, error }] }`

## Etsy

- `POST /v1.0/products/scrape/etsy`
  - Body: `{ "url": "https://www.etsy.com/listing/..." }`
  - Response: product metadata (title, price, images, description, resolvedUrl)
- `POST /v1.0/products/scrape/etsy/batch`
  - Body: `{ "urls": ["https://www.etsy.com/listing/...", "..."] }`
  - Response: `{ results: [{ inputUrl, title, ... } | { inputUrl, error }] }`
- Optional proxy: set `ETSY_PROXY_URL` (or `SCRAPER_PROXY_URL`) in server env for anti-bot bypass.
