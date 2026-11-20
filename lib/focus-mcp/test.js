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

console.log('All connector tests passed.');
console.log('\nSample get_daily_briefing output:\n' + JSON.stringify(b, null, 2));
