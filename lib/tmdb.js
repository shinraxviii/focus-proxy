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

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const key = process.env.TMDB_API_KEY;
  if (!key) {
    // Never cache an error, and surface which TMDB-ish env var names this
    // deployment can actually see, to diagnose a name/scope/project mismatch.
    res.setHeader('Cache-Control', 'no-store');
    const seen = Object.keys(process.env).filter(k => /tmdb/i.test(k));
    res.status(500).json({
      error: 'TMDB_API_KEY env var is not set',
      envVarNamesSeen: seen.length ? seen : '(no env var name contains "tmdb")',
    });
    return;
  }

  const region = (req.query && req.query.region) || 'US';

  // Accept either a v3 API key (api_key query param) or a v4 read access
  // token (a JWT, sent as a Bearer header) — tolerate whichever was pasted.
  const isV4 = /^eyJ/.test(key);
  const headers = { Accept: 'application/json' };
  if (isV4) headers.Authorization = 'Bearer ' + key;

  try {
    // Window: US theatrical releases from today → +120 days. We query by
    // release_date (regional) so imminent wide releases are included even when
    // their global "primary" date sits a day or two earlier. Re-releases of
    // old films (which pass this filter but carry a decades-old release_date
    // field) are dropped below by comparing the displayed date to today.
    const now = new Date();
    const gte = now.toISOString().slice(0, 10);
    const lte = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Use /discover ranked by popularity so the list skews to mainstream /
    // anticipated titles rather than tiny or obscure releases. Restricting to
    // theatrical release types (2 = limited, 3 = wide) drops most VOD/festival
    // noise; we relax that filter only if it leaves too few results.
    async function discover(theatricalOnly) {
      const out = [];
      for (let page = 1; page <= 2; page++) {
        const params = new URLSearchParams({
          language: 'en-US',
          region,
          sort_by: 'popularity.desc',
          include_adult: 'false',
          include_video: 'false',
          'release_date.gte': gte,
          'release_date.lte': lte,
          page: String(page),
        });
        if (theatricalOnly) params.set('with_release_type', '2|3');
        let url = `${TMDB}/discover/movie?${params.toString()}`;
        if (!isV4) url += `&api_key=${encodeURIComponent(key)}`;
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('TMDB ' + r.status);
        const data = await r.json();
        if (Array.isArray(data.results)) out.push(...data.results);
        if (page >= (data.total_pages || 1)) break;
      }
      return out;
    }

    let all = await discover(true);
    if (all.length < 6) all = await discover(false);

    // De-dupe. The pool is already TMDB's most-popular upcoming theatrical
    // films; show the 7 SOONEST of them (date order) so imminent big releases
    // always appear rather than being crowded out by higher-popularity films
    // that open months later.
    const seen = new Set();
    const unique = all.filter(m => (m && m.id != null && !seen.has(m.id)) && seen.add(m.id));
    const picked = unique
      // Keep only genuinely-upcoming films: the release_date field is the
      // original date, so re-releases of old films are < today and drop out.
      .filter(m => m.release_date && m.release_date >= gte)
      .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)))
      .slice(0, 7);

    const movies = picked.map(m => ({
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
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'No upcoming movies returned' });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6h CDN cache on success only
    res.status(200).json({ region, movies });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || 'TMDB fetch failed' });
  }
}
