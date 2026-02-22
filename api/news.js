// api/news.js — add this file to your Vercel proxy project at /api/news.js
// Set GNEWS_API_KEY in your Vercel environment variables (Settings → Environment Variables)

export default async function handler(req, res) {
  // CORS headers — allow your GitHub Pages domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GNEWS_API_KEY not configured in Vercel env vars' });
  }

  const category = req.query.category || 'general';
  const allowed = ['general', 'technology', 'business', 'science', 'health', 'sports'];
  if (!allowed.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  try {
    const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=5&apikey=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'GNews error', detail: text });
    }
    const data = await r.json();
    // Cache at edge for 2 hours
    res.setHeader('Cache-Control', 's-maxage=7200, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
