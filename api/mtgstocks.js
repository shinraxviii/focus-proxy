// Vercel Serverless Function: /api/mtgstocks
// Proxies sealed product price data from api.mtgstocks.com
// Usage: GET /api/mtgstocks?ids=5941,6243,8894,4496,7199

const ALLOWED_IDS = new Set(['5941', '6243', '8894', '4496', '7199']);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.mtgstocks.com/',
  'Origin': 'https://www.mtgstocks.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

async function fetchSealedPrices(id) {
  const url = `https://api.mtgstocks.com/sealed/${id}/prices`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`MTGStocks ${res.status} for sealed/${id}`);
  return res.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const idsParam = req.query.ids || '';
  const ids = idsParam.split(',').filter(id => ALLOWED_IDS.has(id.trim()));

  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid ids provided. Use ?ids=5941,6243,8894,4496,7199' });
  }

  try {
    const results = {};
    const fetches = ids.map(async (id) => {
      try {
        const data = await fetchSealedPrices(id);
        // data is expected to have price category keys (e.g. "average", "market", "low", "high")
        // each containing arrays of [timestamp_ms, price] tuples
        // Prefer market price, fall back to average
        const category = data.market || data.average || data.low || Object.values(data)[0] || [];
        const history = category.map(pt => pt[1]); // just the price values
        const price = history.length > 0 ? history[history.length - 1] : null;
        results[id] = { price, history };
      } catch (e) {
        console.error(`Failed to fetch sealed/${id}:`, e.message);
        results[id] = { error: e.message };
      }
    });

    await Promise.all(fetches);

    // Cache for 6 hours
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.status(200).json(results);
  } catch (e) {
    console.error('MTGStocks proxy error:', e);
    return res.status(500).json({ error: 'Internal proxy error' });
  }
}
