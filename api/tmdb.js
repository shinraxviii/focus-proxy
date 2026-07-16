// api/tmdb.js — Upcoming movies from The Movie Database (TMDB).
// The API key is read server-side from the TMDB_API_KEY env var and never
// reaches the client. Docs: https://developer.themoviedb.org/reference/movie-upcoming-list

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

// Stable TMDB genre id → name map (avoids an extra /genre/movie/list call)
const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6h CDN cache

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const key = process.env.TMDB_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'TMDB_API_KEY env var is not set' });
    return;
  }

  const region = (req.query && req.query.region) || 'US';

  // Accept either a v3 API key (api_key query param) or a v4 read access
  // token (a JWT, sent as a Bearer header) — tolerate whichever was pasted.
  const isV4 = /^eyJ/.test(key);
  const headers = { Accept: 'application/json' };
  if (isV4) headers.Authorization = 'Bearer ' + key;

  try {
    // Pull the first two pages of upcoming releases for a fuller list.
    const all = [];
    let windowMin = null, windowMax = null;
    for (let page = 1; page <= 2; page++) {
      let url = `${TMDB}/movie/upcoming?language=en-US&region=${encodeURIComponent(region)}&page=${page}`;
      if (!isV4) url += `&api_key=${encodeURIComponent(key)}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('TMDB ' + r.status);
      const data = await r.json();
      if (Array.isArray(data.results)) all.push(...data.results);
      if (data.dates) { windowMin = data.dates.minimum || windowMin; windowMax = data.dates.maximum || windowMax; }
      if (page >= (data.total_pages || 1)) break;
    }

    // De-dupe by id (pages shouldn't overlap, but be safe)
    const seen = new Set();
    const unique = all.filter(m => (m && m.id != null && !seen.has(m.id)) && seen.add(m.id));

    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const byDate = (a, b) => String(a.release_date).localeCompare(String(b.release_date));

    // "Upcoming" = release date inside TMDB's returned window; degrade
    // gracefully to future-dated, then to any dated result, so the card is
    // never wrongly emptied when the API actually returned movies.
    const inWindow = (m) => m.release_date
      && (!windowMin || m.release_date >= windowMin)
      && (!windowMax || m.release_date <= windowMax);
    let picked = unique.filter(inWindow).sort(byDate);
    if (picked.length < 5) picked = unique.filter(m => m.release_date && m.release_date >= today).sort(byDate);
    if (!picked.length) picked = unique.filter(m => m.release_date).sort(byDate);

    const movies = picked.slice(0, 15).map(m => ({
      id: m.id,
      title: m.title || m.original_title || 'Untitled',
      release: m.release_date || '',
      poster: m.poster_path ? IMG + m.poster_path : '',
      rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      genre: (m.genre_ids || []).map(id => GENRES[id]).filter(Boolean)[0] || '',
      overview: m.overview || '',
      link: 'https://www.themoviedb.org/movie/' + m.id
    }));

    if (!movies.length) {
      res.status(502).json({ error: 'No upcoming movies returned' });
      return;
    }

    res.status(200).json({ region, movies });
  } catch (e) {
    res.status(502).json({ error: e.message || 'TMDB fetch failed' });
  }
}
