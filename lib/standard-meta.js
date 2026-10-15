// /api/standard-meta — MTG Standard metagame built from official MTGO results
//
// Backs the Standard Meta card in the Focus app's TCG tab. Reads the last
// DAYS days of Standard Leagues and Challenges from mtgo.com/decklists (each
// event page embeds its decklists, standings and final ranks as JSON), groups
// similar decklists into archetypes, and prices a representative list per
// archetype with Scryfall. MTGO doesn't name archetypes, so names come from
// the archetype's colors plus its most distinctive card, with NAME_OVERRIDES
// mapping well-known signature cards to their community names.
//
//   GET /api/standard-meta
//   -> { updated, days, events, decks, archetypes: [
//        { name, colors, decks, share, top8s, price, keyCards: [{ name, image }], sampleUrl } … ] }
//
// The 7-day trend is not computed here: the app keeps daily snapshots of
// `share` in the browser and diffs them itself.

const DAYS = 7;
const MAX_ARCHETYPES = 10;
const MIN_DECKS = 3;          // smaller clusters fold into "Other"
const SIMILARITY = 0.5;       // cosine similarity needed to join an archetype
const MTGO = 'https://www.mtgo.com';
const MTGO_BUDGET_MS = 40000; // time allowed for reading mtgo.com pages
const UA = 'Mozilla/5.0 (compatible; FocusDashboard/1.0)';

// Community names keyed by a signature card. A cluster takes the first name
// whose card is among its top distinctive cards and whose colors match.
const NAME_OVERRIDES = [
  { cards: ['Earthbender Ascension'], colors: 'G', name: 'Mono-Green Landfall' },
  { cards: ['Hearth Elemental', 'Sunderflock'], colors: 'UR', name: 'Izzet Spellementals' },
  { cards: ['Jeskai Revelation', 'Tablet of Discovery'], colors: 'WUR', name: 'Jeskai Lessons' },
  { cards: ['Kaito, Bane of Nightmares', 'Floodpits Drowner', 'Dream Beavers'], colors: 'UB', name: 'Dimir Midrange' },
];

const COLOR_CODE = { COLOR_WHITE: 'W', COLOR_BLUE: 'U', COLOR_BLACK: 'B', COLOR_RED: 'R', COLOR_GREEN: 'G' };
const WUBRG = 'WUBRG';
const COLOR_NAMES = {
  W: 'Mono-White', U: 'Mono-Blue', B: 'Mono-Black', R: 'Mono-Red', G: 'Mono-Green',
  WU: 'Azorius', UB: 'Dimir', BR: 'Rakdos', RG: 'Gruul', WG: 'Selesnya',
  WB: 'Orzhov', UR: 'Izzet', BG: 'Golgari', WR: 'Boros', UG: 'Simic',
  WUB: 'Esper', UBR: 'Grixis', BRG: 'Jund', WRG: 'Naya', WUG: 'Bant',
  WBG: 'Abzan', WUR: 'Jeskai', UBG: 'Sultai', WBR: 'Mardu', URG: 'Temur',
};

// mtgo.com is flaky: a request can stall, an event page can bounce back to
// /decklists, and the index sometimes comes back as an empty shell. So a
// response only counts once `valid(text)` passes, with up to 3 tries, and no
// new try starts after `deadline` (ms timestamp) so the function finishes
// inside its time limit.
async function getText(url, valid, deadline) {
  let last = new Error(url + ' -> no attempt');
  for (let i = 0; i < 3 && Date.now() < deadline; i++) {
    try {
      const left = Math.max(3000, Math.min(15000, deadline - Date.now()));
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(left) });
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      if (r.redirected) throw new Error(url + ' -> redirected to ' + r.url);
      const text = await r.text();
      if (valid(text)) return text;
      throw new Error(url + ' -> page had no data');
    } catch (e) { last = e; }
  }
  throw last;
}

// Run fn over items with at most `limit` in flight. Firing all ~20 event
// pages at once makes mtgo.com stall several of them.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Event slugs look like standard-challenge-32-2026-10-1312856199 or
// standard-league-2026-10-1411129: the date is embedded before the id.
async function recentEventSlugs(now, deadline) {
  const html = await getText(MTGO + '/decklists', (t) => t.includes('href="/decklist/'), deadline);
  const cutoff = new Date(now.getTime() - DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Set();
  const out = [];
  const re = /href="\/decklist\/(standard-[a-z0-9-]*?(\d{4}-\d{2}-\d{2})\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[2] < cutoff || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

function parseEvent(html) {
  const m = html.match(/window\.MTGO\.decklists\.data\s*=\s*(\{[\s\S]*?\});\s*\n/);
  return m ? JSON.parse(m[1]) : null;
}

// Flatten one event into decks: non-land card counts for clustering, color
// weights, the full 75 for pricing, and whether it made a Challenge top 8.
function eventDecks(ev, slug) {
  const top8 = new Set((ev.final_rank || []).filter((r) => +r.rank <= 8).map((r) => String(r.loginid)));
  return (ev.decklists || []).map((d) => {
    const cards = {};
    const colors = {};
    const list = {};
    for (const c of [...(d.main_deck || []), ...(d.sideboard_deck || [])]) {
      const a = c.card_attributes || {};
      const qty = +c.qty || 0;
      list[a.card_name] = (list[a.card_name] || 0) + qty;
      if (c.sideboard === 'true' || /LAND/.test(a.card_type || '')) continue;
      cards[a.card_name] = (cards[a.card_name] || 0) + qty;
      for (const k of a.colors || []) if (COLOR_CODE[k]) colors[COLOR_CODE[k]] = (colors[COLOR_CODE[k]] || 0) + qty;
    }
    return { cards, colors, list, top8: top8.has(String(d.loginid)), slug };
  });
}

const norm = (v) => Math.sqrt(Object.values(v).reduce((s, x) => s + x * x, 0)) || 1;
function cosine(a, b) {
  let s = 0;
  for (const k in a) if (b[k]) s += a[k] * b[k];
  return s / (norm(a) * norm(b));
}

// Greedy clustering, then a few reassignment passes against the centroids so
// the result doesn't depend much on deck order.
function cluster(decks) {
  let groups = [];
  for (const d of decks) {
    let best = null, bestSim = 0;
    for (const g of groups) {
      const s = cosine(d.cards, g.centroid);
      if (s > bestSim) { bestSim = s; best = g; }
    }
    if (best && bestSim >= SIMILARITY) addTo(best, d);
    else groups.push({ members: [d], centroid: { ...d.cards } });
  }
  for (let pass = 0; pass < 3; pass++) {
    const centroids = groups.map((g) => g.centroid);
    groups = centroids.map(() => ({ members: [], centroid: {} }));
    for (const d of decks) {
      let bi = 0, bs = -1;
      centroids.forEach((c, i) => { const s = cosine(d.cards, c); if (s > bs) { bs = s; bi = i; } });
      addTo(groups[bi], d);
    }
    groups = groups.filter((g) => g.members.length);
  }
  return groups.sort((a, b) => b.members.length - a.members.length);
}

function addTo(g, d) {
  g.members.push(d);
  for (const k in d.cards) g.centroid[k] = (g.centroid[k] || 0) + d.cards[k];
}

// A color counts if it's at least 18% of the colored non-land copies, which
// drops light splashes and stray hybrid symbols.
function groupColors(g) {
  const w = {};
  for (const d of g.members) for (const k in d.colors) w[k] = (w[k] || 0) + d.colors[k];
  const total = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  return WUBRG.split('').filter((k) => (w[k] || 0) / total >= 0.18).join('');
}

// Cards this archetype plays a lot of and the rest of the field mostly doesn't.
function distinctiveCards(g, fieldCounts, fieldSize) {
  const n = g.members.length;
  return Object.keys(g.centroid)
    .map((name) => {
      const inGroup = g.centroid[name] / n;                                  // avg copies here
      const outside = (fieldCounts[name] - g.centroid[name]) / Math.max(1, fieldSize - n);
      return { name, score: inGroup - outside * 0.75, inGroup, outside };
    })
    .filter((c) => c.inGroup >= 2)
    .sort((a, b) => b.score - a.score || b.inGroup - a.inGroup);
}

// The app's 7-day trend matches archetypes by name, so a name must not drift
// as the week's decklists change. The signature card is therefore picked by
// a fixed rule rather than by score: the alphabetically first of the core
// cards (true 4-ofs here, rarely played elsewhere). That set barely moves day
// to day, while the top-scoring card flips between near-ties.
function signatureCard(distinct) {
  const core = distinct.filter((c) => c.inGroup >= 3.75 && c.outside < 0.5).map((c) => c.name).sort();
  return core[0] || (distinct[0] && distinct[0].name) || '';
}

function nameFor(colors, distinct) {
  const top = distinct.slice(0, 8).map((c) => c.name);
  const o = NAME_OVERRIDES.find((x) => x.colors === colors && x.cards.some((c) => top.includes(c)));
  if (o) return o.name;
  const base = COLOR_NAMES[colors] || (colors.length >= 4 ? colors.length + '-Color' : 'Colorless');
  const sig = signatureCard(distinct).split(/,| \/\/ /)[0];
  return sig ? base + ' ' + sig : base;
}

// The member deck closest to the centroid stands in for the archetype.
function representative(g) {
  let best = g.members[0], bs = -1;
  for (const d of g.members) { const s = cosine(d.cards, g.centroid); if (s > bs) { bs = s; best = d; } }
  return best;
}

// Scryfall request with retry on 429/5xx, honoring Retry-After.
async function scryfallFetch(url, opts) {
  for (let i = 0; i < 4; i++) {
    let r = null;
    try {
      r = await fetch(url, Object.assign({}, opts, {
        headers: Object.assign({ 'User-Agent': 'FocusDashboard/1.0', 'Accept': 'application/json' }, opts && opts.headers),
        signal: AbortSignal.timeout(10000),
      }));
    } catch (e) { /* network error: retry */ }
    if (r && r.status !== 429 && r.status < 500) return r;
    const ra = r ? parseFloat(r.headers.get('retry-after')) : NaN;
    await new Promise((res) => setTimeout(res, ra > 0 ? ra * 1000 : 300 * Math.pow(2, i)));
  }
  return null;
}

async function scryfallCards(names) {
  const out = {};
  const ids = [...new Set(names)];
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    try {
      const r = await scryfallFetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((n) => ({ name: n.split(' // ')[0] })) }),
      });
      if (!r || !r.ok) { await pause(); continue; }
      const j = await r.json();
      for (const c of j.data || []) {
        const img = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
        const rec = { usd: parseFloat(c.prices && c.prices.usd) || 0, image: img.small || img.normal || null, art: img.art_crop || null };
        out[c.name] = rec;
        out[c.name.split(' // ')[0]] = rec;
      }
    } catch (e) { /* prices/images are optional */ }
    await pause();
  }
  // The collection endpoint returns each card's newest printing, which often
  // has no price yet (fresh reprints, basics). Re-price those from their
  // cheapest paper printing.
  const unpriced = [...new Set(ids.map((n) => n.split(' // ')[0]))].filter((n) => !(out[n] && out[n].usd));
  for (let i = 0; i < unpriced.length; i += 20) {
    const q = '(' + unpriced.slice(i, i + 20).map((n) => '!"' + n.replace(/"/g, '') + '"').join(' or ') + ') prefer:usd-low usd>0';
    try {
      const r = await scryfallFetch('https://api.scryfall.com/cards/search?unique=cards&q=' + encodeURIComponent(q));
      if (r && r.ok) {
        for (const c of (await r.json()).data || []) {
          const usd = parseFloat(c.prices && c.prices.usd) || 0;
          for (const key of [c.name, c.name.split(' // ')[0]]) {
            if (out[key]) out[key].usd = usd;
            else out[key] = { usd, image: null, art: null };
          }
        }
      }
    } catch (e) { /* leave unpriced */ }
    await pause();
  }
  return out;
}

// Scryfall asks for 50-100ms between requests.
const pause = () => new Promise((res) => setTimeout(res, 100));

export async function buildMeta(now = new Date()) {
  // Leave the last ~20s of the 60s function limit for Scryfall.
  const deadline = Date.now() + MTGO_BUDGET_MS;
  const slugs = await recentEventSlugs(now, deadline);
  const hasData = (t) => /window\.MTGO\.decklists\.data\s*=/.test(t);
  const pages = await mapLimit(slugs, 5, async (slug) => {
    try { return { slug, ev: parseEvent(await getText(MTGO + '/decklist/' + slug, hasData, deadline)) }; }
    catch (e) { console.error('standard-meta: ' + e.message); return { slug, ev: null }; }
  });
  const decks = [];
  let events = 0;
  const failed = pages.filter((p) => !p.ev).length;
  for (const { slug, ev } of pages) {
    if (!ev || !(ev.decklists || []).length) continue;
    events++;
    decks.push(...eventDecks(ev, slug));
  }
  if (!decks.length) throw new Error('No Standard decklists found on mtgo.com');

  const field = {};
  for (const d of decks) for (const k in d.cards) field[k] = (field[k] || 0) + d.cards[k];

  const groups = cluster(decks).filter((g) => g.members.length >= MIN_DECKS).slice(0, MAX_ARCHETYPES);
  const shaped = groups.map((g) => {
    const colors = groupColors(g);
    const distinct = distinctiveCards(g, field, decks.length);
    const rep = representative(g);
    return { g, colors, distinct, rep, name: nameFor(colors, distinct) };
  });

  // Disambiguate the rare case of two clusters getting the same name.
  const seenNames = {};
  for (const s of shaped) {
    if (seenNames[s.name]) s.name += ' ' + (s.distinct[1] ? s.distinct[1].name.split(/,| \/\/ /)[0] : String(++seenNames[s.name]));
    seenNames[s.name] = 1;
  }

  const wanted = [];
  for (const s of shaped) wanted.push(...Object.keys(s.rep.list), ...s.distinct.slice(0, 4).map((c) => c.name));
  const sf = await scryfallCards(wanted);

  const archetypes = shaped.map((s) => {
    let price = 0, priced = 0, total = 0;
    for (const [name, qty] of Object.entries(s.rep.list)) {
      total += qty;
      const c = sf[name] || sf[name.split(' // ')[0]];
      if (c && c.usd) { price += c.usd * qty; priced += qty; }
    }
    return {
      name: s.name,
      colors: s.colors,
      decks: s.g.members.length,
      share: +(s.g.members.length / decks.length * 100).toFixed(1),
      top8s: s.g.members.filter((d) => d.top8).length,
      price: priced ? Math.round(price) : null,
      pricedCards: priced + '/' + total,
      keyCards: s.distinct.slice(0, 4).map((c) => {
        const r = sf[c.name] || sf[c.name.split(' // ')[0]] || {};
        return { name: c.name, copies: +c.inGroup.toFixed(1), image: r.image || null, art: r.art || null };
      }),
      sampleUrl: MTGO + '/decklist/' + s.rep.slug,
    };
  });

  return {
    source: 'mtgo.com',
    updated: now.toISOString(),
    days: DAYS,
    events,
    failedEvents: failed,
    decks: decks.length,
    archetypes,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const data = await buildMeta();
    // MTGO posts a few events a day; six hours of CDN cache is plenty.
    // A build that lost events to mtgo.com flakiness is only cached briefly,
    // so the next request after 10 minutes tries for a complete one.
    res.setHeader('Cache-Control', data.failedEvents
      ? 's-maxage=600, stale-while-revalidate=3600'
      : 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json(data);
  } catch (e) {
    console.error('standard-meta error:', e);
    return res.status(502).json({ error: e.message || 'Failed to build Standard meta' });
  }
}
