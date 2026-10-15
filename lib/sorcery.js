// /api/sorcery — Sorcery: Contested Realm prices for the Focus app's TCG tab
//
// Reads TCGCSV (tcgcsv.com), a free daily mirror of TCGplayer prices. TCGCSV
// publishes one prices file per set at /tcgplayer/<category>/<group>/prices;
// Sorcery is category 77. Each row is one product + printing (subTypeName
// "Normal" or "Foil"), so foil and non-foil of a card share a product id when
// TCGplayer lists them together, and have separate ids when it doesn't (as
// with the Alpha cards below).
//
//   GET /api/sorcery
//   -> { updated, results: [{ tcgId, name, set, label, price, basis, low, url }] }
//   basis is 'market' (recent sales) or 'mid' (median listing, used when an
//   item has no recent sales).
//
// TCGCSV refreshes once a day around 20:00 UTC.

const CATEGORY = 77;
const TCGCSV = 'https://tcgcsv.com/tcgplayer/' + CATEGORY + '/';
const UA = 'FocusDashboard/1.0';

// Product ids come from TCGCSV's products files (…/<group>/products).
const PRODUCTS = [
  { tcgId: 521581, group: 23335, name: 'Alpha Booster Box',  set: 'Alpha',  label: 'Sealed',   printing: 'Normal' },
  { tcgId: 656591, group: 24471, name: 'Gothic Booster Box', set: 'Gothic', label: 'Sealed',   printing: 'Normal' },
  { tcgId: 522759, group: 23336, name: 'Beta Booster Box',   set: 'Beta',   label: 'Sealed',   printing: 'Normal' },
  { tcgId: 563830, group: 23588, name: 'Arthurian Legends Booster Box', set: 'Arthurian Legends', label: 'Sealed', printing: 'Normal' },
  { tcgId: 641955, group: 24378, name: 'Dragonlord Box',     set: 'Dragonlord', label: 'Sealed', printing: 'Normal' },
  { tcgId: 521517, group: 23335, name: 'Avatar of Air',      set: 'Alpha',  label: 'Foil',     printing: 'Foil' },
  { tcgId: 522102, group: 23335, name: 'Mirror Realm',       set: 'Alpha',  label: 'Foil',     printing: 'Foil' },
  { tcgId: 522098, group: 23335, name: 'Mirror Realm',       set: 'Alpha',  label: 'Non-foil', printing: 'Normal' },
];

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('TCGCSV ' + r.status + ' for ' + url);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const groups = [...new Set(PRODUCTS.map((p) => p.group))];
    const [files, updated] = await Promise.all([
      Promise.all(groups.map((g) => getJson(TCGCSV + g + '/prices'))),
      fetch('https://tcgcsv.com/last-updated.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? r.text() : null)).catch(() => null),
    ]);

    const rows = {};
    for (const f of files) {
      for (const r of f.results || []) rows[r.productId + ':' + r.subTypeName] = r;
    }

    const results = PRODUCTS.map((p) => {
      const r = rows[p.tcgId + ':' + p.printing] || {};
      const basis = r.marketPrice != null ? 'market' : (r.midPrice != null ? 'mid' : null);
      return {
        tcgId: String(p.tcgId),
        name: p.name,
        set: p.set,
        label: p.label,
        price: basis ? Number(basis === 'market' ? r.marketPrice : r.midPrice).toFixed(2) : null,
        basis,
        low: r.lowPrice != null ? Number(r.lowPrice).toFixed(2) : null,
        url: 'https://www.tcgplayer.com/product/' + p.tcgId,
      };
    });

    if (!results.some((r) => r.price != null)) throw new Error('No prices found for the tracked products');

    // TCGCSV updates once a day, so 6 hours of CDN cache keeps us within a
    // few hours of each refresh.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json({ updated: updated ? updated.trim() : null, results });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
