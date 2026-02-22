// api/news.js — add this file to your Vercel proxy project at /api/news.js
// Set GNEWS_API_KEY in your Vercel environment variables (Settings → Environment Variables)

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'focus-app/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GNEWS_API_KEY not set in Vercel environment variables' });
  }

  const category = req.query.category || 'general';
  const allowed = ['general', 'technology', 'business', 'science', 'health', 'sports'];
  if (!allowed.includes(category)) {
    return res.status(400).json({ error: 'Invalid category: ' + category });
  }

  try {
    const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=5&apikey=${apiKey}`;
    const { status, body } = await httpsGet(url);
    if (status !== 200) {
      return res.status(status).json({ error: 'GNews returned ' + status, detail: body.slice(0, 200) });
    }
    const data = JSON.parse(body);
    res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
