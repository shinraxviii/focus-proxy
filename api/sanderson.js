// /api/sanderson — scrape Brandon Sanderson's progress bars and return clean JSON
// Deploy to your existing focus-proxy Vercel project

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await fetch('https://www.brandonsanderson.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FocusDashboard/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error('Sanderson site returned ' + response.status);

    const html = await response.text();

    // The progress section looks like:
    //   BRANDON'S PROGRESS
    //   2%
    //   Mistborn Movie Script
    //   100%
    //   Ghostbloods Book 1 (1.0)
    //   ...
    const progressMatch = html.match(/BRANDON[''\u2019]S\s+PROGRESS([\s\S]*?)(?:<\/section|<img|class="shopify)/i);
    if (!progressMatch) throw new Error('Progress section not found in page HTML');

    const block = progressMatch[1];

    // Strip HTML tags for cleaner parsing
    const text = block.replace(/<[^>]+>/g, '\n');

    // Find percentage + title pairs: "2%\nMistborn Movie Script"
    const pairRegex = /(\d{1,3})%\s*\n\s*([^\n]+)/g;
    const projects = [];
    let m;

    while ((m = pairRegex.exec(text)) !== null) {
      const pct = parseInt(m[1], 10);
      const title = m[2].trim();
      if (title && title.length > 2 && pct >= 0 && pct <= 100) {
        projects.push({ title, pct });
      }
    }

    if (projects.length < 1) throw new Error('No progress items found');

    res.status(200).json({ projects, scraped: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
