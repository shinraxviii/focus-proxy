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
//   ?action=status&name=<name>&surname=<surname>
//       Is WoW: Forever up? Checks that Blizzard's Forever API answers, and how
//       recently the character's guild mates logged in (nobody logs in while the
//       servers are down). Also tries Blizzard's realm status page for Forever.
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
    // Enchants (and temporary ones like weapon oils) come as display strings,
    // e.g. "Enchanted: +3 Intellect"; the prefix is dropped for display.
    enchants: (it.enchantments || []).map(e => String(e.display_string || named(e.source_item) || '').replace(/^Enchanted:\s*/i, '').trim()).filter(Boolean),
    mediaHref: hrefOf(it.media),
    icon: '',
    tooltip: itemTooltip(it),
  }));
}

// A WoW-style tooltip, as lines in display order. Each line is {t} text, with
// optional {r} right-aligned text (e.g. "Head" / "Cloth"), {c} a color (hex,
// from Blizzard's display.color, or a quality/kind name) and {k} a kind the app
// styles: 'name' | 'green' | 'flavor' | 'muted'. Fields missing from the
// response are skipped, so this works for whatever a given item has.
const hex = c => (c && typeof c.r === 'number')
  ? '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('') : '';
const ds = x => (x && (x.display_string || (x.display && x.display.display_string))) || '';
function itemTooltip(it) {
  const L = [];
  const push = (t, extra) => { if (t) L.push(Object.assign({ t: String(t) }, extra || {})); };
  push(it.name || named(it.item), { k: 'name', q: (it.quality && it.quality.type) || '' });
  if (it.name_description) push(ds(it.name_description), { k: 'green' });
  push(named(it.binding));
  push(ds(it.unique_equipped) || (typeof it.unique_equipped === 'string' ? it.unique_equipped : ''));
  const slotName = named(it.inventory_type), sub = named(it.item_subclass);
  if (slotName || sub) L.push({ t: slotName || '', r: sub && sub !== slotName ? sub : '' });
  const w = it.weapon;
  if (w) {
    const dmg = ds(w.damage), spd = ds(w.attack_speed);
    if (dmg || spd) L.push({ t: dmg, r: spd });
    push(ds(w.dps));
  }
  push(ds(it.armor));
  for (const st of it.stats || []) {
    const t = ds(st);
    if (!t || st.is_negated) continue;
    L.push({ t, c: hex(st.display && st.display.color) || '', k: st.is_equip_bonus ? 'green' : '' });
  }
  for (const e of it.enchantments || []) push(e.display_string, { k: 'green' });
  for (const sk of it.sockets || []) push(ds(sk) || (sk.socket_type && named(sk.socket_type)) || '', { k: 'muted' });
  push(ds(it.durability));
  const req = it.requirements || {};
  push(ds(req.level));
  push(ds(req.playable_classes));
  push(ds(req.skill));
  push(ds(req.reputation));
  for (const sp of it.spells || []) push(sp.description, { k: 'green', c: hex(sp.display_color) || '' });
  if (it.set) {
    push(ds(it.set), { k: 'name', q: 'set' });
    for (const ef of it.set.effects || []) push(ds(ef), { k: ef.is_active ? 'green' : 'muted' });
  }
  if (it.description) push('"' + it.description + '"', { k: 'flavor' });
  const sp = it.sell_price && it.sell_price.display_strings;
  if (sp) {
    const parts = [['gold', 'g'], ['silver', 's'], ['copper', 'c']].map(([k, u]) => {
      const v = parseInt(sp[k], 10); return v ? v + u : '';
    }).filter(Boolean);
    if (parts.length) push('Sell price: ' + parts.join(' '), { k: 'muted' });
  }
  return L;
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

// Character statistics, in display order. Values are {effective, base} for
// attributes, {value} or bare numbers for ratings, and percentages for crit
// etc. Only stats the response actually has are returned; the app shows up to
// ten. Spell caster stats come first since that's what matters for a mage.
const STAT_FIELDS = [
  ['health', 'Health', 'n'],
  ['power', 'Mana', 'n'],
  ['intellect', 'Intellect', 'n'],
  ['stamina', 'Stamina', 'n'],
  ['spirit', 'Spirit', 'n'],
  ['spell_power', 'Spell power', 'n'],
  ['spell_crit', 'Spell crit', '%'],
  ['spell_hit_rating', 'Spell hit', 'n'],
  ['mana_regen', 'Mana regen', 'n'],
  ['armor', 'Armor', 'n'],
  ['agility', 'Agility', 'n'],
  ['strength', 'Strength', 'n'],
  ['melee_crit', 'Melee crit', '%'],
  ['dodge', 'Dodge', '%'],
  ['attack_power', 'Attack power', 'n'],
];
function statValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    for (const k of ['effective', 'value', 'rating_normalized', 'rating', 'base']) if (typeof v[k] === 'number') return v[k];
  }
  return null;
}
function shapeStats(body) {
  if (!body) return [];
  const powerName = named(body.power_type);
  const out = [];
  for (const [key, label, kind] of STAT_FIELDS) {
    const v = statValue(body[key]);
    if (v == null) continue;
    out.push({ key, label: key === 'power' && powerName ? powerName : label, value: kind === '%' ? Math.round(v * 100) / 100 : Math.round(v), pct: kind === '%' });
  }
  return out;
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
  const [equip, specs, media, stats] = await Promise.all(
    ['/equipment', '/specializations', '/character-media', '/statistics'].map(p => bnet(region, path + p, namespace).catch(() => ({ status: 0 })))
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
    stats: stats.status === 200 ? shapeStats(stats.body) : [],
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

// ── Forever uptime ──
// Blizzard's status page (worldofwarcraft.blizzard.com/game/status) is backed by
// a GraphQL query. Best effort: if it serves Forever, its realm list wins.
const STATUS_GQL_HASH = 'b37e546366a58e211e922b8c96cd1ff74249f564a49029cc9737fef3300ff175';
async function statusPage(region) {
  for (const game of ['forever-' + region, region + '-forever']) {
    try {
      const r = await fetch('https://worldofwarcraft.blizzard.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'focus-app/1.0' },
        body: JSON.stringify({ operationName: 'GetRealmStatusData', variables: { input: { compoundRegionGameVersionSlug: game } },
          extensions: { persistedQuery: { version: 1, sha256Hash: STATUS_GQL_HASH } } }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const list = j && j.data && Array.isArray(j.data.Realms) ? j.data.Realms : null;
      if (!list || !list.length) continue;
      const realms = list.map(x => ({ name: x.name, online: x.online !== false })).filter(x => x.name);
      if (realms.length) return { source: game, realms, up: realms.filter(x => x.online).length, total: realms.length };
    } catch (e) { /* not available */ }
  }
  return null;
}

async function status(region, q) {
  if (!q.name || !q.surname) return [400, { error: 'name and surname are required' }];
  const t0 = Date.now();
  const main = await bnet(region, `/profile/wow/character/${lower(q.name)}-${lower(q.surname)}`, ns('profile', 'forever', region))
    .catch(() => ({ status: 0, body: null }));
  const api = { ok: main.status === 200, status: main.status, ms: Date.now() - t0 };
  const game = await statusPage(region);
  const logins = [];
  if (api.ok && main.body) {
    logins.push({ name: main.body.name, surname: main.body.surname || '', t: main.body.last_login_timestamp || 0 });
    const g = parseHref(region, hrefOf(main.body.guild), '/data/wow/guild/');
    if (g) {
      const r = await bnet(region, g.path.replace(/\/roster$/, '') + '/roster', g.namespace).catch(() => null);
      const hrefs = r && r.status === 200 && Array.isArray(r.body && r.body.members)
        ? r.body.members.map(m => hrefOf(m.character)).filter(h => h && !h.includes('/' + lower(q.name) + '-' + lower(q.surname) + '?')).slice(0, 40) : [];
      const got = await Promise.all(hrefs.map(async h => {
        const link = parseHref(region, h, '/profile/wow/character/');
        if (!link) return null;
        const c = await bnet(region, link.path, link.namespace).catch(() => null);
        return c && c.status === 200 && c.body ? { name: c.body.name, surname: c.body.surname || '', t: c.body.last_login_timestamp || 0 } : null;
      }));
      for (const x of got) if (x) logins.push(x);
    }
  }
  const now = Date.now();
  const seen = logins.filter(x => x.t > 0).sort((a, b) => b.t - a.t);
  const activity = {
    checked: logins.length,
    lastHour: seen.filter(x => now - x.t < 3600e3).length,
    lastDay: seen.filter(x => now - x.t < 86400e3).length,
    newest: seen[0] ? seen[0].t : null,
    newestName: seen[0] ? seen[0].name : '',
  };
  // Each member's last login, for the guild roster's "seen" column.
  const members = logins.map(x => ({ name: x.name, surname: x.surname, lastLogin: x.t || null }));
  return [200, { checkedAt: now, api, game, activity, members }];
}

const ACTIONS = { character, guild, realms, news, probe, status };

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
    const cache = { character: 's-maxage=600, stale-while-revalidate=1800', guild: 's-maxage=1800, stale-while-revalidate=3600', realms: 's-maxage=120, stale-while-revalidate=300', news: 's-maxage=1800, stale-while-revalidate=3600', status: 's-maxage=120, stale-while-revalidate=240', probe: 'no-store' }[action];
    res.setHeader('Cache-Control', status === 200 ? cache : 'no-store');
    return res.status(status).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.code === 'NO_KEYS' ? 503 : 502).json({ error: e.message, code: e.code || undefined });
  }
}
