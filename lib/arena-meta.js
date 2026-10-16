// /api/arena-meta — MTG Arena Standard BO1 ladder meta from Untapped.gg
//
// Backs the Arena BO1 tab of the Standard Meta card in the Focus app. Reads
// the public (no sign-in) analytics that power mtga.untapped.gg's own meta
// page. These are undocumented endpoints, so they may change without notice.
//
//   meta-periods/active               -> current Standard BO1 period ("Ladder")
//   archetypes_by_event_scope…/free   -> per archetype: key_art (Arena card ids
//                                        of its signature cards) and match
//                                        count + win rate, either for all
//                                        ranks (ALL) or per rank for Bronze,
//                                        Silver, Gold and Platinum
//                                        (BRONZE_TO_PLATINUM)
//   tags                              -> names for the archetype tag ids
//
// The free API has no Diamond or Mythic filter (that's Untapped Premium), so
// Platinum-and-above is derived: all ranks minus Bronze, Silver and Gold.
// Stats cover the whole current meta period (since the last set release or
// ban update). Key cards are looked up by Arena id on Scryfall; lands and
// cards Scryfall doesn't know yet are skipped.
//
//   GET /api/arena-meta
//   -> { source, url, period, since, days, ranks, updated, rows: [
//        { name, colors, share, winRate, games, keyCards: [{ name, image }] } … ] }

const API = 'https://api.mtga.untapped.gg/api/v1/';
const LOW_RANKS = ['bronze', 'silver', 'gold'];
const MAX_ROWS = 10;
const KEY_CARDS = 4;
const UA = 'FocusDashboard/1.0';
const COLOR_BITS = [[1, 'W'], [2, 'U'], [4, 'B'], [8, 'R'], [16, 'G']];

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Untapped ' + r.status + ' for ' + url.replace(API, ''));
  return r.json();
}

const colorsOf = (byte) => COLOR_BITS.filter(([bit]) => byte & bit).map(([, c]) => c).join('');

const pause = (ms) => new Promise((res) => setTimeout(res, ms));

async function scryfallByArenaId(id) {
  try {
    const r = await fetch('https://api.scryfall.com/cards/arena/' + id, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const c = await r.json();
    // Lands say little about a deck (and basics are often the key art).
    if (/\bLand\b/.test((c.type_line || '').split(' // ')[0])) return null;
    const img = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
    return { name: c.name, image: img.small || img.normal || null };
  } catch (e) { return null; }
}

export async function buildArenaMeta() {
  const periods = await getJson(API + 'meta-periods/active');
  const period = (periods || []).find((p) => p.event_name === 'Ladder' && !p.end_ts)
    || (periods || []).filter((p) => p.event_name === 'Ladder').pop();
  if (!period) throw new Error('No current Standard BO1 meta period');

  const q = API + 'analytics/query/archetypes_by_event_scope_and_rank_v2/free?MetaPeriodId=' + period.id + '&RankingClassScopeFilter=';
  const [all, low, tags] = await Promise.all([getJson(q + 'ALL'), getJson(q + 'BRONZE_TO_PLATINUM'), getJson(API + 'tags')]);

  const tagName = {};
  for (const t of tags || []) tagName[t.id] = t.name;
  const lowStats = {};
  for (const a of low || []) lowStats[a.primary_tag_group_id] = a.stats || {};

  // Matches and wins at Platinum and above = all ranks minus Bronze-Gold.
  const rows = [];
  const keyArt = {};
  let totalGames = 0;
  for (const a of all || []) {
    const s = (a.stats && a.stats.all) || {};
    let games = s.total_matches || 0, wins = games * (s.winrate || 0);
    for (const rank of LOW_RANKS) {
      const l = (lowStats[a.primary_tag_group_id] || {})[rank] || {};
      games -= l.total_matches || 0;
      wins -= (l.total_matches || 0) * (l.winrate || 0);
    }
    if (games <= 0) continue;
    totalGames += games;
    const name = (a.primary_tags || []).map((t) => tagName[t]).filter(Boolean).join(' ');
    if (!name) continue;
    keyArt[a.primary_tag_group_id] = a.key_art || [];
    rows.push({
      id: a.primary_tag_group_id,
      name,
      colors: colorsOf(a.color_byte || 0),
      games,
      winRate: s.winrate == null ? null : +(wins / games).toFixed(1),
    });
  }
  for (const r of rows) r.share = +(r.games / totalGames * 100).toFixed(1);
  rows.sort((a, b) => b.share - a.share);
  const top = rows.slice(0, MAX_ROWS);

  // Scryfall asks for 50-100ms between requests; ~10 archetypes x 5 ids.
  const cardCache = {};
  for (const r of top) {
    r.keyCards = [];
    for (const art of keyArt[r.id] || []) {
      if (r.keyCards.length >= KEY_CARDS) break;
      if (!(art in cardCache)) { cardCache[art] = await scryfallByArenaId(art); await pause(80); }
      const c = cardCache[art];
      if (c && !r.keyCards.some((k) => k.name === c.name)) r.keyCards.push(c);
    }
    delete r.id;
  }

  return {
    source: 'Untapped.gg',
    url: 'https://mtga.untapped.gg/constructed/standard/meta',
    period: period.description || null,
    since: period.start_ts || null,
    days: period.start_ts ? Math.max(1, Math.round((Date.now() - Date.parse(period.start_ts)) / 864e5)) : null,
    ranks: 'Platinum+',
    updated: new Date().toISOString(),
    rows: top,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const data = await buildArenaMeta();
    if (!data.rows.length) throw new Error('No archetypes in the Untapped data');
    // Untapped refreshes through the day; 6 hours of CDN cache is plenty.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json(data);
  } catch (e) {
    console.error('arena-meta error:', e);
    return res.status(502).json({ error: e.message || 'Failed to build Arena meta' });
  }
}
