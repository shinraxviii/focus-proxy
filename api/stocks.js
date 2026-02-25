// api/stocks.js  — deploy alongside api/claude.js in your Vercel project
// Fetches Yahoo Finance server-side (no CORS issues) and returns clean JSON

export default async function handler(req, res) {
  // CORS — allow your GitHub Pages domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5min CDN cache

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const TICKERS = ['APP','U','AAPL','TSLA','META','GOOG','NVDA','^GSPC','^IXIC','BTC-USD','ETH-USD','SOL-USD','GC=F','SI=F','PL=F','CL=F'];
  const LABELS  = { 'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'SOL-USD': 'SOL', '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq', 'GC=F': 'Gold', 'SI=F': 'Silver', 'PL=F': 'Platinum', 'CL=F': 'Oil' };
  const NAMES   = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana', '^GSPC': 'S&P 500 Index', '^IXIC': 'Nasdaq Composite', 'GC=F': 'Gold Futures', 'SI=F': 'Silver Futures', 'PL=F': 'Platinum Futures', 'CL=F': 'Crude Oil' };

  try {
    const results = await Promise.all(TICKERS.map(async (ticker) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
        const r = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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

    res.status(200).json(valid);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal error' });
  }
}
