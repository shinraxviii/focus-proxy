// Vercel serverless function: /api/deals
// Combines CheapShark API (game deals) + Slickdeals RSS (tech/electronics)
// No API keys needed for either source

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const deals = [];

  // ── Source 1: CheapShark (PC game deals) ──
  try {
    const csUrl = 'https://www.cheapshark.com/api/1.0/deals?pageSize=8&sortBy=Deal+Rating&upperPrice=60&metacritic=60';
    const csRes = await fetch(csUrl, {
      headers: { 'User-Agent': 'FocusDashboard/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (csRes.ok) {
      const csData = await csRes.json();
      for (const d of csData.slice(0, 5)) {
        const sale = parseFloat(d.salePrice);
        const normal = parseFloat(d.normalPrice);
        const pct = Math.round(parseFloat(d.savings));
        if (pct < 15) continue; // skip tiny discounts
        deals.push({
          title: d.title,
          salePrice: '$' + sale.toFixed(2),
          normalPrice: '$' + normal.toFixed(2),
          savings: pct + '% off',
          source: 'CheapShark',
          url: 'https://www.cheapshark.com/redirect?dealID=' + d.dealID,
          score: pct, // for sorting
        });
      }
    }
  } catch (e) {
    console.error('[deals] CheapShark error:', e.message);
  }

  // ── Source 2: Slickdeals Frontpage RSS ──
  try {
    const sdUrl = 'https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1';
    const sdRes = await fetch(sdUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FocusDashboard/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (sdRes.ok) {
      const xml = await sdRes.text();

      // Parse RSS items with regex (lightweight, no XML parser needed)
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 12) {
        const block = match[1];
        const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
        const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';

        // Filter for tech/gaming/electronics keywords
        const lc = title.toLowerCase();
        const techKeywords = [
          'tv', 'oled', 'qled', 'monitor', 'laptop', 'tablet', 'ipad', 'macbook',
          'headphone', 'earbuds', 'airpods', 'speaker', 'soundbar',
          'ssd', 'gpu', 'ram', 'cpu', 'processor', 'graphics card', 'nvme',
          'keyboard', 'mouse', 'controller', 'gamepad', 'joystick',
          'xbox', 'playstation', 'ps5', 'ps4', 'nintendo', 'switch', 'steam deck',
          'game', 'gaming', 'console',
          'phone', 'iphone', 'samsung', 'pixel', 'galaxy',
          'camera', 'gopro', 'drone', 'robot', 'vacuum',
          'router', 'wifi', 'mesh', 'nas', 'hard drive', 'storage',
          'charger', 'usb-c', 'cable', 'adapter', 'hub', 'dock',
          'smart home', 'alexa', 'echo', 'ring', 'nest',
          'apple watch', 'fitbit', 'garmin', 'wearable',
          'projector', '4k', '8k', 'uhd', 'hdr',
          'pc', 'desktop', 'mini pc', 'chromebook',
          'dell', 'hp', 'lenovo', 'asus', 'acer', 'razer', 'corsair', 'logitech',
          'sony', 'lg', 'bose', 'jbl', 'anker',
          'nvidia', 'amd', 'intel', 'rtx', 'radeon',
          'vr', 'meta quest', 'oculus',
          'power bank', 'battery', 'ups',
          'subscription', 'game pass', 'ps plus', 'ea play',
        ];

        const isTech = techKeywords.some(kw => lc.includes(kw));
        if (!isTech) continue;

        // Try to extract price from title (e.g., "$299.99" or "$49")
        const priceMatch = title.match(/\$[\d,]+(?:\.\d{2})?/);
        const salePrice = priceMatch ? priceMatch[0] : '';

        items.push({ title, link, salePrice });
      }

      for (const item of items.slice(0, 5)) {
        deals.push({
          title: item.title.replace(/<[^>]*>/g, '').trim(),
          salePrice: item.salePrice || 'See deal',
          normalPrice: '',
          savings: '',
          source: 'Slickdeals',
          url: item.link,
          score: 50, // frontpage deals are already curated/popular
        });
      }
    }
  } catch (e) {
    console.error('[deals] Slickdeals error:', e.message);
  }

  if (deals.length === 0) {
    return res.status(502).json({ error: 'No deals fetched from any source' });
  }

  // Interleave sources: alternate CheapShark and Slickdeals
  const cs = deals.filter(d => d.source === 'CheapShark');
  const sd = deals.filter(d => d.source === 'Slickdeals');
  const merged = [];
  const maxLen = Math.max(cs.length, sd.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < sd.length) merged.push(sd[i]); // Slickdeals first (broader appeal)
    if (i < cs.length) merged.push(cs[i]);
  }

  // Clean up internal score field
  const result = merged.slice(0, 6).map(({ score, ...rest }) => rest);

  return res.status(200).json(result);
}
