// Write operations for the Focus connector. Pure functions over plain
// objects (no Firebase), so they can be tested without a network.
//
// Each operation receives `state` = { tasks, recurring, log }: the raw
// contents of the users/{uid}/data/{tasks,recurring,log} documents, exactly as
// the Focus app stores them. It mutates `state` in place, mirroring what the
// app itself does for the same action (see index.html: addTask,
// toggleComplete, the sub-item checkbox handler, onDrop, editTask), and
// returns { result, touched } where `touched` lists the documents to write.
//
// Every operation is safe to re-run on fresh data (the connector retries when
// a document changed between read and write), so "complete" means "make it
// completed", not "toggle".
import { dateKey } from './focus.js';

export class ToolError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500;
const MAX_NOTES = 5000;
const MAX_SUBTASKS = 50;

// Same id shape as the app's genId(): 7 base-36 characters.
function newId(taken) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(7));
    const id = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function allIds(state) {
  const ids = new Set();
  for (const t of [...state.tasks, ...state.recurring]) {
    ids.add(t.id);
    for (const s of t.subtasks || []) ids.add(s.id);
  }
  return ids;
}

// ── validation ─────────────────────────────────────────────────
function cleanText(v, field, { required = false, max = MAX_TEXT } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new ToolError(`${field} cannot be empty`);
  if (s.length > max) throw new ToolError(`${field} is too long (max ${max} characters)`);
  return s;
}

function cleanDate(v, field = 'due') {
  if (v === undefined || v === null) return undefined;
  if (v === '') return '';
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new ToolError(`${field} must be YYYY-MM-DD, or "" to clear it`);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ToolError(`${field} is not a real date: ${v}`);
  }
  return v;
}

function cleanEnum(v, field, allowed, def) {
  if (v === undefined || v === null) return def;
  if (!allowed.includes(v)) throw new ToolError(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

function cleanStringList(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError(`${field} must be a list of strings`);
  if (v.length > MAX_SUBTASKS) throw new ToolError(`${field} has too many items (max ${MAX_SUBTASKS})`);
  return v.map((s, i) => cleanText(s, `${field}[${i}]`, { required: true }));
}

function cleanId(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${field} is required`);
  return v.trim();
}

// ── lookup ─────────────────────────────────────────────────────
// Weekly recurring tasks live in the 'recurring' doc, everything else in
// 'tasks'. (Very old data could hold recurring tasks in 'tasks'; the app
// migrates those on its next save, so the 'recurring' copy wins.)
function findTask(state, id) {
  const r = state.recurring.find((t) => t.id === id);
  if (r) return { task: r, doc: 'recurring' };
  const m = state.tasks.find((t) => t.id === id);
  if (m) return { task: m, doc: 'tasks' };
  throw new ToolError(`No Focus task with id "${id}". Use list_tasks or search_tasks to find the id.`);
}

// ── completion history (mirrors logCompletion / unlogCompletion) ──
function logCompletion(state, item, now, tz) {
  const today = dateKey(now, tz);
  const already = state.log.some((e) => e.id === item.id && e.timestamp && dateKey(new Date(e.timestamp), tz) === today);
  if (already) return false;
  state.log.push({ id: item.id, text: item.text, timestamp: now.getTime() });
  return true;
}

function unlogCompletion(state, id, now, tz) {
  const today = dateKey(now, tz);
  const before = state.log.length;
  state.log = state.log.filter((e) => !(e.id === id && e.timestamp && dateKey(new Date(e.timestamp), tz) === today));
  return state.log.length !== before;
}

function summary(t) {
  const out = { id: t.id, text: t.text, list: t.list, section: t.section };
  if (t.date) out.due = t.date;
  if (t.notes) out.notes = t.notes;
  if (Array.isArray(t.subtasks) && t.subtasks.length) {
    out.subtask_list = t.subtasks.map((s) => ({ id: s.id, text: s.text, done: !!s.done }));
  }
  if (t.recurringKey) out.recurring = 'weekly';
  return out;
}

// ── operations ─────────────────────────────────────────────────
export function addTask(state, args) {
  const text = cleanText(args.text, 'text', { required: true });
  const list = cleanEnum(args.list, 'list', ['personal', 'work'], 'personal');
  const section = cleanEnum(args.section, 'section', ['todo', 'notrightnow'], 'todo');
  const date = cleanDate(args.due) || '';
  const notes = cleanText(args.notes, 'notes', { max: MAX_NOTES });
  const subs = cleanStringList(args.subtasks, 'subtasks');

  const ids = allIds(state);
  const task = { id: newId(ids), text, date, color: 'none', link: '', section, list };
  if (notes) task.notes = notes;
  if (subs.length) task.subtasks = subs.map((s) => ({ id: newId(ids), text: s, done: false }));
  state.tasks.push(task);
  return { result: { added: summary(task) }, touched: ['tasks'] };
}

export function completeTask(state, args, { now, tz }) {
  const id = cleanId(args.task_id, 'task_id');
  const completed = args.completed === undefined ? true : args.completed;
  if (typeof completed !== 'boolean') throw new ToolError('completed must be true or false');
  const { task, doc } = findTask(state, id);
  const touched = [];

  if (completed) {
    if (task.section !== 'completed') {
      task.section = 'completed';
      task.completedAt = now.getTime();
      touched.push(doc);
    }
    if (logCompletion(state, task, now, tz)) touched.push('log');
  } else {
    if (task.section === 'completed') {
      task.section = 'todo';
      delete task.completedAt;
      delete task.done;
      touched.push(doc);
    }
    if (unlogCompletion(state, task.id, now, tz)) touched.push('log');
  }
  return { result: { changed: touched.includes(doc), task: summary(task) }, touched };
}

export function setSubtaskDone(state, args, { now, tz }) {
  const id = cleanId(args.task_id, 'task_id');
  const subId = cleanId(args.subtask_id, 'subtask_id');
  const done = args.done === undefined ? true : args.done;
  if (typeof done !== 'boolean') throw new ToolError('done must be true or false');
  const { task, doc } = findTask(state, id);
  const st = (task.subtasks || []).find((s) => s.id === subId);
  if (!st) throw new ToolError(`Task "${task.text}" has no sub-item with id "${subId}". Its sub-items are listed in subtask_list.`);

  const touched = [];
  if (!!st.done !== done) { st.done = done; touched.push(doc); }
  if (done ? logCompletion(state, st, now, tz) : unlogCompletion(state, st.id, now, tz)) touched.push('log');
  return { result: { changed: touched.includes(doc), task: summary(task) }, touched };
}

export function updateTask(state, args) {
  const id = cleanId(args.task_id, 'task_id');
  const text = cleanText(args.text, 'text');
  if (text === '') throw new ToolError('text cannot be empty');
  const notes = cleanText(args.notes, 'notes', { max: MAX_NOTES });
  const date = cleanDate(args.due);
  const list = cleanEnum(args.list, 'list', ['personal', 'work'], undefined);
  const add = cleanStringList(args.add_subtasks, 'add_subtasks');
  let remove = [];
  if (args.remove_subtask_ids !== undefined && args.remove_subtask_ids !== null) {
    if (!Array.isArray(args.remove_subtask_ids)) throw new ToolError('remove_subtask_ids must be a list of ids');
    remove = args.remove_subtask_ids.map((v, i) => cleanId(v, `remove_subtask_ids[${i}]`));
  }
  if ([text, notes, date, list].every((v) => v === undefined) && !add.length && !remove.length) {
    throw new ToolError('Nothing to change: pass at least one of text, notes, due, list, add_subtasks, remove_subtask_ids');
  }

  const { task, doc } = findTask(state, id);
  if (task.recurringKey && (list !== undefined || add.length || remove.length)) {
    throw new ToolError('This is a weekly recurring task the Focus app generates; only its text, notes and due date can be edited.');
  }
  const existing = task.subtasks || [];
  const missing = remove.filter((r) => !existing.some((s) => s.id === r));
  if (missing.length) throw new ToolError(`No sub-item with id ${missing.map((m) => `"${m}"`).join(', ')} on this task.`);
  if (existing.length - remove.length + add.length > MAX_SUBTASKS) throw new ToolError(`A task can have at most ${MAX_SUBTASKS} sub-items`);

  const before = JSON.stringify(task);
  if (text !== undefined) task.text = text;
  if (notes !== undefined) task.notes = notes;
  if (date !== undefined) task.date = date;
  if (list !== undefined) task.list = list;
  if (remove.length || add.length) {
    const ids = allIds(state);
    task.subtasks = existing
      .filter((s) => !remove.includes(s.id))
      .concat(add.map((s) => ({ id: newId(ids), text: s, done: false })));
  }
  const changed = JSON.stringify(task) !== before;
  return { result: { changed, task: summary(task) }, touched: changed ? [doc] : [] };
}

export function moveTask(state, args) {
  const id = cleanId(args.task_id, 'task_id');
  const section = cleanEnum(args.section, 'section', ['todo', 'notrightnow'], undefined);
  if (!section) throw new ToolError('section is required: todo or notrightnow');
  const { task, doc } = findTask(state, id);
  if (task.section === 'completed') {
    throw new ToolError('This task is completed. Use complete_task with completed=false to bring it back to To do.');
  }
  const changed = task.section !== section;
  if (changed) task.section = section;
  return { result: { changed, task: summary(task) }, touched: changed ? [doc] : [] };
}

export const OPERATIONS = {
  add_task: addTask,
  complete_task: completeTask,
  set_subtask_done: setSubtaskDone,
  update_task: updateTask,
  move_task: moveTask,
};
