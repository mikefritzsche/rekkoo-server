const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const puppeteer = require('puppeteer');

// --- Import the controller factory function ---
const recipeControllerFactory = require('../controllers/RecipeController');

// --- Export a function that takes socketService ---
module.exports = (socketService) => {
  const router = express.Router(); // Create router inside the function

  // --- Instantiate the controller with the socketService ---
  const recipeController = recipeControllerFactory(socketService);

  router.get('/health', (req, res) => {
    res.json({ message: 'Recipe routes are healthy' });
  });
  
  router.post('/puppeteer-test', async (req, res) => {
    try {
      const testUrl = req.body.url || 'https://www.foodnetwork.com/recipes/bobby-flay/grilled-chicken-breasts-with-spicy-peach-glaze-recipe-1922684';
      // Use the system Chromium installed in the container
      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
  
      const page = await browser.newPage();
      await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
      const title = await page.title();
      // const body = await page.content();
      // image-block-main-image-hover img
      const imageUrl = await page.evaluate(() => {
        // imgTagWrapperId
        // image-block-main-image-hover
        const img = document.querySelector('#imgTagWrapperId img');
        // const img = document.querySelector('.kdp-poster__image');
        return img ? img.src : null;
      });
  
      await browser.close();
      res.json({ url: testUrl, pageTitle: title, imageUrl });
    } catch (err) {
      console.error('Puppeteer test failed:', err);
      res.status(500).json({ error: 'Puppeteer test failed' });
    }

  });

  // Get sync state (pull changes)
  router.post('/scrape', recipeController.scrapeRecipe);
  // router.post('/scrape', authenticateJWT, recipeController.scrapeRecipe);

  return router; // Return the configured router
}; // End export function