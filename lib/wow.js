// /api/wow — World of Warcraft data for the Focus WoW tab.
//
//   ?action=character&name=<name>&realm=<realm-slug>[&surname=<surname>]
//       Level, class, spec/talents, gear, item level, achievement points, avatar.
//   ?action=guild&realm=<realm-slug>&guild=<guild-slug>
//       Guild roster (name, level, class, rank).
//   ?action=realms[&realms=<slug>,<slug>]
//       Up/down status and population for realms.
//   ?action=news
//       Official Blizzard WoW news (falls back to Wowhead's feed).
//   ?action=probe&name=<name>&realm=<realm-slug>[&surname=<surname>]
//       Tries every namespace and route and reports each status, to find which
//       one serves WoW: Forever characters.
//
// All actions take &region=us|eu|kr|tw (default us).
//
// Character, guild and realm data come from Blizzard's Battle.net API, which
// needs a free client from https://develop.battle.net/access/clients. Set
// BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in Vercel. The secret never
// reaches the browser.
//
// Game flavor: WoW: Forever (launched 2026-11-04) is reported to use the
// profile-forever-<region> / dynamic-forever-<region> namespaces. Each lookup
// tries those first, then Classic and retail, and returns the namespace that
// answered. Set WOW_NAMESPACE_FLAVOR (forever | classic1x | classic | retail)
// to pin one once probe shows which works.

const REGIONS = ['us', 'eu', 'kr', 'tw'];
const LOCALE = 'en_US';
const FLAVORS = ['forever', 'classic1x', 'classic', 'retail'];

function ns(kind, flavor, region) {
  return flavor === 'retail' ? `${kind}-${region}` : `${kind}-${flavor}-${region}`;
}

function flavorOrder() {
  const pinned = (process.env.WOW_NAMESPACE_FLAVOR || '').trim().toLowerCase();
  return FLAVORS.includes(pinned) ? [pinned] : FLAVORS;
}

// ── OAuth (client credentials), cached for the life of the warm function ──
let tokenCache = { value: '', expires: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const id = process.env.BLIZZARD_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) {
    const err = new Error('BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are not set in Vercel');
    err.code = 'NO_KEYS';
    throw err;
  }
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('Battle.net token request returned ' + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 300) * 1000 };
  return tokenCache.value;
}

async function bnet(region, path, namespace, extra) {
  const token = await getToken();
  const qs = new URLSearchParams(Object.assign({ namespace, locale: LOCALE }, extra || {}));
  const url = `https://${region}.api.blizzard.com${path}${path.includes('?') ? '&' : '?'}${qs}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
  let body = null;
  try { body = await r.json(); } catch (e) { /* non-JSON error page */ }
  return { status: r.status, body };
}

const slug = s => String(s || '').trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '-');
const lower = s => encodeURIComponent(String(s || '').trim().toLowerCase());

// Blizzard links (key.href) to a guild or character, checked so the proxy only
// ever calls its own region's API under the expected path. WoW: Forever has no
// visible realms, so these links are the reliable way to reach guilds and
// guild members.
function parseHref(region, href, prefix) {
  try {
    const u = new URL(String(href || ''));
    if (u.protocol !== 'https:' || u.hostname !== `${region}.api.blizzard.com`) return null;
    if (!u.pathname.startsWith(prefix) || u.pathname.includes('..')) return null;
    const namespace = u.searchParams.get('namespace') || '';
    if (!/^(profile|dynamic|static)-[a-z0-9-]+$/.test(namespace)) return null;
    return { path: u.pathname.replace(/\/+$/, ''), namespace };
  } catch (e) { return null; }
}
const hrefOf = x => (x && x.key && x.key.href) || '';

// Routes a character can be found at in one namespace. Forever characters have
// a surname and are reported to also be reachable as name-surname.
function characterPaths(realm, name, surname) {
  const paths = [];
  if (realm) paths.push(`/profile/wow/character/${slug(realm)}/${lower(name)}`);
  if (surname) paths.push(`/profile/wow/character/${lower(name)}-${lower(surname)}`);
  return paths;
}

// Find the namespace + base path that serves this character's profile summary.
async function findCharacter(region, name, realm, surname) {
  let lastStatus = 404;
  for (const flavor of flavorOrder()) {
    const namespace = ns('profile', flavor, region);
    for (const path of characterPaths(realm, name, surname)) {
      const r = await bnet(region, path, namespace);
      if (r.status === 200 && r.body && r.body.name) return { flavor, namespace, path, summary: r.body };
      lastStatus = r.status;
    }
  }
  return { status: lastStatus };
}

const named = x => (x && (x.name || x.type)) || '';

function shapeSpecs(body) {
  if (!body) return [];
  // Classic-style: specialization_groups[].specializations[] with spent_points
  if (Array.isArray(body.specialization_groups)) {
    const active = body.specialization_groups.find(g => g.is_active) || body.specialization_groups[0];
    return ((active && active.specializations) || []).map(s => ({
      name: s.specialization_name || named(s.specialization),
      points: s.spent_points || 0,
    }));
  }
  // Retail-style: specializations[] with talents
  if (Array.isArray(body.specializations)) {
    return body.specializations.map(s => ({
      name: named(s.specialization),
      points: (s.loadouts || []).reduce((n, l) => n + (l.is_active ? (l.selected_class_talents || []).length : 0), 0),
      active: body.active_specialization && body.active_specialization.id === (s.specialization || {}).id,
    }));
  }
  return [];
}

function shapeGear(body) {
  const items = (body && body.equipped_items) || [];
  return items.map(it => ({
    slot: named(it.slot),
    slotType: (it.slot && it.slot.type) || '',
    name: it.name || named(it.item),
    quality: (it.quality && it.quality.type) || '',
    itemLevel: (it.level && it.level.value) || null,
    requiredLevel: (it.requirements && it.requirements.level && it.requirements.level.value) || null,
    id: (it.item && it.item.id) || null,
    mediaHref: hrefOf(it.media),
    icon: '',
  }));
}

// Item icons: each equipped item links to its media (/data/wow/media/item/<id>),
// whose 'icon' asset is a render.worldofwarcraft.com image. Icons never change
// for an item, so they're cached for the life of the warm function.
const iconCache = new Map();
async function addIcons(region, gear, namespace) {
  const staticNs = namespace.replace(/^profile-/, 'static-');
  await Promise.all(gear.map(async g => {
    const key = g.id || g.mediaHref;
    if (!key) return;
    if (iconCache.has(key)) { g.icon = iconCache.get(key); return; }
    // The item's own media link first, then the same item id in other games'
    // static data (most Forever items are original-game items).
    const tries = [];
    const link = parseHref(region, g.mediaHref, '/data/wow/media/item/');
    if (link) tries.push(link);
    if (g.id) for (const n of [staticNs, `static-classic1x-${region}`, `static-${region}`]) {
      if (!tries.some(t => t.namespace === n)) tries.push({ path: `/data/wow/media/item/${encodeURIComponent(g.id)}`, namespace: n });
    }
    for (const t of tries) {
      try {
        const r = await bnet(region, t.path, t.namespace);
        const a = r.status === 200 && r.body && Array.isArray(r.body.assets) && r.body.assets.find(x => x.key === 'icon');
        if (a && /^https:\/\//.test(a.value)) { g.icon = a.value; if (iconCache.size < 2000) iconCache.set(key, a.value); return; }
      } catch (e) { /* try the next namespace */ }
    }
  }));
  for (const g of gear) delete g.mediaHref;
  return gear;
}

async function character(region, q) {
  let found;
  const link = q.href && parseHref(region, q.href, '/profile/wow/character/');
  if (link) {
    const r = await bnet(region, link.path, link.namespace);
    found = r.status === 200 && r.body && r.body.name
      ? { flavor: link.namespace.replace(/^profile-/, '').replace(new RegExp('-?' + region + '$'), '') || 'retail', namespace: link.namespace, path: link.path, summary: r.body }
      : { status: r.status };
  } else {
    if (!q.name || (!q.realm && !q.surname)) return [400, { error: 'name and realm (or surname), or href, are required' }];
    found = await findCharacter(region, q.name, q.realm, q.surname);
  }
  if (!found.summary) return [found.status === 404 ? 404 : 502, { error: 'Character not found in any WoW namespace', status: found.status }];
  const { namespace, path, summary: s } = found;
  const [equip, specs, media] = await Promise.all(
    ['/equipment', '/specializations', '/character-media'].map(p => bnet(region, path + p, namespace).catch(() => ({ status: 0 })))
  );
  const avatarAsset = media.body && Array.isArray(media.body.assets) && media.body.assets.find(a => a.key === 'avatar' || a.key === 'inset');
  const gear = equip.status === 200 ? await addIcons(region, shapeGear(equip.body), namespace) : [];
  const ilvls = gear.filter(g => g.itemLevel && !/SHIRT|TABARD/.test(g.slotType)).map(g => g.itemLevel);
  return [200, {
    flavor: found.flavor,
    namespace,
    name: s.name,
    surname: s.surname || q.surname || '',
    realm: named(s.realm),
    realmSlug: (s.realm && s.realm.slug) || slug(q.realm),
    level: s.level || null,
    race: named(s.race),
    className: named(s.character_class),
    gender: named(s.gender),
    faction: named(s.faction),
    activeSpec: named(s.active_spec),
    guild: s.guild ? { name: s.guild.name, realmSlug: (s.guild.realm && s.guild.realm.slug) || '', href: hrefOf(s.guild) } : null,
    href: hrefOf(s) || `https://${region}.api.blizzard.com${path}?namespace=${namespace}`,
    achievementPoints: s.achievement_points != null ? s.achievement_points : null,
    itemLevel: s.equipped_item_level || s.average_item_level || (ilvls.length ? Math.round(ilvls.reduce((a, b) => a + b, 0) / ilvls.length) : null),
    lastLogin: s.last_login_timestamp || null,
    avatar: avatarAsset ? avatarAsset.value : (s.avatar_url || ''),
    specs: specs.status === 200 ? shapeSpecs(specs.body) : [],
    gear,
    fetchedAt: Date.now(),
  }];
}

// Guild rosters give class and race as bare ids (no names), so map the ids.
const CLASS_NAMES = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 6: 'Death Knight', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 10: 'Monk', 11: 'Druid', 12: 'Demon Hunter', 13: 'Evoker' };
const RACE_NAMES = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll' };
const idName = (x, map) => named(x) || (x && map[x.id]) || '';

function shapeRoster(body, fallbackRealm) {
  return body.members.map(m => {
    const c = m.character || {};
    return {
      name: c.name,
      surname: c.surname || '',
      realmSlug: (c.realm && c.realm.slug) || fallbackRealm || '',
      level: c.level || null,
      className: idName(c.playable_class, CLASS_NAMES),
      race: idName(c.playable_race, RACE_NAMES),
      rank: m.rank,
      href: hrefOf(c),
    };
  }).filter(m => m.name).sort((a, b) => (a.rank - b.rank) || ((b.level || 0) - (a.level || 0)));
}

async function guild(region, q) {
  const link = q.href && parseHref(region, q.href, '/data/wow/guild/');
  if (link) {
    const r = await bnet(region, link.path.replace(/\/roster$/, '') + '/roster', link.namespace);
    if (r.status === 200 && r.body && Array.isArray(r.body.members)) {
      return [200, { flavor: link.namespace, guild: (r.body.guild && r.body.guild.name) || q.guild || '', members: shapeRoster(r.body, '') }];
    }
    if (!q.realm) return [r.status === 404 ? 404 : 502, { error: 'Guild roster not found', status: r.status }];
  }
  if (!q.realm || !q.guild) return [400, { error: 'realm and guild (or href) are required' }];
  const path = `/data/wow/guild/${slug(q.realm)}/${slug(q.guild)}/roster`;
  let last = 404;
  for (const flavor of flavorOrder()) {
    const r = await bnet(region, path, ns('profile', flavor, region));
    if (r.status === 200 && r.body && Array.isArray(r.body.members)) {
      const members = shapeRoster(r.body, slug(q.realm));
      return [200, { flavor, guild: (r.body.guild && r.body.guild.name) || q.guild, members }];
    }
    last = r.status;
  }
  return [last === 404 ? 404 : 502, { error: 'Guild roster not found', status: last }];
}

async function realms(region, q) {
  const want = String(q.realms || '').split(',').map(slug).filter(Boolean);
  // With &flavor=, only that game's realms: WoW: Forever must not fall back to
  // Classic Era's realm list, which is a different game.
  const only = FLAVORS.includes(String(q.flavor || '').toLowerCase()) ? [String(q.flavor).toLowerCase()] : flavorOrder();
  for (const flavor of only) {
    const namespace = ns('dynamic', flavor, region);
    const idx = await bnet(region, '/data/wow/connected-realm/index', namespace);
    if (idx.status !== 200 || !idx.body || !Array.isArray(idx.body.connected_realms)) continue;
    const hrefs = idx.body.connected_realms.map(c => c.href).slice(0, 60);
    const token = await getToken();
    const details = await Promise.all(hrefs.map(async href => {
      try {
        const u = new URL(href);
        u.searchParams.set('locale', LOCALE);
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
        return r.ok ? r.json() : null;
      } catch (e) { return null; }
    }));
    const out = [];
    for (const c of details) {
      if (!c) continue;
      for (const rl of c.realms || []) {
        out.push({
          name: rl.name,
          slug: rl.slug,
          type: named(rl.type),
          timezone: rl.timezone || '',
          status: (c.status && c.status.type) || '',
          population: named(c.population),
          queue: !!c.has_queue,
        });
      }
    }
    if (!out.length) continue;
    const list = want.length ? out.filter(r => want.includes(r.slug)) : out;
    list.sort((a, b) => a.name.localeCompare(b.name));
    return [200, { flavor, namespace, realms: list, total: out.length }];
  }
  return [404, { error: 'Blizzard publishes no realm list for ' + (only.length === 1 ? only[0] : 'any WoW namespace') }];
}

// ── News (no API key needed) ──
function between(str, start, end) {
  const i = str.indexOf(start);
  if (i === -1) return '';
  const j = str.indexOf(end, i + start.length);
  return j === -1 ? '' : str.substring(i + start.length, j);
}
function decode(str) {
  return String(str || '')
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}
function parseFeed(xml, source) {
  const items = [];
  const isAtom = xml.includes('<entry');
  const chunks = xml.split(isAtom ? /<entry[\s>]/ : /<item[\s>]/).slice(1);
  for (const c of chunks) {
    const title = decode(between(c, '<title', '</title>').replace(/^[^>]*>/, ''));
    let link = isAtom ? between(c, '<link href="', '"') : decode(between(c, '<link>', '</link>'));
    if (!link) link = decode(between(c, '<guid', '</guid>').replace(/^[^>]*>/, ''));
    const date = decode(between(c, '<pubDate>', '</pubDate>') || between(c, '<updated>', '</updated>') || between(c, '<published>', '</published>'));
    if (!title || !/^https?:/.test(link)) continue;
    items.push({ title, url: link, time: date ? new Date(date).getTime() || 0 : 0, source });
  }
  return items;
}
const NEWS_FEEDS = [
  { url: 'https://news.blizzard.com/en-us/feed/world-of-warcraft', source: 'Blizzard' },
  { url: 'https://www.wowhead.com/news/rss/all', source: 'Wowhead' },
];
async function news() {
  for (const f of NEWS_FEEDS) {
    try {
      const r = await fetch(f.url, {
        headers: { 'User-Agent': 'focus-app/1.0 (+https://github.com/shinraxviii/focus-app)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const items = parseFeed(await r.text(), f.source);
      if (items.length) {
        items.sort((a, b) => b.time - a.time);
        return [200, { source: f.source, items: items.slice(0, 12) }];
      }
    } catch (e) { /* try the next feed */ }
  }
  return [502, { error: 'No WoW news feed answered' }];
}

async function probe(region, q) {
  if (!q.name) return [400, { error: 'name is required' }];
  const results = [];
  for (const flavor of FLAVORS) {
    const namespace = ns('profile', flavor, region);
    for (const path of characterPaths(q.realm, q.name, q.surname)) {
      const r = await bnet(region, path, namespace).catch(e => ({ status: 'error: ' + e.message }));
      results.push({ namespace, path, status: r.status, level: r.body && r.body.level, detail: r.status === 200 ? undefined : (r.body && (r.body.detail || r.body.reason)) });
    }
    const d = await bnet(region, '/data/wow/connected-realm/index', ns('dynamic', flavor, region)).catch(e => ({ status: 'error: ' + e.message }));
    results.push({ namespace: ns('dynamic', flavor, region), path: '/data/wow/connected-realm/index', status: d.status, count: d.body && d.body.connected_realms ? d.body.connected_realms.length : undefined });
  }
  return [200, { region, results }];
}

const ACTIONS = { character, guild, realms, news, probe };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const action = q.action || 'character';
  const region = REGIONS.includes(String(q.region || '').toLowerCase()) ? String(q.region).toLowerCase() : 'us';
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return res.status(400).json({ error: 'Unknown action: ' + action });
  }
  try {
    const [status, body] = await ACTIONS[action](region, q);
    const cache = { character: 's-maxage=600, stale-while-revalidate=1800', guild: 's-maxage=1800, stale-while-revalidate=3600', realms: 's-maxage=120, stale-while-revalidate=300', news: 's-maxage=1800, stale-while-revalidate=3600', probe: 'no-store' }[action];
    res.setHeader('Cache-Control', status === 200 ? cache : 'no-store');
    return res.status(status).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.code === 'NO_KEYS' ? 503 : 502).json({ error: e.message, code: e.code || undefined });
  }
}
