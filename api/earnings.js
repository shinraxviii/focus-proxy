// api/earnings.js — deploy alongside api/stocks.js in your Vercel project
// Fetches upcoming earnings dates + last EPS beat/miss server-side from Yahoo
// Finance (quoteSummary needs cookie+crumb auth) and returns clean JSON in the
// same shape the app's hardcoded EARNINGS_DATA uses:
//   [{ label, name, date:'YYYY-MM-DD', lastEps:'$X.XX', beat:true, beatPct:'+X.X%' }]

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Tickers to report, with the display names the app already uses.
const TICKERS = ['META', 'AAPL', 'APP', 'LFTO', 'U', 'NVDA'];
const NAMES = {
  META: 'Meta Platforms',
  AAPL: 'Apple',
  APP:  'AppLovin',
  LFTO: 'Liftoff',
  U:    'Unity Software',
  NVDA: 'NVIDIA',
};

// Yahoo's quoteSummary endpoint requires a cookie + matching crumb. Fetch a
// cookie from fc.yahoo.com, then trade it for a crumb. Returns null on failure
// so the handler can degrade gracefully.
async function getCrumb() {
  try {
    const cookieRes = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(6000),
    });
    const setCookie = cookieRes.headers.get('set-cookie');
    if (!setCookie) return null;
    const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).join('; ');

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Accept': '*/*', cookie },
      signal: AbortSignal.timeout(6000),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes('<html')) return null;
    return { cookie, crumb };
  } catch (e) {
    return null;
  }
}

function fmtDate(cal) {
  // calendarEvents.earnings.earningsDate is an array of { raw, fmt }.
  // fmt is already 'YYYY-MM-DD'; take the first (start of the estimated window).
  const arr = cal?.earnings?.earningsDate;
  if (!Array.isArray(arr) || !arr.length) return null;
  const d = arr[0];
  if (d?.fmt) return d.fmt;
  if (typeof d?.raw === 'number') return new Date(d.raw * 1000).toISOString().slice(0, 10);
  return null;
}

function lastEpsInfo(hist) {
  // earningsHistory.history is ordered oldest→newest; the last entry is the
  // most recently reported quarter.
  const h = hist?.history;
  if (!Array.isArray(h) || !h.length) return {};
  const q = h[h.length - 1];
  const actual = q?.epsActual?.raw;
  const est = q?.epsEstimate?.raw;
  if (typeof actual !== 'number') return {};
  const info = { lastEps: (actual < 0 ? '-$' : '$') + Math.abs(actual).toFixed(2) };
  if (typeof est === 'number' && est !== 0) {
    info.beat = actual >= est;
    const pct = ((actual - est) / Math.abs(est)) * 100;
    info.beatPct = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  }
  return info;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6h CDN cache

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const auth = await getCrumb();
  const crumbQS = auth ? '&crumb=' + encodeURIComponent(auth.crumb) : '';
  const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
  if (auth) headers.cookie = auth.cookie;

  try {
    const results = await Promise.all(TICKERS.map(async (ticker) => {
      try {
        const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/'
          + encodeURIComponent(ticker)
          + '?modules=calendarEvents,earningsHistory,price' + crumbQS;
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
        if (!r.ok) return null;
        const data = await r.json();
        const result = data?.quoteSummary?.result?.[0];
        if (!result) return null;

        const date = fmtDate(result.calendarEvents);
        if (!date) return null;

        const name = NAMES[ticker]
          || result.price?.shortName
          || result.price?.longName
          || ticker;

        return { label: ticker, name, date, ...lastEpsInfo(result.earningsHistory) };
      } catch (e) {
        return null;
      }
    }));

    const valid = results.filter(Boolean);
    if (!valid.length) {
      res.status(502).json({ error: 'No earnings data returned from Yahoo Finance' });
      return;
    }

    // Sort by soonest upcoming date.
    valid.sort((a, b) => a.date.localeCompare(b.date));
    res.status(200).json(valid);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal error' });
  }
}
