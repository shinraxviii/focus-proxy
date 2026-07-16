// api/books.js — Book metadata (cover, blurb, year) for the "From the Shelf"
// card. Runs server-side to avoid client-side CORS and per-user rate limits
// (keyless Google Books frequently 429s from browsers). Google Books is the
// primary source; Open Library is a keyless fallback for the cover.

async function googleBooks(title, author) {
  const q = 'intitle:' + encodeURIComponent('"' + title + '"')
    + '+inauthor:' + encodeURIComponent('"' + author + '"');
  const url = 'https://www.googleapis.com/books/v1/volumes?q=' + q + '&maxResults=1&country=US';
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('google ' + r.status);
  const data = await r.json();
  const vi = (data.items && data.items[0] && data.items[0].volumeInfo) || null;
  if (!vi) return null;
  let cover = '';
  if (vi.imageLinks) {
    cover = (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || '')
      .replace(/^http:/, 'https:').replace('&edge=curl', '');
  }
  return {
    year: vi.publishedDate ? String(vi.publishedDate).slice(0, 4) : '',
    blurb: vi.description || '',
    cover,
    link: vi.infoLink || '',
  };
}

async function openLibrary(title, author) {
  const url = 'https://openlibrary.org/search.json?title=' + encodeURIComponent(title)
    + '&author=' + encodeURIComponent(author) + '&limit=1&fields=cover_i,first_publish_year,key';
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('openlibrary ' + r.status);
  const data = await r.json();
  const doc = data.docs && data.docs[0];
  if (!doc) return null;
  return {
    year: doc.first_publish_year ? String(doc.first_publish_year) : '',
    cover: doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-L.jpg' : '',
    link: doc.key ? 'https://openlibrary.org' + doc.key : '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800'); // 24h CDN cache
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const title = (req.query.title || '').toString().trim();
  const author = (req.query.author || '').toString().trim();
  if (!title || !author) {
    res.status(400).json({ error: 'title and author are required' });
    return;
  }

  const searchLink = 'https://www.google.com/search?tbm=bks&q=' + encodeURIComponent(title + ' ' + author);
  let out = { title, author, year: '', blurb: '', cover: '', link: searchLink };

  // Primary: Google Books (rich blurb + cover)
  try {
    const g = await googleBooks(title, author);
    if (g) out = { ...out, ...g, link: g.link || out.link };
  } catch (e) { /* fall through to Open Library */ }

  // Fallback: fill a missing cover from Open Library (keyless, rarely throttled)
  if (!out.cover) {
    try {
      const o = await openLibrary(title, author);
      if (o) {
        if (o.cover) out.cover = o.cover;
        if (!out.year && o.year) out.year = o.year;
        if (!out.link && o.link) out.link = o.link;
      }
    } catch (e) { /* keep what we have */ }
  }

  res.status(200).json(out);
}
