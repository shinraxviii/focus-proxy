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
//   -> { source: <upstream url>, data: { team, season, predictives: [stat…], efficiencies: [stat…] } }
//   where stat = { name, abbreviation, displayName, value, displayValue, description }

const DEFAULT_TEAM = '25'; // California Golden Bears
const UA = 'Mozilla/5.0 (compatible; FocusDashboard/1.0)';

function candidates(season, team) {
  const base = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/powerindex`;
  return [
    // One team's power index: { team, season, predictives: [stat…], efficiencies: [stat…] }
    `${base}/${team}?lang=en&region=us`,
    // League-wide list: { items: [ { team, predictives, efficiencies } … ] }
    `${base}?limit=200&lang=en&region=us`,
  ];
}

function teamIdOf(entry) {
  const t = entry?.team || {};
  const ref = typeof t.$ref === 'string' ? t.$ref : '';
  const m = ref.match(/\/teams\/(\w+)/);
  return String(t.id ?? (m ? m[1] : ''));
}

// Trim a payload to the requested team, keeping every stat group ESPN sends
// (predictives, efficiencies, and any others) so the app's parser sees all
// of them. Returns null if the team isn't there.
function trim(payload, team) {
  if (!payload || typeof payload !== 'object') return null;
  const isEntry = (e) => e && typeof e === 'object' && Object.values(e).some((v) => Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && ('value' in v[0] || 'displayValue' in v[0]));
  let entry = payload;
  if (Array.isArray(payload.items)) entry = payload.items.find((e) => teamIdOf(e) === String(team)) || null;
  if (!isEntry(entry)) return null;
  const id = teamIdOf(entry);
  if (id && id !== String(team)) return null;
  const out = { team: entry.team || { id: String(team) }, season: entry.season };
  Object.keys(entry).forEach((k) => { if (k !== '$ref' && k !== 'team' && k !== 'season' && typeof entry[k] !== 'string') out[k] = entry[k]; });
  return out;
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
