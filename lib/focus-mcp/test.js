// Run: node lib/focus-mcp/test.js   (no Firebase needed; uses fake data shaped like the Focus app's)
import assert from 'node:assert/strict';
import { handleMcpBody, TOOLS } from './protocol.js';
import { dateKey } from './focus.js';

const TZ = 'America/Los_Angeles';
// 2026-11-20 07:30 in Los Angeles = 15:30 UTC.
const NOW = new Date('2026-11-20T15:30:00Z');
const day = (offset) => {
  const d = new Date(NOW); d.setUTCDate(d.getUTCDate() + offset); return dateKey(d, TZ);
};

const tasks = [
  { id: 'a', text: 'Renew passport', date: day(-2), section: 'todo', list: 'personal', color: 'none', notes: 'Photos at CVS' },
  { id: 'b', text: 'Board deck review', date: day(0), section: 'todo', list: 'work', color: 'none' },
  { id: 'c', text: 'Book dentist', date: day(3), section: 'todo', list: 'personal', color: 'none' },
  { id: 'd', text: 'Plan Q1 roadmap', date: '', section: 'todo', list: 'work', color: 'none',
    subtasks: [{ id: 'd1', text: 'Draft themes', done: true }, { id: 'd2', text: 'Review with team', done: false }] },
  { id: 'e', text: 'Learn piano', date: '', section: 'notrightnow', list: 'personal', color: 'none' },
  { id: 'f', text: 'Send invoice', date: day(-1), section: 'completed', list: 'work', color: 'none' },
  { id: 'g', text: 'Far future', date: day(30), section: 'todo', list: 'work', color: 'none' },
  { id: 'r', text: 'Folate - Nov 16', date: '', section: 'todo', list: 'personal', color: 'none', recurringKey: 'folate', weekOf: 1,
    subtasks: [{ id: 'r1', text: '1', done: true }, { id: 'r2', text: '2', done: false }, { id: 'r3', text: '3', done: false }] },
];
const log = [
  { id: 'f', text: 'Send invoice', timestamp: NOW.getTime() - 20 * 3600e3 },
  { id: 'z', text: 'Old thing', timestamp: NOW.getTime() - 20 * 86400e3 },
];
const ctx = { loadData: async () => ({ tasks, log }), tz: TZ, now: NOW };
const rpc = (method, params, id = 1) => handleMcpBody({ jsonrpc: '2.0', id, method, params }, ctx);
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;

// Protocol basics
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
assert.equal(init.result.protocolVersion, '2025-06-18');
assert.ok(init.result.capabilities.tools);
assert.equal(await handleMcpBody({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
const list = await rpc('tools/list');
assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
assert.equal((await rpc('nope/method')).error.code, -32601);

// Daily briefing
const b = await call('get_daily_briefing');
assert.equal(b.today, '2026-11-20');
assert.deepEqual(b.overdue.map((t) => t.id), ['a']);
assert.equal(b.overdue[0].due_label, '2 days overdue');
assert.equal(b.overdue[0].notes, 'Photos at CVS');
assert.deepEqual(b.due_today.map((t) => t.id), ['b']);
assert.deepEqual(b.due_next_7_days.map((t) => t.id), ['c']);
assert.deepEqual(b.no_due_date.map((t) => t.id), ['d']);
assert.equal(b.no_due_date[0].subtasks, '1/2 done');
assert.deepEqual(b.weekly_recurring.map((t) => t.id), ['r']);
assert.equal(b.weekly_recurring[0].subtasks, '1/3 done');
assert.deepEqual(b.counts, { personal: { open: 3, parked: 1 }, work: { open: 3, parked: 0 } });
assert.deepEqual(b.completed_last_2_days, [{ text: 'Send invoice', completed_on: '2026-11-19' }]);

// Wider horizon picks up the far-future task
assert.ok((await call('get_daily_briefing', { horizon_days: 31 })).due_next_31_days.some((t) => t.id === 'g'));

// list_tasks
assert.deepEqual((await call('list_tasks', { list: 'work' })).tasks.map((t) => t.id), ['b', 'g', 'd']);
assert.deepEqual((await call('list_tasks', { section: 'notrightnow' })).tasks.map((t) => t.id), ['e']);
assert.equal((await call('list_tasks', { section: 'all', limit: 2 })).tasks.length, 2);

// search_tasks (text, notes, sub-items; completed excluded by default)
assert.deepEqual((await call('search_tasks', { query: 'cvs' })).tasks.map((t) => t.id), ['a']);
assert.deepEqual((await call('search_tasks', { query: 'review' })).tasks.map((t) => t.id), ['b', 'd']);
assert.equal((await call('search_tasks', { query: 'invoice' })).total, 0);
assert.equal((await call('search_tasks', { query: 'invoice', include_completed: true })).total, 1);
assert.equal((await rpc('tools/call', { name: 'search_tasks', arguments: {} })).error.code, -32602);

// get_completed_tasks
assert.equal((await call('get_completed_tasks', { days: 7 })).total, 1);
assert.equal((await call('get_completed_tasks', { days: 30 })).total, 2);

// Firestore failure surfaces as a tool error, not a crash
const bad = await handleMcpBody({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } },
  { ...ctx, loadData: async () => { throw new Error('boom'); } });
assert.equal(bad.result.isError, true);

// ── Write tools ────────────────────────────────────────────────
// In-memory stand-in for the Firestore docs; mutate() works like lib/mcp.js's.
function memStore(init) {
  const docs = JSON.parse(JSON.stringify(init));
  const writes = [];
  return {
    docs, writes,
    ctx: {
      tz: TZ, now: NOW,
      loadData: async () => ({ tasks: [...docs.tasks, ...docs.recurring], log: docs.log }),
      mutate: async (apply) => {
        const state = JSON.parse(JSON.stringify(docs));
        const { result, touched } = apply(state);
        for (const n of touched) { docs[n] = state[n]; writes.push(n); }
        return result;
      },
    },
  };
}
const store = memStore({
  tasks: tasks.filter((t) => !t.recurringKey),
  recurring: tasks.filter((t) => t.recurringKey),
  log,
});
const wcall = async (name, args) => {
  const out = await handleMcpBody({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, store.ctx);
  return out.result;
};
const ok = async (name, args) => {
  const r = await wcall(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
  return r.structuredContent;
};
const fails = async (name, args, re) => {
  const r = await wcall(name, args);
  assert.equal(r.isError, true, `${name} should fail`);
  assert.match(r.content[0].text, re);
};
const find = (id) => [...store.docs.tasks, ...store.docs.recurring].find((t) => t.id === id);

// tools/list advertises the write tools as not read-only
const names = (await rpc('tools/list')).result.tools.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name);
assert.deepEqual(names, ['add_task', 'complete_task', 'set_subtask_done', 'update_task', 'move_task']);

// add_task: defaults, shape matches the app's addTask, sub-items get ids
const added = (await ok('add_task', { text: '  Call plumber ', due: '2026-11-24', subtasks: ['Get quote'] })).added;
const nt = find(added.id);
assert.equal(nt.text, 'Call plumber');
assert.deepEqual(
  { date: nt.date, color: nt.color, link: nt.link, section: nt.section, list: nt.list },
  { date: '2026-11-24', color: 'none', link: '', section: 'todo', list: 'personal' });
assert.match(nt.id, /^[0-9a-z]{7}$/);
assert.equal(nt.subtasks[0].done, false);
assert.ok(store.docs.tasks.includes(nt) || store.docs.tasks.some((t) => t.id === nt.id));
const parked = (await ok('add_task', { text: 'Someday', list: 'work', section: 'notrightnow' })).added;
assert.deepEqual([parked.list, parked.section], ['work', 'notrightnow']);
await fails('add_task', { text: '   ' }, /text/);
await fails('add_task', { text: 'x', due: '2026-02-30' }, /real date/);
await fails('add_task', { text: 'x', section: 'completed' }, /section/);
await fails('add_task', { text: 'x', list: 'home' }, /list/);
// the new task is visible to the read tools
assert.equal((await handleMcpBody({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_tasks', arguments: { query: 'plumber' } } }, store.ctx)).result.structuredContent.total, 1);

// complete_task: like toggleComplete, plus completion log; safe to repeat
store.writes.length = 0;
await ok('complete_task', { task_id: 'b' });
assert.equal(find('b').section, 'completed');
assert.equal(find('b').completedAt, NOW.getTime());
assert.deepEqual(store.writes, ['tasks', 'log']);
const logLen = store.docs.log.length;
assert.deepEqual(store.docs.log.at(-1), { id: 'b', text: 'Board deck review', timestamp: NOW.getTime() });
assert.equal((await ok('complete_task', { task_id: 'b' })).changed, false);
assert.equal(store.docs.log.length, logLen, 'no duplicate log entry');
// un-complete puts it back and removes today's log entry
await ok('complete_task', { task_id: 'b', completed: false });
assert.equal(find('b').section, 'todo');
assert.equal(find('b').completedAt, undefined);
assert.equal(store.docs.log.length, logLen - 1);
// recurring tasks are written to the recurring doc
store.writes.length = 0;
await ok('complete_task', { task_id: 'r' });
assert.deepEqual(store.writes, ['recurring', 'log']);
await fails('complete_task', { task_id: 'nope' }, /No Focus task/);

// set_subtask_done
const before = store.docs.log.length;
await ok('set_subtask_done', { task_id: 'd', subtask_id: 'd2' });
assert.equal(find('d').subtasks[1].done, true);
assert.equal(find('d').section, 'todo', 'parent stays put');
assert.equal(store.docs.log.length, before + 1);
await ok('set_subtask_done', { task_id: 'd', subtask_id: 'd2', done: false });
assert.equal(find('d').subtasks[1].done, false);
assert.equal(store.docs.log.length, before);
await fails('set_subtask_done', { task_id: 'd', subtask_id: 'zz' }, /no sub-item/);
// sub-item ids are exposed to Claude by the read tools
assert.deepEqual(b.no_due_date[0].subtask_list, [{ id: 'd1', text: 'Draft themes', done: true }, { id: 'd2', text: 'Review with team', done: false }]);

// update_task: only passed fields change
await ok('update_task', { task_id: 'a', text: 'Renew passport (both)', due: '' });
assert.deepEqual([find('a').text, find('a').date, find('a').notes], ['Renew passport (both)', '', 'Photos at CVS']);
await ok('update_task', { task_id: 'a', notes: '', list: 'work' });
assert.deepEqual([find('a').notes, find('a').list], ['', 'work']);
await ok('update_task', { task_id: 'd', add_subtasks: ['Share doc'], remove_subtask_ids: ['d1'] });
assert.deepEqual(find('d').subtasks.map((s) => s.text), ['Review with team', 'Share doc']);
store.writes.length = 0;
assert.equal((await ok('update_task', { task_id: 'a', notes: '' })).changed, false);
assert.deepEqual(store.writes, [], 'no-op edit writes nothing');
await fails('update_task', { task_id: 'a' }, /Nothing to change/);
await fails('update_task', { task_id: 'a', text: '' }, /empty/);
await fails('update_task', { task_id: 'd', remove_subtask_ids: ['zz'] }, /No sub-item/);
await fails('update_task', { task_id: 'r', add_subtasks: ['4'] }, /recurring/);
await ok('update_task', { task_id: 'r', notes: 'with breakfast' });

// move_task
await ok('move_task', { task_id: 'c', section: 'notrightnow' });
assert.equal(find('c').section, 'notrightnow');
await ok('move_task', { task_id: 'c', section: 'todo' });
assert.equal(find('c').section, 'todo');
await fails('move_task', { task_id: 'f', section: 'todo' }, /completed/);
await fails('move_task', { task_id: 'c' }, /section/);

// A Firestore failure during a write surfaces as a tool error
const badW = await handleMcpBody({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_task', arguments: { text: 'x' } } },
  { ...ctx, mutate: async () => { throw new Error('boom'); } });
assert.equal(badW.result.isError, true);
assert.match(badW.result.content[0].text, /Could not change Focus data/);

console.log('All connector tests passed.');
console.log('\nSample get_daily_briefing output:\n' + JSON.stringify(b, null, 2));
