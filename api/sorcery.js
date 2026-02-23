// api/sorcery.js — add to your Vercel proxy project at /api/sorcery.js
// No API keys needed — uses tcgcsv.com which mirrors TCGPlayer pricing data
// Data updates daily at ~20:00 UTC

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'focus-app/1.0' } }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

// The specific products we track with their TCGPlayer product IDs
const PRODUCTS = [
  { tcgId: '521517', name: 'Avatar of Air',     set: 'Alpha',  label: 'Foil'     },
  { tcgId: '521581', name: 'Alpha Booster Box', set: 'Alpha',  label: 'Sealed'   },
  { tcgId: '558916', name: 'Gothic Booster Box',set: 'Gothic', label: 'Sealed'   },
  { tcgId: '521534', name: 'Mirror Realm',      set: 'Alpha',  label: 'Foil'     },
  { tcgId: '521533', name: 'Mirror Realm',      set: 'Alpha',  label: 'Non-foil' },
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ids = PRODUCTS.map(p => p.tcgId).join(',');

  try {
    // TCGCSV mirrors TCGPlayer pricing — free, no auth, updates daily
    const { status, body } = await httpsGet(
      `https://tcgcsv.com/tcgplayer/pricing/product/${ids}`
    );

    if (status !== 200) throw new Error(`TCGCSV returned ${status}`);

    const data = JSON.parse(body);

    // Build price map — marketPrice preferred, fall back to midPrice
    const priceMap = {};
    (data.results || []).forEach(r => {
      if (r.marketPrice != null) priceMap[String(r.productId)] = r.marketPrice;
      else if (r.midPrice != null) priceMap[String(r.productId)] = r.midPrice;
    });

    const results = PRODUCTS.map(p => ({
      tcgId: p.tcgId,
      name:  p.name,
      set:   p.set,
      label: p.label,
      price: priceMap[p.tcgId] != null ? Number(priceMap[p.tcgId]).toFixed(2) : null
    }));

    // Cache at Vercel edge for 12 hours (data only updates once a day anyway)
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=3600');
    return res.status(200).json({ results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
