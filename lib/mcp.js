// /api/mcp — read-only MCP connector that lets Claude (Claude Duet, claude.ai,
// Claude Code) read the Focus to-do list.
//
//   POST /api/mcp?t=<Firebase refresh token>     (MCP Streamable HTTP, JSON responses)
//
// The Focus app's "Connect Claude" button builds this URL from the signed-in
// user's refresh token. The token is exchanged for a 1-hour ID token and the
// tasks are read through the Firestore REST API as that user, so Firestore's
// own security rules still apply and no service account or env vars are needed.
// The URL is a credential: anyone holding it can act as the user in Firebase.
//
// Reads the same documents the app writes: users/{uid}/data/{tasks,recurring,log},
// each storing its payload as a JSON string field.
import { handleMcpBody } from './focus-mcp/protocol.js';

// Public web config from the Focus app (index.html); not a secret.
const FIREBASE_API_KEY = 'AIzaSyDB9EPuLVQXLhVBaZwIt0kQ-4GQQZjfT2g';
const PROJECT_ID = 'focus-app-38732';
const TZ = 'America/Los_Angeles';

// Warm-instance cache of ID tokens, keyed by refresh token.
const idTokens = new Map();

async function signIn(refreshToken) {
  const hit = idTokens.get(refreshToken);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!r.ok) {
    idTokens.delete(refreshToken);
    const err = new Error('Focus sign-in expired. Tap "Connect Claude" in Focus to get a new link.');
    err.status = 401;
    throw err;
  }
  const j = await r.json();
  const entry = { idToken: j.id_token, uid: j.user_id, expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000 };
  idTokens.set(refreshToken, entry);
  return entry;
}

async function readDoc({ idToken, uid }, name, field) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}/data/${name}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Firestore ${name}: HTTP ${r.status}`);
  const j = await r.json();
  try { return JSON.parse(j.fields?.[field]?.stringValue || '[]'); } catch { return []; }
}

function loader(refreshToken) {
  return async () => {
    const session = await signIn(refreshToken);
    const [main, recurring, log] = await Promise.all([
      readDoc(session, 'tasks', 'tasks'),
      readDoc(session, 'recurring', 'recurring'),
      readDoc(session, 'log', 'log'),
    ]);
    return { tasks: [...main.filter((t) => !t.recurringKey), ...recurring], log };
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = String((req.query && req.query.t) || '');
  if (token.length < 40) return res.status(401).json({ error: 'missing token' });

  if (req.method === 'GET') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Check the token up front so a bad link fails at "Add connector" time, not mid-chat.
  try { await signIn(token); } catch (e) { return res.status(e.status || 502).json({ error: e.message }); }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
  }
  const out = await handleMcpBody(body, { loadData: loader(token), tz: TZ });
  if (out === null) return res.status(202).end();
  return res.status(200).json(out);
}
