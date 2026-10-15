// api/stocks.js  — deploy alongside api/claude.js in your Vercel project
// Fetches Yahoo Finance server-side (no CORS issues) and returns clean JSON.
// Prices come from the auth-free v8 chart endpoint; market caps are added as a
// best-effort enrichment via quoteSummary (needs cookie+crumb) and never affect
// whether prices are returned.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Yahoo's quoteSummary endpoint requires a cookie + matching crumb. Fetch a
// cookie from fc.yahoo.com, then trade it for a crumb. Returns null on failure.
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

// Best-effort market cap per ticker from quoteSummary's price module. Indices
// and futures have no meaningful market cap and are skipped by the caller.
async function fetchMarketCaps(tickers, auth) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
  if (auth) headers.cookie = auth.cookie;
  const crumbQS = auth ? '&crumb=' + encodeURIComponent(auth.crumb) : '';
  const caps = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/'
        + encodeURIComponent(ticker) + '?modules=price' + crumbQS;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      const data = await r.json();
      const mc = data?.quoteSummary?.result?.[0]?.price?.marketCap?.raw;
      if (typeof mc === 'number' && mc > 0) caps[ticker] = mc;
    } catch (e) {
      // Ignore — this ticker just won't have a market cap.
    }
  }));
  return caps;
}

export default async function handler(req, res) {
  // CORS — allow your GitHub Pages domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5min CDN cache

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const TICKERS = ['APP','U','APPS','LFTO','AAPL','TSLA','META','GOOG','NVDA','^GSPC','^IXIC','BTC-USD','ETH-USD','SOL-USD','GC=F','SI=F','CL=F'];
  const LABELS  = { 'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'SOL-USD': 'SOL', '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq', 'GC=F': 'Gold', 'SI=F': 'Silver', 'CL=F': 'Oil' };
  const NAMES   = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana', '^GSPC': 'S&P 500 Index', '^IXIC': 'Nasdaq Composite', 'GC=F': 'Gold Futures', 'SI=F': 'Silver Futures', 'CL=F': 'Crude Oil' };
  // Tickers with no meaningful market cap (indices + futures).
  const NO_CAP = new Set(['^GSPC', '^IXIC', 'GC=F', 'SI=F', 'CL=F']);

  try {
    const results = await Promise.all(TICKERS.map(async (ticker) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
        const r = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) return null;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return null;
        const price     = meta.regularMarketPrice;
        const prev      = meta.chartPreviousClose;
        const changePct = ((price - prev) / prev) * 100;
        const change    = price - prev;
        const marketTime = meta.regularMarketTime || null;
        const name = NAMES[ticker] || meta.shortName || meta.longName || ticker;
        return { label: LABELS[ticker] || ticker, ticker, name, price, change, changePct, marketTime };
      } catch (e) {
        return null;
      }
    }));

    const valid = results.filter(Boolean);
    if (!valid.length) {
      res.status(502).json({ error: 'No data returned from Yahoo Finance' });
      return;
    }

    // Best-effort market cap enrichment — isolated so it can never prevent
    // prices from being returned.
    try {
      const capTickers = valid.map((v) => v.ticker).filter((t) => !NO_CAP.has(t));
      if (capTickers.length) {
        const auth = await getCrumb();
        const caps = await fetchMarketCaps(capTickers, auth);
        valid.forEach((v) => { if (caps[v.ticker] != null) v.marketCap = caps[v.ticker]; });
      }
    } catch (e) {
      // Prices already computed — return them without market caps.
    }

    res.status(200).json(valid);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal error' });
  }
}
