// Minimal, stateless MCP server (Streamable HTTP transport, JSON responses).
// Handles: initialize, ping, tools/list, tools/call, and notifications.
import {
  buildBriefing, filterTasks, searchTasks, completionsSince, describeTask, dateKey,
} from './focus.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'focus', title: 'Focus to-do list', version: '1.0.0' };

const INSTRUCTIONS = `Read-only access to the user's Focus app (their personal to-do list).
Tasks live in two lists, "personal" and "work", and three sections: "todo" (active),
"notrightnow" (parked for later, low priority), and "completed".
Start with get_daily_briefing for a summary of overdue, due-today and upcoming tasks.
Dates are calendar days in the user's time zone. This connector cannot change tasks;
if the user wants something added or checked off, tell them to do it in the Focus app.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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
];

function clampInt(v, def, min, max) {
  const n = Number.isInteger(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}

async function callTool(name, args, ctx) {
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
          result = { isError: true, content: [{ type: 'text', text: `Could not read Focus data: ${e.message}` }] };
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
