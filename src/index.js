const express = require('express');
const db = require('./config/db');
const bcrypt = require('bcrypt');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer')
const saltRounds = 12;
const userRoutes = require('./routes/user.routes');
const claudeRoutes = require('./routes/claude');
const tmdbRoutes = require('./routes/tmdb.routes');
const googleRoutes = require('./routes/google.routes');
const productsRoutes = require('./routes/products.routes');
const imagesRoutes = require('./routes/stock-images.routes');
const spotifyRoutes = require('./routes/spotify.routes');
const authRoutes = require('./routes/auth');
const amazonRoutes = require('./routes/amazon.routes');

// v0.0.2

const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'DELETE', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'X-Random'
  ],
}));
app.use(express.json());

// Routes
app.use('/api/v1.0/users', userRoutes);
app.use('/api/v1.0/claude', claudeRoutes);
app.use('/v1.0/tmdb', tmdbRoutes);
app.use('/v1.0/google', googleRoutes);
app.use('/v1.0/products', productsRoutes);
app.use('/v1.0/images', imagesRoutes);
app.use('/v1.0/spotify', spotifyRoutes);
app.use('/auth', authRoutes);
app.use('/amazon', amazonRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

app.get('/api/v1.0/health', (req, res) => {
  res.json({ status: 'ok', message: 'Rekko Health Check Successful' });
});
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Rekkoo'
  });
});

app.get('/api/v1.0', (req, res) => {
  res.json({ message: 'Welcome to Rekkoo API' });
});

app.get('/gifster-fetch', async (req, res) => {
  try {
    // https%3A%2F%2Fwww.amazon.com%2Fgp%2Fproduct%2FB0718T232Z%2Fref%3Dox_sc_saved_title_3%3Fsmid%3DA30QSGOJR8LMXA%26psc%3D1
    const url = req.query.url // || `https://www.amazon.com/gp/product/B0718T232Z/ref=ox_sc_saved_title_3?smid=A30QSGOJR8LMXA&psc=1`
    const resp = await fetch(`https://www.giftster.com/fetch/?url=${encodeURIComponent(url)}`, {
      "headers": {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Google Chrome\";v=\"133\", \"Chromium\";v=\"133\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"macOS\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
        // "x-csrftoken": "pdIWjZa5oAlO6WOFuHlcV7yhX9T9fQ85",
        "cookie": "_gcl_au=1.1.948493471.1741272541; mobileNavOpen=false; showAddGiftPrefs=true; showAddChildAccount=true; _ga=GA1.1.1903527802.1741272541; cc_cookie=%7B%22categories%22%3A%5B%22necessary%22%2C%22analytics%22%2C%22advertising%22%2C%22education%22%5D%2C%22revision%22%3A0%2C%22data%22%3Anull%2C%22consentTimestamp%22%3A%222025-03-06T14%3A49%3A03.918Z%22%2C%22consentId%22%3A%22ab7877ef-15b9-4b07-89eb-5dd90a8bc0f3%22%2C%22services%22%3A%7B%22necessary%22%3A%5B%5D%2C%22analytics%22%3A%5B%5D%2C%22advertising%22%3A%5B%5D%2C%22education%22%3A%5B%5D%7D%2C%22lastConsentTimestamp%22%3A%222025-03-06T14%3A49%3A03.918Z%22%2C%22expirationTime%22%3A1756997343918%7D; SIGNED_IN=true; csrftoken=pdIWjZa5oAlO6WOFuHlcV7yhX9T9fQ85; sessionid=2kr7jit2z4z4f7q3w6co5ax4cbau0ija; __cf_bm=bNiiqrx9.iWzOP0Gg4Ch1r2PI6oKLlGvVQfVqVy4ar0-1741702694-1.0.1.1-eUQK7tCkZfQPTMrbu3lGTEg7AGfIelS.bobWrCXANizWKhTNT_zuMSqxgwIsaLlA752JT77mfdmmw0X8qgY106rAg720Y2.v5Xj5GXtD_RA; _ga_P78WTYE0QE=GS1.1.1741702682.2.1.1741702730.12.0.1976679405",
        "Referer": "https://www.giftster.com/list/v9hdL/",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      },
      "body": null,
      "method": "GET"
    });
    const data = await resp.json();
    res.json(data);
  } catch(error) {
    console.log(error);
    res.status(500).json({ message: 'Something went wrong!' });
  }
})

app.listen(PORT, () => {
  console.log(`amazon: `, process.env.AMAZON_ACCESS_TOKEN)
  console.log(`Server running on port ${PORT}`);
});
