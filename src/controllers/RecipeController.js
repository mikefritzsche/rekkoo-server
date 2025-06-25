const recipeScraper = require('@brandonrjguth/recipe-scraper');

function recipeControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  const scrapeRecipe = async (req, res) => {
    const { url } = req.body;
    try {
      const recipe = await recipeScraper(url);
      res.json(recipe);
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  };

  return {
    scrapeRecipe
  };
}

module.exports = recipeControllerFactory; 