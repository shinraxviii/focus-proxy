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
    // Try www.reddit.com first, fall back to old.reddit.com
    const urls = [
      `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}&raw_json=1`,
      `https://old.reddit.com/r/${sub}/hot.json?limit=${limit}&raw_json=1`,
    ];

    let fetched = false;
    for (const url of urls) {
      if (fetched) break;
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': 'web:focus-dashboard:v1.0 (by /u/focusdigest)',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(6000),
        });

        if (r.status === 429) {
          console.error(`[reddit] r/${sub} rate limited at ${url}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        if (!r.ok) {
          console.error(`[reddit] r/${sub} returned ${r.status} at ${url}`);
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
        fetched = true;
      } catch (e) {
        console.error(`[reddit] r/${sub} error at ${url}:`, e.message);
      }
    }

    // Small delay between subreddits to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (allPosts.length === 0) {
    return res.status(502).json({ error: 'No posts fetched from any subreddit' });
  }

  // Sort by score descending, take top 9
  allPosts.sort((a, b) => b.score - a.score);
  const result = allPosts.slice(0, 9).map(({ created, ...rest }) => rest);

  return res.status(200).json(result);
}
