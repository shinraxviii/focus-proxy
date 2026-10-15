// /api/arena-meta — MTG Arena Standard BO1 ladder meta from Untapped.gg
//
// Backs the Arena BO1 tab of the Standard Meta card in the Focus app. Reads
// the public (no sign-in) analytics that power mtga.untapped.gg's own meta
// page. These are undocumented endpoints, so they may change without notice.
//
//   meta-periods/active               -> current Standard BO1 period ("Ladder")
//   archetype_trend_by_event_scope…   -> daily popularity % and win rate per
//                                        archetype, all ranks
//   archetypes_by_event_scope…/free   -> each archetype's key_art (Arena card
//                                        ids of its signature cards)
//   tags                              -> names for the archetype tag ids
//
// Share and win rate cover the last DAYS days, weighted by each day's games.
// Key cards are looked up by Arena id on Scryfall; lands and cards Scryfall
// doesn't know yet are skipped.
//
//   GET /api/arena-meta
//   -> { source, url, period, days, updated, rows: [
//        { name, colors, share, winRate, games, keyCards: [{ name, image }] } … ] }

const API = 'https://api.mtga.untapped.gg/api/v1/';
const DAYS = 7;
const MAX_ROWS = 10;
const KEY_CARDS = 4;
const UA = 'FocusDashboard/1.0';
const COLOR_BITS = [[1, 'W'], [2, 'U'], [4, 'B'], [8, 'R'], [16, 'G']];

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Untapped ' + r.status + ' for ' + url.replace(API, ''));
  return r.json();
}

// Some days hold [previous season, new season] pairs; the later value is the
// one that belongs to the day.
const flat = (xs) => (xs || []).map((x) => (Array.isArray(x) ? x[x.length - 1] : x));

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

  const [trend, archetypes, tags] = await Promise.all([
    getJson(API + 'analytics/query/archetype_trend_by_event_scope_and_rank_v2?EventNameFilter=LADDER&RankingClassScopeFilter=ALL&ClassificationTypeFilter=ARCHETYPES&MetaPeriodScopeFilter=CURRENT'),
    getJson(API + 'analytics/query/archetypes_by_event_scope_and_rank_v2/free?MetaPeriodId=' + period.id + '&RankingClassScopeFilter=BRONZE_TO_PLATINUM'),
    getJson(API + 'tags'),
  ]);

  const tagName = {};
  for (const t of tags || []) tagName[t.id] = t.name;
  const keyArt = {};
  for (const a of archetypes || []) keyArt[a.primary_tag_group_id] = a.key_art || [];

  const meta = trend.meta_data || {};
  const tiles = meta.tile_data || {};
  const totals = flat(meta.total_matches && meta.total_matches.All);
  const from = Math.max(0, totals.length - DAYS);
  let windowGames = 0;
  for (let i = from; i < totals.length; i++) windowGames += totals[i] || 0;

  const rows = [];
  for (const [id, v] of Object.entries(trend.primary_tag_group_ids || {})) {
    const s = (v && v.All) || {};
    const pop = flat(s.popularity), wr = flat(s.win_rate);
    let games = 0, wins = 0, rated = 0;
    for (let i = from; i < totals.length; i++) {
      if (pop[i] == null || !totals[i]) continue;
      const g = (pop[i] / 100) * totals[i];
      games += g;
      if (wr[i] != null) { wins += g * wr[i]; rated += g; }
    }
    if (!games) continue;
    const tile = tiles[id] || {};
    const name = (tile.primary_tag_ids || []).map((t) => tagName[t]).filter(Boolean).join(' ');
    if (!name) continue;
    rows.push({
      id,
      name,
      colors: colorsOf(tile.color_byte || 0),
      share: +(games / windowGames * 100).toFixed(1),
      winRate: rated ? +(wins / rated).toFixed(1) : null,
      games: Math.round(games),
    });
  }
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
    days: DAYS,
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
