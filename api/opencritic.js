// Vercel serverless function: /api/opencritic
// Fetches top-rated recent games from OpenCritic API via RapidAPI
// Requires RAPIDAPI_KEY env var (free tier: 25 req/day — we only need 1-2)
// Refreshes daily, returns top 7 games sorted by score

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });
  }

  const games = [];

  try {
    // Fetch the "Hall of Fame" recent games (sorted by score, last 90 days)
    const url = 'https://opencritic-api.p.rapidapi.com/game?platforms=all&sort=score&skip=0&order=desc';
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'opencritic-api.p.rapidapi.com',
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('OpenCritic API returned ' + response.status);
    const data = await response.json();

    // Platform ID mapping
    const PLATFORMS = {
      2: 'PS5', 3: 'XSX', 6: 'PC', 7: 'SW2', 11: 'PS4',
      32: 'XB1', 36: 'Switch', 46: 'SW2',
    };

    // Genre mapping
    const GENRE_MAP = {
      'action': 'Action', 'adventure': 'Adventure', 'rpg': 'RPG',
      'shooter': 'Shooter', 'strategy': 'Strategy', 'simulation': 'Sim',
      'horror': 'Horror', 'puzzle': 'Puzzle', 'platformer': 'Platformer',
      'racing': 'Racing', 'sports': 'Sports', 'fighting': 'Fighting',
      'roguelike': 'Roguelike', 'survival': 'Survival', 'indie': 'Indie',
    };

    for (const g of data.slice(0, 15)) {
      // Skip games with no score yet
      if (!g.topCriticScore || g.topCriticScore < 0) continue;

      // Get release date
      const rd = g.firstReleaseDate ? new Date(g.firstReleaseDate) : null;
      const now = new Date();
      const ageMs = rd ? now - rd : Infinity;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      // Only include games from last 90 days or upcoming
      if (ageDays > 90) continue;

      // Map platforms
      const platforms = [];
      if (g.Platforms) {
        for (const p of g.Platforms) {
          const mapped = PLATFORMS[p.id] || PLATFORMS[p.shortName] || null;
          if (mapped && !platforms.includes(mapped)) platforms.push(mapped);
        }
      }

      // Extract primary genre from Genres array
      let genre = '';
      if (g.Genres && g.Genres.length > 0) {
        const genreName = g.Genres[0].name?.toLowerCase() || '';
        genre = GENRE_MAP[genreName] || g.Genres[0].name || '';
      }

      // Format date
      let dateStr = '';
      if (rd) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        dateStr = months[rd.getMonth()] + ' ' + rd.getDate();
      }

      games.push({
        title: g.name,
        score: Math.round(g.topCriticScore),
        userScore: g.userScore && g.userScore > 0 ? parseFloat((g.userScore / 10).toFixed(1)) : null,
        genre: genre,
        platforms: platforms.length > 0 ? platforms : ['Multi'],
        date: dateStr,
        url: 'https://opencritic.com/game/' + g.id + '/' + encodeSlug(g.name),
      });

      if (games.length >= 7) break;
    }
  } catch (e) {
    console.error('OpenCritic fetch error:', e);
    return res.status(500).json({ error: e.message });
  }

  // Cache for 24 hours
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
  return res.status(200).json(games);
}

function encodeSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
