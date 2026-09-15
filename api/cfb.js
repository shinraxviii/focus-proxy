// /api/cfb — college football team schedule + scores + betting lines
//
// Used by the Focus app's "Cal Football" schedule card. Pulls the team's
// season schedule from ESPN's public site API, then enriches every game with
// the point spread / over-under from ESPN's core odds API (which keeps the
// closing line on completed games, so past results can show whether the
// team covered). Returns one clean JSON payload the app renders directly.
//
//   GET /api/cfb?season=2026            -> Cal (ESPN team id 25), 2026 season
//   GET /api/cfb?season=2027&team=25    -> explicit team id
//
// Rolling the card to a new year needs NO change here: the app passes the
// season it wants. (CAL_FOOTBALL_SEASON in focus-app/index.html.)
//
// Response shape:
//   {
//     season: 2026, seasonLabel: '2026', team: { id, name, abbrev, logo, record },
//     games: [{
//       id, week, date (ISO), timeValid, state: 'pre'|'in'|'post', completed,
//       detail: 'Final' | '12:30 - 3rd' | '',   // ESPN short status text
//       home: true, neutral: false,
//       opponent: { id, name, abbrev, logo, rank, record },
//       venue: { name, city, state },
//       broadcast: 'ESPN' | '',
//       score: { us: 31, them: 17 } | null,
//       result: 'W' | 'L' | null,
//       odds: { line: -3.5, details: 'CAL -3.5', overUnder: 52.5, provider: 'ESPN BET',
//               cover: 'covered' | 'lost' | 'push' | null } | null,
//       url: 'https://www.espn.com/college-football/game/_/gameId/…'
//     }]
//   }

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';
const DEFAULT_TEAM = '25'; // California Golden Bears
const UA = 'Mozilla/5.0 (compatible; FocusDashboard/1.0)';

// Odds providers in order of preference (ESPN BET first, then the usual books).
const PROVIDER_PREF = ['58', '2000', '45', '31', '41', '25'];

async function getJSON(url, timeoutMs) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs || 6000),
  });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function scoreOf(c) {
  // Schedule endpoint: score is { value, displayValue }; scoreboard: a string.
  if (c && c.score && typeof c.score === 'object') return num(c.score.value ?? c.score.displayValue);
  return num(c && c.score);
}

// Pick the best odds item from a core-API odds response.
function pickOdds(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const rank = (o) => {
    const id = String(o?.provider?.id ?? '');
    const i = PROVIDER_PREF.indexOf(id);
    return (i === -1 ? PROVIDER_PREF.length : i) * 100 + (num(o?.provider?.priority) ?? 50);
  };
  return items.slice().sort((a, b) => rank(a) - rank(b))[0];
}

// Turn an ESPN odds item into a line relative to OUR team
// (negative = we are favored, positive = we are the underdog, 0 = pick'em).
function normalizeOdds(o, ourAbbrev, oppAbbrev, weAreHome) {
  if (!o) return null;
  let line = null;
  const details = typeof o.details === 'string' ? o.details.trim() : '';

  // 1) "CAL -3.5" / "STAN -7" / "EVEN" — names the favorite explicitly.
  const m = details.match(/^([A-Z&' .]+?)\s+([+-]?\d+(?:\.\d+)?)$/i);
  if (m) {
    const fav = m[1].trim().toUpperCase();
    const mag = Math.abs(parseFloat(m[2]));
    if (fav === String(ourAbbrev).toUpperCase()) line = -mag;
    else if (fav === String(oppAbbrev).toUpperCase()) line = mag;
  } else if (/^(EVEN|PK|PICK)/i.test(details)) {
    line = 0;
  }

  // 2) Fallback: numeric spread is expressed for the HOME team.
  if (line === null) {
    let spread = num(o.spread);
    if (spread === null) {
      const ps = o.pointSpread?.home;
      spread = num(ps?.close?.line) ?? num(ps?.current?.line) ?? num(ps?.open?.line);
    }
    if (spread !== null) line = weAreHome ? spread : -spread;
  }

  const overUnder = num(o.overUnder) ?? num(o.total?.close?.line) ?? num(o.total?.current?.line);
  if (line === null && overUnder === null) return null;

  return {
    line,
    details: details || (line === null ? '' : (line === 0 ? 'EVEN' : (line < 0 ? ourAbbrev : oppAbbrev) + ' -' + Math.abs(line))),
    overUnder,
    provider: o.provider?.name || '',
    cover: null, // filled in once we know the final score
  };
}

function coverResult(line, us, them) {
  if (line === null || us === null || them === null) return null;
  const margin = us - them + line; // e.g. win by 7 at -3.5 -> +3.5 (covered)
  if (margin > 0) return 'covered';
  if (margin < 0) return 'lost';
  return 'push';
}

function normalizeEvent(ev, teamId) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const us = (comp.competitors || []).find((c) =>
    String(c.id) === String(teamId) || String(c.team?.id) === String(teamId));
  const them = (comp.competitors || []).find((c) => c !== us);
  if (!us || !them) return null;

  const st = comp.status?.type || {};
  const state = st.state === 'in' ? 'in' : (st.completed || st.state === 'post') ? 'post' : 'pre';
  const usScore = scoreOf(us);
  const themScore = scoreOf(them);
  const hasScore = state !== 'pre' && usScore !== null && themScore !== null;
  const rank = num(them.curatedRank?.current);
  const venue = comp.venue || {};

  let result = null;
  if (state === 'post') {
    if (us.winner === true) result = 'W';
    else if (us.winner === false) result = 'L';
    else if (hasScore && usScore !== themScore) result = usScore > themScore ? 'W' : 'L';
  }

  return {
    id: String(ev.id),
    week: num(ev.week?.number ?? ev.week) ,
    seasonType: num(ev.seasonType?.type) ?? 2,
    date: ev.date,
    timeValid: comp.timeValid !== false,
    state,
    completed: state === 'post',
    detail: st.shortDetail || st.detail || '',
    home: us.homeAway === 'home',
    neutral: comp.neutralSite === true,
    opponent: {
      id: String(them.team?.id ?? them.id ?? ''),
      name: them.team?.displayName || them.team?.shortDisplayName || them.team?.name || '?',
      short: them.team?.shortDisplayName || them.team?.name || them.team?.displayName || '?',
      abbrev: them.team?.abbreviation || '',
      logo: them.team?.logos?.[0]?.href || them.team?.logo || '',
      rank: rank && rank >= 1 && rank <= 25 ? rank : null,
      record: them.record?.[0]?.summary || them.records?.[0]?.summary || '',
    },
    venue: {
      name: venue.fullName || venue.shortName || '',
      city: venue.address?.city || '',
      state: venue.address?.state || '',
    },
    broadcast: comp.broadcasts?.[0]?.media?.shortName || comp.broadcasts?.[0]?.names?.[0] || '',
    score: hasScore ? { us: usScore, them: themScore } : null,
    result,
    odds: null,
    url: 'https://www.espn.com/college-football/game/_/gameId/' + encodeURIComponent(ev.id),
    _usAbbrev: us.team?.abbreviation || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Short CDN cache so scores refresh during game days; odds move slowly enough.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const teamId = /^[a-z0-9]{1,8}$/i.test(String(q.team || '')) ? String(q.team) : DEFAULT_TEAM;
  const seasonNum = parseInt(q.season, 10);
  const season = Number.isInteger(seasonNum) && seasonNum >= 2000 && seasonNum <= 2100 ? seasonNum : null;
  if (!season) return res.status(400).json({ error: 'season query param required, e.g. ?season=2026' });

  try {
    // Regular season is required; postseason (bowl / CFP) is best-effort since
    // ESPN often 4xxs it until the bowl is announced.
    const regUrl = ESPN_SITE + '/teams/' + teamId + '/schedule?season=' + season + '&seasontype=2';
    const postUrl = ESPN_SITE + '/teams/' + teamId + '/schedule?season=' + season + '&seasontype=3';
    const [reg, post] = await Promise.all([
      getJSON(regUrl, 8000),
      getJSON(postUrl, 5000).catch(() => null),
    ]);

    const seen = new Set();
    const events = [];
    for (const ev of [...(reg.events || []), ...((post && post.events) || [])]) {
      if (!ev || !ev.id || seen.has(String(ev.id))) continue;
      seen.add(String(ev.id));
      const g = normalizeEvent(ev, teamId);
      if (g) events.push(g);
    }
    events.sort((a, b) => new Date(a.date) - new Date(b.date));

    const teamObj = reg.team || {};
    const ourAbbrev = teamObj.abbreviation || events[0]?._usAbbrev || 'CAL';
    const record = teamObj.recordSummary
      || teamObj.record?.items?.[0]?.summary
      || (Array.isArray(teamObj.record) ? teamObj.record[0]?.summary : null)
      || '';

    // Enrich with odds — best-effort, in parallel, never fails the request.
    await Promise.all(events.map(async (g) => {
      try {
        const url = ESPN_CORE + '/events/' + g.id + '/competitions/' + g.id + '/odds?limit=20';
        const data = await getJSON(url, 5000);
        const o = normalizeOdds(pickOdds(data.items), ourAbbrev, g.opponent.abbrev, g.home);
        if (o) {
          if (g.completed && g.score) o.cover = coverResult(o.line, g.score.us, g.score.them);
          g.odds = o;
        }
      } catch (e) { /* no line for this game (yet) */ }
    }));

    const games = events.map(({ _usAbbrev, ...g }) => g);

    res.status(200).json({
      season,
      seasonLabel: reg.season?.displayName || String(season),
      team: {
        id: String(teamObj.id || teamId),
        name: teamObj.displayName || 'California Golden Bears',
        abbrev: ourAbbrev,
        logo: teamObj.logos?.[0]?.href || teamObj.logo || '',
        record,
      },
      games,
      fetched: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to load schedule' });
  }
}
