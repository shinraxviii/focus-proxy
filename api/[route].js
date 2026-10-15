// /api/:route — the one serverless function behind every proxy endpoint.
//
// Vercel's Hobby plan allows at most 12 functions per deployment, and every
// file in api/ is a function. The handlers live in lib/ and this file routes
// /api/<name> to lib/<name>.js, so the URLs are unchanged and adding an
// endpoint means adding it to ROUTES below, not a new file in api/.

import arenaMeta from '../lib/arena-meta.js';
import books from '../lib/books.js';
import cfb from '../lib/cfb.js';
import claude from '../lib/claude.js';
import deals from '../lib/deals.js';
import earnings from '../lib/earnings.js';
import fever from '../lib/fever.js';
import fpi from '../lib/fpi.js';
import mtgstocks from '../lib/mtgstocks.js';
import news from '../lib/news.js';
import reddit from '../lib/reddit.js';
import sanderson from '../lib/sanderson.js';
import sorcery from '../lib/sorcery.js';
import standardMeta from '../lib/standard-meta.js';
import stocks from '../lib/stocks.js';
import tmdb from '../lib/tmdb.js';

const ROUTES = {
  'arena-meta': arenaMeta,
  books,
  cfb,
  claude,
  deals,
  earnings,
  fever,
  fpi,
  mtgstocks,
  news,
  reddit,
  sanderson,
  sorcery,
  'standard-meta': standardMeta,
  stocks,
  tmdb,
};

export default function handler(req, res) {
  const name = req.query && req.query.route;
  const route = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!route) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(404).json({ error: 'Unknown endpoint: /api/' + name });
  }
  // The path segment arrives as a query param; hide it from the handler so
  // its own query parsing sees exactly what the caller sent.
  delete req.query.route;
  return route(req, res);
}
