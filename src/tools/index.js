// src/tools.js (Example)
async function getCurrentWeather({ location, unit = "celsius" }) {
  console.log(`Tool: Getting weather for ${location} in ${unit}`);
  // In a real app, you'd call a weather API here
  // For demo, we'll return mock data
  if (location.toLowerCase().includes("tokyo")) {
    return JSON.stringify({ location: "Tokyo", temperature: "15", unit: unit, forecast: "Cloudy" });
  } else if (location.toLowerCase().includes("london")) {
    return JSON.stringify({ location: "London", temperature: "8", unit: unit, forecast: "Rainy" });
  } else {
    return JSON.stringify({ location: location, temperature: "22", unit: unit, forecast: "Sunny" });
  }
}

async function getStockPrice({ tickerSymbol }) {
  console.log(`Tool: Getting stock price for ${tickerSymbol}`);
  // In a real app, call a finance API
  if (tickerSymbol.toUpperCase() === 'GOOGL') {
    return JSON.stringify({ ticker: 'GOOGL', price: 2800.50, currency: 'USD' });
  } else {
    return JSON.stringify({ ticker: tickerSymbol, price: Math.random() * 1000, currency: 'USD' });
  }
}

// Map function names (as defined for Gemini) to actual functions
const availableTools = {
  getCurrentWeather,
  getStockPrice,
};

module.exports = availableTools;