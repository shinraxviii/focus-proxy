// Vercel serverless function: /api/reddit
// Fetches hot posts from specified subreddits via Reddit's public .json endpoint
// No API key needed — just a custom User-Agent

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const subsParam = req.query.subs || 'mtg,cosmere,SorceryTCG';
  const subs = subsParam.split(',').map(s => s.trim()).filter(Boolean);
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);

  const allPosts = [];

  for (const sub of subs) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}&raw_json=1`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'FocusDashboard/1.0 (by /u/focusapp)',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!r.ok) {
        console.error(`[reddit] r/${sub} returned ${r.status}`);
        continue;
      }

      const data = await r.json();
      const children = data?.data?.children || [];

      for (const child of children) {
        const p = child.data;
        // Skip stickied/pinned posts and ads
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
  }

  if (allPosts.length === 0) {
    return res.status(502).json({ error: 'No posts fetched from any subreddit' });
  }

  // Sort by score descending, take top 8
  allPosts.sort((a, b) => b.score - a.score);
  const result = allPosts.slice(0, 8).map(({ created, ...rest }) => rest);

  return res.status(200).json(result);
}
