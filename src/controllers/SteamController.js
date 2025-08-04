const steamApiUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/?'
const steamStoreUrl = 'https://store.steampowered.com/api/appdetails'

function steamControllerFactory() {
  const getToken = async (req, res) => {
    res.json({ token: '1234567890' });
  };

  function getDetail(req, res) {
    res.json({ detail: '1234567890' });
  }

  async function search(req, res) {
    const { q: query, offset = 0, limit = 50, type } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const result = await steamService.search(query, parseInt(offset), parseInt(limit), type);
    res.json(result);
  }

  return { getToken, getDetail, search };
}

module.exports = steamControllerFactory;