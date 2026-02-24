// /api/fever — scrape Fever LA top-10 events and return clean JSON
// Deploy to your existing focus-proxy Vercel project

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await fetch('https://feverup.com/en/los-angeles/top-10', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FocusDashboard/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error('Fever returned ' + response.status);

    const html = await response.text();

    // Parse event cards: <a> tags linking to /m/{id} with title attrs and inner h3
    // Structure: <a href="/m/500549" title="Event Name - Venue">...<h3>Event Name</h3>...rating...date...price...</a>
    const events = [];
    const seen = new Set();

    // Match anchor tags with /m/ links that contain h3 titles
    const linkRegex = /<a[^>]*href="[^"]*\/m\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const id = match[1];
      if (seen.has(id)) continue;

      const block = match[2];
      const anchor = match[0];

      // Extract title from <h3>
      const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      if (!h3Match) continue;
      const name = h3Match[1].replace(/<[^>]+>/g, '').trim();
      if (!name || name.length < 5) continue;

      // Extract venue from title attribute
      const titleAttr = anchor.match(/title="([^"]*)"/i);
      let venue = '';
      if (titleAttr) {
        const parts = titleAttr[1].split(' - ');
        if (parts.length > 1) venue = parts[parts.length - 1].trim();
      }

      // Extract rating (e.g. "4.7")
      let rating = '';
      const ratingMatch = block.match(/([\d]\.[\d])\s*(?:\n|\s)*\(/);
      if (ratingMatch) rating = ratingMatch[1];

      // Extract date range
      let date = '';
      const dateMatch = block.match(/(\d{1,2}\s+\w{3}\s*[-–]\s*\d{1,2}\s+\w{3})/i);
      if (dateMatch) date = dateMatch[1].trim();

      // Extract price
      let price = '';
      const priceMatch = block.match(/(?:From\s+)?\$[\d,.]+/i);
      if (priceMatch) price = priceMatch[0].trim();

      seen.add(id);
      events.push({ name, venue, date, price, rating, id });

      if (events.length >= 10) break;
    }

    res.status(200).json({ events, scraped: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
