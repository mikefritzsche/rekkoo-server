const express = require('express');
const router = express.Router();
const axios = require('axios');
const url = require('url');
const amazonSPApi = require('amazon-sp-api');
const SellingPartnerAPI = require('amazon-sp-api');

// Configure the Amazon SP API client
const createSpApiClient = async () => {
  return new SellingPartnerAPI({
    region: 'na', // or EU, FE depending on your marketplace
    refresh_token: process.env.AMAZON_REFRESH_TOKEN,
    credentials: {
      // client_id: process.env.AMAZON_CLIENT_ID,
      // client_secret: process.env.AMAZON_CLIENT_SECRET,
      // access_key: process.env.AMAZON_ACCESS_KEY,
      // secret_key: process.env.AMAZON_SECRET_KEY,
      // role_arn: process.env.AMAZON_ROLE_ARN, // if using IAM Role

      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_CLIENT_SECRET,
      AWS_ACCESS_KEY_ID: process.env.AMAZON_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AMAZON_SECRET_KEY,
      // AWS_SELLING_PARTNER_ROLE: process.env.AMAZON_ROLE_ARN,
    },
    options: {
      use_sandbox: false  // This is critical to use the sandbox environment
    }
  });
};

router.get('/get-endpoints', async (req, res) => {
  const spApi = await createSpApiClient();
  const operations = Object.keys(spApi).filter(key => typeof spApi[key] === 'function')
  const endpoints = spApi.endpoints || 'Not directly accessible'
  res.json({operations, endpoints})
})
router.get('/get-asin', async (req, res) => {
  res.json({asin: extractAsinFromUrl(req.query.url)})
})

router.get('/test-api-connection', async (req, res) => {
  try {
    const spApi = await createSpApiClient();
    const result = await spApi.callAPI({
      operation: 'getMarketplaceParticipations',
      endpoint: 'sellers'
    });
    console.log('API call successful:', result);
    res.json(result);
  } catch (error) {
    console.log(`Test API call failed: `, )
    res.status(500).json({message: 'Test API call failed', error})
  }
})
// Helper function to extract ASIN from Amazon URL
const extractAsinFromUrl = (amazonUrl) => {
  try {
    // Check if the input is already an ASIN (10 characters, alphanumeric)
    if (/^[A-Z0-9]{10}$/.test(amazonUrl)) {
      return amazonUrl;
    }

    // Parse the URL
    const parsedUrl = url.parse(amazonUrl, true);

    // Check if it's an Amazon domain
    if (!parsedUrl.hostname || !parsedUrl.hostname.includes('amazon')) {
      return null;
    }

    // Extract ASIN from the path
    const pathSegments = parsedUrl.pathname.split('/');

    // Try to find ASIN in common locations
    let asin = null;

    // Check for /dp/ASIN or /gp/product/ASIN pattern
    for (let i = 0; i < pathSegments.length; i++) {
      if ((pathSegments[i] === 'dp' || pathSegments[i] === 'product') && i + 1 < pathSegments.length) {
        asin = pathSegments[i + 1];
        break;
      }
    }

    // Check for ASIN in query parameters
    if (!asin && parsedUrl.query.ASIN) {
      asin = parsedUrl.query.ASIN;
    }

    // Validate ASIN format (10 characters, alphanumeric)
    if (asin && /^[A-Z0-9]{10}$/.test(asin)) {
      return asin;
    }

    return null;
  } catch (error) {
    console.error('Error extracting ASIN from URL:', error);
    return null;
  }
};

router.get('/get-access-token', async (req, res) => {
  const getAccessToken = async () => {
    const clientId = process.env.AMAZON_CLIENT_ID;
    const clientSecret = process.env.AMAZON_CLIENT_SECRET;
    const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

    try {
      const response = await axios.post("https://api.amazon.com/auth/o2/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });

      return response.data.access_token;
    } catch (error) {
      console.error("❌ Error getting access token:", error.response?.data || error.message);
      return null;
    }
  };

// Test access token retrieval
  getAccessToken().then((token) => {
    console.log("✅ Access Token:", token)
    res.json({token})
  });

})

// Get inventory levels
router.get('/inventory', async (req, res) => {
  try {
    const spApi = await createSpApiClient();

    // Call the FBA Inventory API
    const inventory = await spApi.callAPI({
      operation: 'getInventorySummaries',
      endpoint: 'fba/inventory/v1',
      query: {
        details: true,
        granularityType: 'Marketplace',
        granularityId: process.env.AMAZON_MARKETPLACE_ID,
      }
    });

    res.json(inventory.inventorySummaries || []);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error, message: 'Failed to fetch inventory data' });
  }
});

// Get orders
router.get('/orders', async (req, res) => {
  try {
    const spApi = await createSpApiClient();
    const { createdAfter, orderStatus } = req.query;

    // Call the Orders API
    const orders = await spApi.callAPI({
      operation: 'getOrders',
      endpoint: 'orders/v0',
      query: {
        MarketplaceIds: process.env.AMAZON_MARKETPLACE_ID,
        CreatedAfter: createdAfter || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        OrderStatuses: orderStatus ? [orderStatus] : ['Shipped', 'Unshipped', 'PartiallyShipped'],
      }
    });

    res.json(orders.Orders || []);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch order data' });
  }
});

// Update product price
router.post('/products/price', async (req, res) => {
  try {
    const { productId, price } = req.body;

    if (!productId || !price) {
      return res.status(400).json({ error: 'Product ID and price are required' });
    }

    const spApi = await createSpApiClient();

    // Call the Pricing API to update the price
    const result = await spApi.callAPI({
      operation: 'submitPricingRequest',
      endpoint: 'pricing/v0',
      body: {
        marketplaceId: process.env.AMAZON_MARKETPLACE_ID,
        requests: [
          {
            sellerSKU: productId,
            priceToEstimateFees: {
              listingPrice: {
                currencyCode: 'USD', // adjust based on your marketplace
                amount: price
              }
            }
          }
        ]
      }
    });

    res.json(result);
  } catch (error) {
    console.error('Error updating price:', error);
    res.status(500).json({ error: 'Failed to update product price' });
  }
});

// Search for products
router.get('/products/search', async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const spApi = await createSpApiClient();

    // Call the Product Search API
    const searchResults = await spApi.callAPI({
      operation: 'searchCatalogItems',
      endpoint: 'catalogItems', // Notice the format
      query: {
        keywords: query,
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
        includedData: ['attributes', 'identifiers', 'images', 'productTypes', 'salesRanks', 'summaries']
      }
    });
    console.log(`searchResults: `, searchResults)

    // Transform the results to a more user-friendly format
    const formattedResults = (searchResults.items || []).map(item => {
      const asin = item.identifiers?.marketplaceASIN?.asin || '';
      const title = item.summaries?.[0]?.itemName || 'Unknown Product';
      const imageUrl = item.images?.[0]?.images?.[0]?.link || '';
      const price = item.summaries?.[0]?.price?.amount?.toString() || 'N/A';
      const currency = item.summaries?.[0]?.price?.currency || 'USD';

      return {
        asin,
        title,
        imageUrl,
        price: `${currency} ${price}`,
        brand: item.summaries?.[0]?.brandName || 'Unknown Brand'
      };
    });

    res.json(formattedResults);
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ query: req.query.query, error });
  }
});

// Get product info from URL or ASIN
router.get('/products/info', async (req, res) => {
  try {
    const { productInput } = req.query;

    if (!productInput) {
      return res.status(400).json({ error: 'Product URL or ASIN is required' });
    }

    // Extract ASIN from URL if needed
    const asin = extractAsinFromUrl(productInput);

    if (!asin) {
      return res.status(400).json({ error: 'Invalid Amazon URL or ASIN' });
    }

    const spApi = await createSpApiClient();

    // Call the Catalog Items API to get product details
    const productDetails = await spApi.callAPI({
      operation: 'getCatalogItem',
      endpoint: 'catalog/2022-04-01',
      path: {
        asin: asin
      },
      query: {
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
        includedData: ['attributes', 'identifiers', 'images', 'productTypes', 'salesRanks', 'summaries']
      }
    });

    // Format the product details
    const item = productDetails;
    const formattedProduct = {
      asin: asin,
      title: item.summaries?.[0]?.itemName || 'Unknown Product',
      imageUrl: item.images?.[0]?.images?.[0]?.link || '',
      price: item.summaries?.[0]?.price?.amount ?
        `${item.summaries[0].price.currency || 'USD'} ${item.summaries[0].price.amount}` :
        'N/A',
      brand: item.summaries?.[0]?.brandName || 'Unknown Brand',
      category: item.productTypes?.[0]?.productType || 'Unknown Category',
      features: item.attributes?.bullet_point?.value || []
    };

    res.json(formattedProduct);
  } catch (error) {
    console.error('Error getting product info:', error);
    res.status(500).json({ error, message: 'Failed to get product information' });
  }
});

// Generate affiliate link
router.get('/affiliate/link', async (req, res) => {
  try {
    const { asin } = req.query;

    if (!asin) {
      return res.status(400).json({ error: 'ASIN is required' });
    }

    // Create the affiliate link using your tracking ID
    const affiliateTrackingId = process.env.AMAZON_ASSOCIATE_ID; // e.g., 'yourassociateid-20'

    if (!affiliateTrackingId) {
      return res.status(500).json({ error: 'Amazon Associate ID is not configured' });
    }

    // Create the affiliate URL
    // Format: https://www.amazon.com/dp/ASIN?tag=YOUR-ASSOCIATE-ID
    const baseUrl = process.env.AMAZON_DOMAIN || 'https://www.amazon.com';
    const affiliateUrl = `${baseUrl}/dp/${asin}?tag=${affiliateTrackingId}`;

    res.json({
      asin,
      affiliateUrl,
      trackingId: affiliateTrackingId
    });
  } catch (error) {
    console.error('Error generating affiliate link:', error);
    res.status(500).json({ error: 'Failed to generate affiliate link' });
  }
});

module.exports = router;