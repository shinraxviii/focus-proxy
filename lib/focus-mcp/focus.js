// Pure data logic for the Focus connector. No Firebase here, so it can be
// tested with plain objects.
//
// Focus data model (from index.html):
//   task = { id, text, date: 'YYYY-MM-DD' | '', color, link, notes,
//            section: 'todo' | 'notrightnow' | 'completed',
//            list: 'personal' | 'work',
//            subtasks?: [{ id, text, done }],
//            recurringKey?, weekOf? }            // weekly auto-generated tasks
//   log  = [{ id, text, timestamp }]               // completion history

export const SECTIONS = {
  todo: 'To do',
  notrightnow: 'Not right now (parked)',
  completed: 'Completed',
};
export const LISTS = { personal: 'Personal', work: 'Work' };

// 'YYYY-MM-DD' for a Date in the given IANA time zone.
export function dateKey(d, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Whole days from `fromKey` to `toKey` (both 'YYYY-MM-DD').
export function daysBetween(fromKey, toKey) {
  const a = Date.UTC(...fromKey.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  const b = Date.UTC(...toKey.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

function weekday(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// Shape a raw task into what Claude sees.
export function describeTask(t, todayKey) {
  const out = {
    id: t.id,
    text: t.text,
    list: t.list,
    section: t.section,
  };
  if (t.date) {
    const diff = daysBetween(todayKey, t.date);
    out.due = t.date;
    out.due_label =
      diff === 0 ? 'today'
      : diff === 1 ? 'tomorrow'
      : diff < 0 ? `${-diff} day${diff < -1 ? 's' : ''} overdue`
      : `in ${diff} days (${weekday(t.date)})`;
  }
  if (t.notes && t.notes.trim()) out.notes = t.notes.trim();
  if (Array.isArray(t.subtasks) && t.subtasks.length) {
    const done = t.subtasks.filter((s) => s.done).length;
    out.subtasks = `${done}/${t.subtasks.length} done`;
    out.subtask_items = t.subtasks.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`);
  }
  if (t.color && t.color !== 'none') out.color_label = t.color;
  if (t.recurringKey) out.recurring = 'weekly';
  return out;
}

function byDueThenText(a, b) {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return String(a.text).localeCompare(String(b.text));
}

export function filterTasks(tasks, { list = 'all', section = 'todo' } = {}) {
  return tasks
    .filter((t) => list === 'all' || t.list === list)
    .filter((t) => section === 'all' || t.section === section)
    .sort(byDueThenText);
}

export function searchTasks(tasks, query, { includeCompleted = false } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  return tasks
    .filter((t) => includeCompleted || t.section !== 'completed')
    .filter((t) => {
      const hay = [t.text, t.notes, ...(t.subtasks || []).map((s) => s.text)]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort(byDueThenText);
}

export function completionsSince(log, days, now, tz) {
  const todayKey = dateKey(now, tz);
  return (log || [])
    .filter((e) => e && e.timestamp)
    .map((e) => ({ ...e, day: dateKey(new Date(e.timestamp), tz) }))
    .filter((e) => daysBetween(e.day, todayKey) < days)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((e) => ({ text: e.text, completed_on: e.day }));
}

// The "what do I need to know this morning" view.
export function buildBriefing(tasks, log, now, tz, { horizonDays = 7 } = {}) {
  const todayKey = dateKey(now, tz);
  const open = tasks.filter((t) => t.section === 'todo');
  const d = (t) => describeTask(t, todayKey);

  const overdue = open.filter((t) => t.date && t.date < todayKey).sort(byDueThenText);
  const dueToday = open.filter((t) => t.date === todayKey).sort(byDueThenText);
  const upcoming = open
    .filter((t) => t.date && t.date > todayKey && daysBetween(todayKey, t.date) <= horizonDays)
    .sort(byDueThenText);
  const undated = open.filter((t) => !t.date && !t.recurringKey).sort(byDueThenText);
  const recurring = open.filter((t) => t.recurringKey);

  const counts = {};
  for (const l of Object.keys(LISTS)) {
    counts[l] = {
      open: open.filter((t) => t.list === l).length,
      parked: tasks.filter((t) => t.list === l && t.section === 'notrightnow').length,
    };
  }

  return {
    today: todayKey,
    today_label: weekday(todayKey),
    time_zone: tz,
    counts,
    overdue: overdue.map(d),
    due_today: dueToday.map(d),
    [`due_next_${horizonDays}_days`]: upcoming.map(d),
    no_due_date: undated.map(d),
    weekly_recurring: recurring.map(d),
    completed_last_2_days: completionsSince(log, 2, now, tz),
  };
}
