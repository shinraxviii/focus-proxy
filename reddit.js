// Vercel serverless function: /api/reddit
// Fetches hot posts from specified subreddits via Reddit's public .json endpoint

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const subsParam = req.query.subs || 'mtg,cosmere,SorceryTCG';
  const subs = subsParam.split(',').map(s => s.trim()).filter(Boolean);
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);

  const allPosts = [];

  for (const sub of subs) {
    try {
      // Use oauth-less JSON endpoint with minimal headers
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=${limit}&raw_json=1`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const r = await fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!r.ok) {
        console.error(`[reddit] r/${sub} returned ${r.status}`);
        continue;
      }

      const data = await r.json();
      const children = data?.data?.children || [];

      for (const child of children) {
        const p = child.data;
        if (p.stickied || p.promoted) continue;

        allPosts.push({
          title: p.title,
          sub: 'r/' + p.subreddit,
          score: p.score || 0,
          comments: p.num_comments || 0,
          url: 'https://reddit.com' + p.permalink,
          created: p.created_utc || 0,
        });
      }
    } catch (e) {
      console.error(`[reddit] r/${sub} error:`, e.message);
    }

    // Delay between subreddits to avoid rate limits
    if (subs.indexOf(sub) < subs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (allPosts.length === 0) {
    return res.status(502).json({ error: 'No posts fetched from any subreddit' });
  }

  // Sort by score descending, take top 9
  allPosts.sort((a, b) => b.score - a.score);
  const result = allPosts.slice(0, 9).map(({ created, ...rest }) => rest);

  return res.status(200).json(result);
}
