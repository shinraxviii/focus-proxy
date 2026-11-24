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
//                                        (metadata.display_name, when set, is
//                                        what the site shows, e.g. "4-Color"
//                                        for Glint-Eye)
//
// The free API has no Diamond or Mythic filter (that's Untapped Premium), so
// Platinum-and-above is derived: all ranks minus Bronze, Silver and Gold.
// Stats cover the whole current meta period (since the last set release or
// ban update). Key cards are looked up by Arena id on Scryfall; lands and
// cards Scryfall doesn't know yet are skipped.
//
// `tiers` mirrors the site's Standard tier list at its default filters (BO1,
// Platinum to Platinum, current meta): Platinum games only, archetypes with
// at least TIER_MIN_MATCHES, sorted by win rate and grouped A-D the way the
// site's own code does it (see tierFns). The site also drops archetypes that
// have no published decklists, which the free API doesn't expose, so a
// borderline archetype can land one tier off.
//
//   GET /api/arena-meta
//   -> { source, url, period, since, days, ranks, updated, rows: [
//        { name, colors, share, winRate, games, keyCards: [{ name, image }] } … ],
//        totalGames, all: [[name, colors, games, wins x100] …], keyCards: { name: [...] },
//        aliases: { displayName: oldName },
//        tiers: { url, ranks, minMatches, totalMatches, rows: [
//          { tier, name, colors, winRate, games, keyCards } … ] } }

const API = 'https://api.mtga.untapped.gg/api/v1/';
const LOW_RANKS = ['bronze', 'silver', 'gold'];
const MAX_ROWS = 10;
const KEY_CARD_ROWS = 16;    // archetypes that get key cards looked up
const ALL_ROWS = 60;         // archetypes sent with season totals
const KEY_CARDS = 4;
const UA = 'FocusDashboard/1.0';
const TIER_MIN_MATCHES = 1000; // the site's tier-list cutoff
const TIER_ROWS = 12;
const TIER_URL = 'https://mtga.untapped.gg/constructed/standard/tier-list';
const COLOR_BITS = [[1, 'W'], [2, 'U'], [4, 'B'], [8, 'R'], [16, 'G']];

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Untapped ' + r.status + ' for ' + url.replace(API, ''));
  return r.json();
}

const colorsOf = (byte) => COLOR_BITS.filter(([bit]) => byte & bit).map(([, c]) => c).join('');

const pause = (ms) => new Promise((res) => setTimeout(res, ms));

// Untapped's tier rule (from the site's tier-list code): with avg the plain
// mean win rate, A is within one standard deviation (of the above-average
// win rates) of the best, B is the rest at or above average, C is within one
// standard deviation (of the below-average ones) under average, D the rest.
function tierFns(values, avg) {
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const sd = (v) => { if (!v.length) return 0; const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
  const up = sd(values.filter((v) => v >= avg)), down = sd(values.filter((v) => v < avg));
  const best = Math.max(...values);
  return [(v) => v > best - up, (v) => v >= avg, (v) => v > avg - down, () => true];
}

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
  // Old names for renamed archetypes, so the app can match its saved
  // snapshots (it used tag.name before display names).
  const aliases = {};
  for (const t of tags || []) tagName[t.id] = (t.metadata && t.metadata.display_name) || t.name;
  const rawName = {};
  for (const t of tags || []) rawName[t.id] = t.name;
  const lowStats = {};
  for (const a of low || []) lowStats[a.primary_tag_group_id] = a.stats || {};

  // Matches and wins at Platinum and above = all ranks minus Bronze-Gold.
  const rows = [];
  const keyArt = {};
  const plat = [];
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
    const old = (a.primary_tags || []).map((t) => rawName[t]).filter(Boolean).join(' ');
    if (old !== name) aliases[name] = old;
    keyArt[a.primary_tag_group_id] = a.key_art || [];
    const p = (lowStats[a.primary_tag_group_id] || {}).platinum || {};
    if ((p.total_matches || 0) >= TIER_MIN_MATCHES && p.winrate != null && a.primary_tag_group_id >= 0) {
      plat.push({ id: a.primary_tag_group_id, name, colors: colorsOf(a.color_byte || 0), games: p.total_matches, winRate: p.winrate });
    }
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
  // Season totals for every named archetype. The app keeps these as daily
  // snapshots and diffs two of them to get recent-days shares and win rates,
  // which the free API can't filter by date.
  const season = rows.slice(0, ALL_ROWS).map((r) => [r.name, r.colors, Math.round(r.games), Math.round(r.games * (r.winRate || 0))]);
  // Key cards for more than MAX_ROWS, since a recent top 10 can differ from
  // the season's.
  const top = rows.slice(0, KEY_CARD_ROWS);

  plat.sort((a, b) => b.winRate - a.winRate);
  const fns = plat.length ? tierFns(plat.map((r) => r.winRate), plat.reduce((s, r) => s + r.winRate, 0) / plat.length) : [];
  const tierRows = plat.slice(0, TIER_ROWS).map((r) => ({
    id: r.id, tier: 'ABCD'[fns.findIndex((f) => f(r.winRate))], name: r.name, colors: r.colors,
    winRate: Math.round(r.winRate * 100) / 100, games: r.games,
  }));

  // Scryfall asks for 50-100ms between requests; ~10 archetypes x 5 ids.
  const cardCache = {};
  for (const r of top.concat(tierRows)) {
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
    totalGames: Math.round(totalGames),
    rows: top.slice(0, MAX_ROWS),
    // [name, colors, games, wins x100] per archetype, season to date.
    all: season,
    // Key cards for archetypes outside the season top 10.
    keyCards: Object.fromEntries(top.slice(MAX_ROWS).map((r) => [r.name, r.keyCards])),
    aliases,
    tiers: {
      url: TIER_URL,
      ranks: 'Platinum',
      minMatches: TIER_MIN_MATCHES,
      // All Platinum Standard BO1 matches this period, as the site's
      // "Total matches" shows it.
      totalMatches: ((period.NORMAL || {}).matches_count_all || {}).platinum || null,
      rows: tierRows,
    },
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
