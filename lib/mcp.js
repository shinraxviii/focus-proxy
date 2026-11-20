// /api/mcp — MCP connector that lets Claude (Claude Duet, claude.ai,
// Claude Code) read and change the Focus to-do list.
//
//   POST /api/mcp?t=<Firebase refresh token>     (MCP Streamable HTTP, JSON responses)
//
// The Focus app's "Connect Claude" button builds this URL from the signed-in
// user's refresh token. The token is exchanged for a 1-hour ID token and the
// tasks are read and written through the Firestore REST API as that user, so Firestore's
// own security rules still apply and no service account or env vars are needed.
// The URL is a credential: anyone holding it can act as the user in Firebase.
//
// Reads and writes the same documents the app does: users/{uid}/data/{tasks,recurring,log},
// each storing its payload as a JSON string field. Writes replace the whole
// document like the app's setDoc, but only if the document is unchanged since
// it was read (Firestore updateTime precondition); otherwise the change is
// re-applied to fresh data, so a concurrent save from the app is never lost.
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

const DOCS = ['tasks', 'recurring', 'log']; // each doc's field has the same name as the doc

function docUrl({ uid }, name) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}/data/${name}`;
}

// Returns { value: [...], updateTime } (updateTime null when the doc doesn't exist).
async function readDocMeta(session, name) {
  const r = await fetch(docUrl(session, name), { headers: { Authorization: `Bearer ${session.idToken}` } });
  if (r.status === 404) return { value: [], updateTime: null };
  if (!r.ok) throw new Error(`Firestore ${name}: HTTP ${r.status}`);
  const j = await r.json();
  let value = [];
  try { value = JSON.parse(j.fields?.[name]?.stringValue || '[]'); } catch { value = []; }
  if (!Array.isArray(value)) value = [];
  return { value, updateTime: j.updateTime || null };
}

// Replaces the doc's payload if it is still at `updateTime` (or still missing).
// Returns true on success, false when someone else wrote it first.
async function writeDoc(session, name, value, updateTime) {
  const precondition = updateTime
    ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}`
    : 'currentDocument.exists=false';
  const r = await fetch(`${docUrl(session, name)}?${precondition}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [name]: { stringValue: JSON.stringify(value) } } }),
  });
  if (r.ok) return true;
  const text = await r.text().catch(() => '');
  if (r.status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS|NOT_FOUND/.test(text)) return false;
  throw new Error(`Firestore write ${name}: HTTP ${r.status}`);
}

function loader(refreshToken) {
  return async () => {
    const session = await signIn(refreshToken);
    const [main, recurring, log] = await Promise.all(DOCS.map((n) => readDocMeta(session, n)));
    return { tasks: [...main.value.filter((t) => !t.recurringKey), ...recurring.value], log: log.value };
  };
}

const MAX_ATTEMPTS = 4;

// Read all three docs, let `apply` change them, write back the ones it touched.
// Task docs are written before the log, and operations are safe to re-run, so
// a conflict on any write just starts over on fresh data.
function mutator(refreshToken) {
  return async (apply) => {
    const session = await signIn(refreshToken);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const metas = await Promise.all(DOCS.map((n) => readDocMeta(session, n)));
      const state = Object.fromEntries(DOCS.map((n, i) => [n, metas[i].value]));
      const original = DOCS.map((n) => JSON.stringify(state[n]));
      const { result, touched } = apply(state); // may throw ToolError: nothing written
      let conflict = false;
      for (const [i, name] of DOCS.entries()) {
        if (!touched.includes(name) || JSON.stringify(state[name]) === original[i]) continue;
        if (!(await writeDoc(session, name, state[name], metas[i].updateTime))) { conflict = true; break; }
      }
      if (!conflict) return result;
    }
    throw new Error('Focus data kept changing while saving. Try again in a moment.');
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
  const out = await handleMcpBody(body, { loadData: loader(token), mutate: mutator(token), tz: TZ });
  if (out === null) return res.status(202).end();
  return res.status(200).json(out);
}
