// /api/fpi — ESPN Football Power Index (FPI) relay for one college team
//
// Backs the SOS / Remaining SOS / FPI tiles on the Focus app's Cal Football
// card. The app reads ESPN's power index straight from the browser first and
// only calls this when that fails, so this is a thin, cached CORS relay: it
// tries ESPN's power-index endpoints in order and returns the first payload
// that contains the team, trimmed to that team. The app does the parsing, so
// both paths share one parser.
//
//   GET /api/fpi?season=2026[&team=25]
//   -> { source: <upstream url>, data: <ESPN payload trimmed to the team> }

const DEFAULT_TEAM = '25'; // California Golden Bears
const UA = 'Mozilla/5.0 (compatible; FocusDashboard/1.0)';

function candidates(season, team) {
  const cfb = 'football/college-football';
  return [
    // FPI page feed: all teams with categories (fpi, projections, résumé/sos …)
    `https://site.web.api.espn.com/apis/fitt/v3/sports/${cfb}/powerindex?region=us&lang=en&contentorigin=espn&limit=200&season=${season}`,
    // Core API, per-team power index (two path forms seen in the wild)
    `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/teams/${team}/powerindex?lang=en&region=us`,
    `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/powerindex/${team}?lang=en&region=us`,
  ];
}

function teamIdOf(entry) {
  const t = entry?.team || {};
  const ref = typeof t.$ref === 'string' ? t.$ref : '';
  const m = ref.match(/\/teams\/(\w+)/);
  return String(t.id ?? (m ? m[1] : ''));
}

// Trim a payload to the requested team. Returns null if the team isn't there.
function trim(payload, team) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.teams)) {
    const hit = payload.teams.find((e) => teamIdOf(e) === String(team));
    if (!hit) return null;
    return { categories: payload.categories || [], teams: [hit] };
  }
  if (Array.isArray(payload.stats)) {
    const id = teamIdOf(payload);
    if (id && id !== String(team)) return null;
    return { team: payload.team || { id: String(team) }, stats: payload.stats };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // FPI moves once a week after games; an hour of CDN cache is plenty.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const team = /^[a-z0-9]{1,8}$/i.test(String(q.team || '')) ? String(q.team) : DEFAULT_TEAM;
  const seasonNum = parseInt(q.season, 10);
  const season = Number.isInteger(seasonNum) && seasonNum >= 2000 && seasonNum <= 2100 ? seasonNum : null;
  if (!season) return res.status(400).json({ error: 'season query param required, e.g. ?season=2026' });

  const errors = [];
  for (const url of candidates(season, team)) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) { errors.push(url + ' -> ' + r.status); continue; }
      const data = trim(await r.json(), team);
      if (!data) { errors.push(url + ' -> team not in payload'); continue; }
      return res.status(200).json({ source: url, season, team, data, fetched: new Date().toISOString() });
    } catch (e) {
      errors.push(url + ' -> ' + (e.message || 'fetch failed'));
    }
  }
  res.status(502).json({ error: 'No FPI payload available', tried: errors });
}
