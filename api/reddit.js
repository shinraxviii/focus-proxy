// Vercel serverless function: /api/reddit
// Fetches hot posts from specified subreddits via Reddit's public RSS feeds

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const subsParam = req.query.subs || 'mtg,cosmere,SorceryTCG';
  const subs = subsParam.split(',').map(s => s.trim()).filter(Boolean);

  const allPosts = [];

  for (const sub of subs) {
    try {
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const r = await fetch(url, {
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!r.ok) {
        console.error(`[reddit-rss] r/${sub} returned ${r.status}`);
        continue;
      }

      const xml = await r.text();

      // Parse RSS entries using regex (no DOM parser in edge runtime)
      const entries = xml.split('<entry>').slice(1); // skip feed header

      for (const entry of entries) {
        const title = decodeXml(between(entry, '<title>', '</title>') || '');
        const link = between(entry, '<link href="', '"') || '';
        const updated = between(entry, '<updated>', '</updated>') || '';

        // Skip empty titles
        if (!title) continue;

        allPosts.push({
          title,
          sub: 'r/' + sub,
          url: link,
          time: updated ? new Date(updated).getTime() : 0,
        });
      }
    } catch (e) {
      console.error(`[reddit-rss] r/${sub} error:`, e.message);
    }

    // Delay between subreddits
    if (subs.indexOf(sub) < subs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  if (allPosts.length === 0) {
    return res.status(502).json({ error: 'No posts fetched from any subreddit' });
  }

  // Sort by most recent first, take top 9
  allPosts.sort((a, b) => b.time - a.time);
  return res.status(200).json(allPosts.slice(0, 9));
}

function between(str, start, end) {
  const i = str.indexOf(start);
  if (i === -1) return '';
  const j = str.indexOf(end, i + start.length);
  if (j === -1) return '';
  return str.substring(i + start.length, j);
}

function decodeXml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
