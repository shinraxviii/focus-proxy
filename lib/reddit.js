// Vercel serverless function: /api/reddit
// Fetches hot posts from specified subreddits via Reddit's public RSS feeds

// Reddit rate-limits anonymous requests by IP *and* User-Agent. Requests with
// no UA (or a generic library default) share one heavily-throttled bucket, so
// from a datacenter IP only the first sub in a batch tends to get through and
// the rest come back 429. A unique, descriptive UA gives us our own bucket.
const REDDIT_UA = 'focus-app/1.0 (personal MTG/TCG digest reader; +https://github.com/shinraxviii/focus-app)';

// Fetch a subreddit feed, retrying once on a transient throttle (429/503).
async function fetchFeed(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': REDDIT_UA,
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (r.ok) return r;
      // Retry only transient throttling responses, honoring Retry-After if given
      if (attempt === 0 && (r.status === 429 || r.status === 503)) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '', 10);
        const waitMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 2000) : 800;
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      return r; // non-retryable status — let the caller log and skip
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

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
      const r = await fetchFeed(url);

      if (!r || !r.ok) {
        console.error(`[reddit-rss] r/${sub} returned ${r ? r.status : 'no response'}`);
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

    // Space out requests so a burst from one IP doesn't trip Reddit's throttle
    if (subs.indexOf(sub) < subs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (allPosts.length === 0) {
    return res.status(502).json({ error: 'No posts fetched from any subreddit' });
  }

  // Keep the most recent posts *per sub* rather than a single global top-N, so a
  // high-volume subreddit (e.g. r/mtg) can't crowd every other sub out of the
  // response. The client does its own round-robin + per-sub caps for display.
  const PER_SUB = 6;
  const bySub = {};
  for (const p of allPosts) {
    if (!bySub[p.sub]) bySub[p.sub] = [];
    bySub[p.sub].push(p);
  }
  const trimmed = [];
  for (const sub of Object.keys(bySub)) {
    bySub[sub].sort((a, b) => b.time - a.time);
    for (const p of bySub[sub].slice(0, PER_SUB)) trimmed.push(p);
  }

  // Sort the combined set by most recent first for a sensible default order
  trimmed.sort((a, b) => b.time - a.time);
  return res.status(200).json(trimmed);
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
