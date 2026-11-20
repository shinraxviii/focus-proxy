// Run: node lib/focus-mcp/test-firestore.js
// Exercises lib/mcp.js end to end against a fake Firebase (sign-in + Firestore
// REST), including the "app saved at the same moment" conflict path.
import assert from 'node:assert/strict';
import handler from '../mcp.js';

const TOKEN = 'r'.repeat(60);
const UID = 'user123';
let clock = 1;
// Fake Firestore: name -> { value, updateTime }
const db = {
  tasks: { value: [{ id: 'a', text: 'Renew passport', date: '', color: 'none', link: '', section: 'todo', list: 'personal' }], updateTime: 't1' },
  recurring: { value: [], updateTime: 't1' },
  // no 'log' doc yet: must be created with exists=false
};
let interfere = 0; // number of upcoming PATCHes on 'tasks' to pre-empt with a "concurrent app save"
const patches = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'securetoken.googleapis.com') {
    return Response.json({ id_token: 'id-token', user_id: UID, expires_in: '3600' });
  }
  const m = u.pathname.match(/\/documents\/users\/([^/]+)\/data\/([^/]+)$/);
  assert.ok(m, 'unexpected URL ' + url);
  assert.equal(decodeURIComponent(m[1]), UID);
  assert.equal(opts.headers.Authorization, 'Bearer id-token');
  const name = m[2];
  const cur = db[name];
  if (!opts.method || opts.method === 'GET') {
    if (!cur) return new Response('{}', { status: 404 });
    return Response.json({ fields: { [name]: { stringValue: JSON.stringify(cur.value) } }, updateTime: cur.updateTime });
  }
  assert.equal(opts.method, 'PATCH');
  if (name === 'tasks' && interfere > 0) {
    interfere--;
    // The Focus app saves just before us: someone added a task.
    cur.value = [...cur.value, { id: 'app1', text: 'Added in app', date: '', color: 'none', link: '', section: 'todo', list: 'work' }];
    cur.updateTime = 't' + ++clock;
  }
  const wantTime = u.searchParams.get('currentDocument.updateTime');
  const wantMissing = u.searchParams.get('currentDocument.exists') === 'false';
  if ((wantTime && (!cur || cur.updateTime !== wantTime)) || (wantMissing && cur)) {
    return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
  }
  const body = JSON.parse(opts.body);
  db[name] = { value: JSON.parse(body.fields[name].stringValue), updateTime: 't' + ++clock };
  patches.push(name);
  return Response.json({});
};

async function rpc(method, params) {
  let status = 0, payload;
  const res = {
    setHeader() {},
    status(s) { status = s; return this; },
    json(j) { payload = j; return this; },
    end() { return this; },
  };
  await handler({ method: 'POST', query: { t: TOKEN }, body: { jsonrpc: '2.0', id: 1, method, params } }, res);
  assert.equal(status, 200);
  return payload.result;
}
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return r.structuredContent;
};

// Add a task while the app saves concurrently: our write is retried on fresh data.
interfere = 1;
const { added } = await tool('add_task', { text: 'Call plumber' });
assert.deepEqual(db.tasks.value.map((t) => t.text), ['Renew passport', 'Added in app', 'Call plumber']);
assert.deepEqual(patches, ['tasks']);

// Complete it: tasks doc updated and the missing log doc created.
await tool('complete_task', { task_id: added.id });
assert.equal(db.tasks.value.find((t) => t.id === added.id).section, 'completed');
assert.equal(db.log.value.length, 1);
assert.equal(db.log.value[0].id, added.id);

// Reads see the change.
const done = await tool('list_tasks', { section: 'completed' });
assert.deepEqual(done.tasks.map((t) => t.text), ['Call plumber']);

// Endless conflicts give up with an error instead of looping.
interfere = 99;
const r = await rpc('tools/call', { name: 'add_task', arguments: { text: 'Never lands' } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /kept changing/);
assert.ok(!db.tasks.value.some((t) => t.text === 'Never lands'));

console.log('Firestore write path tests passed.');
