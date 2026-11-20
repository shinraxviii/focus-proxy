// Minimal, stateless MCP server (Streamable HTTP transport, JSON responses).
// Handles: initialize, ping, tools/list, tools/call, and notifications.
import {
  buildBriefing, filterTasks, searchTasks, completionsSince, describeTask, dateKey,
} from './focus.js';
import { OPERATIONS, ToolError } from './edit.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'focus', title: 'Focus to-do list', version: '1.1.0' };

const INSTRUCTIONS = `Access to the user's Focus app (their personal to-do list).
Tasks live in two lists, "personal" and "work", and three sections: "todo" (active),
"notrightnow" (parked for later, low priority), and "completed".
Start with get_daily_briefing for a summary of overdue, due-today and upcoming tasks.
Dates are calendar days in the user's time zone.
To change tasks: add_task, complete_task (check off or un-check), set_subtask_done,
update_task (text, notes, due date, list, sub-items) and move_task (todo <-> notrightnow).
Write tools take the task id from list_tasks, search_tasks or get_daily_briefing, and
sub-item ids from a task's subtask_list. There is no delete tool. Changes show up in the
Focus app right away if it is open.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = (idempotent, destructive = false) => ({
  readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false,
});
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD in the user\'s time zone.' };
const TASK_ID = { type: 'string', minLength: 1, description: 'The task id from list_tasks, search_tasks or get_daily_briefing.' };

export const TOOLS = [
  {
    name: 'get_daily_briefing',
    title: 'Daily briefing',
    description: 'Summary of the Focus to-do list for today: overdue tasks, tasks due today, tasks due in the next N days, active tasks with no due date, weekly recurring tasks with sub-item progress, counts per list, and what was completed in the last 2 days. Best first call for a daily plan.',
    inputSchema: {
      type: 'object',
      properties: {
        horizon_days: { type: 'integer', minimum: 1, maximum: 60, default: 7, description: 'How many days ahead count as upcoming.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List tasks from Focus, filtered by list and section, sorted by due date.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: ['all', 'personal', 'work'], default: 'all' },
        section: { type: 'string', enum: ['todo', 'notrightnow', 'completed', 'all'], default: 'todo', description: 'todo = active, notrightnow = parked for later.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'search_tasks',
    title: 'Search tasks',
    description: 'Find Focus tasks whose text, notes or sub-items contain the query (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        include_completed: { type: 'boolean', default: false },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_completed_tasks',
    title: 'Recently completed',
    description: 'Tasks the user checked off in Focus over the last N days, newest first. Useful for progress recaps.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'add_task',
    title: 'Add task',
    description: 'Adds one new task to Focus, at the end of the chosen list and section. Changes nothing else. Returns the new task with its id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500, description: 'The task as it should read in the list.' },
        list: { type: 'string', enum: ['personal', 'work'], default: 'personal' },
        section: { type: 'string', enum: ['todo', 'notrightnow'], default: 'todo', description: 'todo = active, notrightnow = parked for later.' },
        due: { ...DATE, description: 'Optional due date, YYYY-MM-DD in the user\'s time zone.' },
        notes: { type: 'string', maxLength: 5000 },
        subtasks: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 50, description: 'Optional sub-items, added unchecked.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: WRITE(false),
  },
  {
    name: 'complete_task',
    title: 'Check off task',
    description: 'Checks a task off: moves it to Completed and records it in the completion history, as ticking it in the app does. With completed=false it un-checks the task instead: moves it back to To do and removes today\'s history entry for it. Sub-items are not changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        completed: { type: 'boolean', default: true },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: WRITE(true),
  },
  {
    name: 'set_subtask_done',
    title: 'Check off sub-item',
    description: 'Checks or un-checks one sub-item of a task and records or removes it in the completion history, as the app does. The parent task stays in its section.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        subtask_id: { type: 'string', minLength: 1, description: 'The sub-item id from the task\'s subtask_list.' },
        done: { type: 'boolean', default: true },
      },
      required: ['task_id', 'subtask_id'],
      additionalProperties: false,
    },
    annotations: WRITE(true),
  },
  {
    name: 'update_task',
    title: 'Edit task',
    description: 'Edits one task. Only the fields you pass change: text, notes ("" clears them), due ("" clears it), list (moves it between personal and work), add_subtasks (appends unchecked sub-items) and remove_subtask_ids (deletes those sub-items). To park or check off a task use move_task or complete_task. Weekly recurring tasks allow text, notes and due only.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        text: { type: 'string', minLength: 1, maxLength: 500 },
        notes: { type: 'string', maxLength: 5000 },
        due: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$', description: 'YYYY-MM-DD in the user\'s time zone, or "" to clear.' },
        list: { type: 'string', enum: ['personal', 'work'] },
        add_subtasks: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 50 },
        remove_subtask_ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: WRITE(false, true),
  },
  {
    name: 'move_task',
    title: 'Park or unpark task',
    description: 'Moves an active task between To do and Not right now (parked for later). It cannot move a completed task; use complete_task with completed=false for that.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        section: { type: 'string', enum: ['todo', 'notrightnow'] },
      },
      required: ['task_id', 'section'],
      additionalProperties: false,
    },
    annotations: WRITE(true),
  },
];

function clampInt(v, def, min, max) {
  const n = Number.isInteger(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}

async function callWriteTool(name, args, ctx) {
  const { mutate, tz, now = new Date() } = ctx;
  if (!mutate) throw new RpcError(-32603, 'This server cannot write to Focus');
  let result;
  try {
    result = await mutate((state) => OPERATIONS[name](state, args, { now, tz }));
  } catch (e) {
    if (e instanceof ToolError) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
    throw e;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

async function callTool(name, args, ctx) {
  if (Object.prototype.hasOwnProperty.call(OPERATIONS, name)) return callWriteTool(name, args || {}, ctx);
  const { loadData, tz, now = new Date() } = ctx;
  const { tasks, log } = await loadData();
  const todayKey = dateKey(now, tz);
  let result;
  switch (name) {
    case 'get_daily_briefing':
      result = buildBriefing(tasks, log, now, tz, { horizonDays: clampInt(args.horizon_days, 7, 1, 60) });
      break;
    case 'list_tasks': {
      const list = ['all', 'personal', 'work'].includes(args.list) ? args.list : 'all';
      const section = ['todo', 'notrightnow', 'completed', 'all'].includes(args.section) ? args.section : 'todo';
      const limit = clampInt(args.limit, 200, 1, 500);
      const all = filterTasks(tasks, { list, section });
      result = { today: todayKey, list, section, total: all.length, tasks: all.slice(0, limit).map((t) => describeTask(t, todayKey)) };
      break;
    }
    case 'search_tasks': {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new RpcError(-32602, 'query is required');
      const hits = searchTasks(tasks, args.query, { includeCompleted: args.include_completed === true });
      result = { today: todayKey, query: args.query, total: hits.length, tasks: hits.map((t) => describeTask(t, todayKey)) };
      break;
    }
    case 'get_completed_tasks': {
      const days = clampInt(args.days, 7, 1, 90);
      const items = completionsSince(log, days, now, tz);
      result = { today: todayKey, days, total: items.length, completed: items };
      break;
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Handle one JSON-RPC message. Returns a response object, or null for notifications.
async function handleOne(msg, ctx) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request' } } : null;
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, etc.

  try {
    let result;
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        result = {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        try {
          result = await callTool(name, args, ctx);
        } catch (e) {
          if (e instanceof RpcError) throw e;
          // Tool-level failure: report to the model instead of failing the protocol call.
          console.error('tool error', name, e);
          const verb = Object.prototype.hasOwnProperty.call(OPERATIONS, name) ? 'change' : 'read';
          result = { isError: true, content: [{ type: 'text', text: `Could not ${verb} Focus data: ${e.message}` }] };
        }
        break;
      }
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id: msg.id, error: { code, message: e.message } };
  }
}

// Handle a POST body (single message or batch). Returns the body to send, or null for 202.
export async function handleMcpBody(body, ctx) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleOne(body, ctx);
}
