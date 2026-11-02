// Polls BOSS for the open Help Desk queue and your own worklog, and reports what changed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Only tasks nobody has picked up yet; every other status is left out of the app.
export const QUEUE_STATUSES = ['Todo'];
export const APPS = { 'bss-b2b-solution': 'Solution', 'bss-b2b-quote': 'Quote', 'bss-b2b-lock': 'Lock' };
const TASK_FIELDS = ['name', 'title', 'status', 'priority', 'relatedApp', 'assignee', 'dueDate', 'createdAt', 'updatedAt'];
const ASSIGNED_FIELDS = [...TASK_FIELDS, 'reporter'];
const DONE = ['Resolved', 'Cancel'];
const SEEN_MAX = 500;
const LOG_FIELDS = ['taskName', 'taskTitle', 'taskStatus', 'minutes', 'loggedAt'];
const DAY = 86400000;
const ICT = 7 * 3600000;

export const ictDate = (ms = Date.now()) => new Date(ms + ICT).toISOString().slice(0, 10);

export function toTask(t) {
  return {
    key: t.name,
    title: t.title ?? '',
    status: t.status,
    priority: t.priority ?? '',
    app: APPS[t.relatedApp] ?? 'Khác',
    assignee: t.assignee?.name ?? '',
    reporter: t.reporter?.name ?? '',
    due: t.dueDate ? ictDate(Date.parse(t.dueDate)) : '',
    createdAt: t.createdAt ?? '',
    updatedAt: t.updatedAt ?? '',
  };
}

// prev/next: Map key → task. Returns feed entries (without ids/timestamps).
export function diffQueue(prev, next) {
  const changes = [];
  for (const [key, t] of next) {
    const old = prev.get(key);
    if (!old) {
      changes.push({
        level: t.priority === 'Urgent' ? 'attention' : 'info',
        title: `Task Todo mới · ${t.app}`,
        detail: `${t.status} · ${t.title}`,
        task: key,
        app: t.app,
      });
    } else if (old.status !== t.status) {
      changes.push({
        level: t.status === 'Todo' || t.status === 'Research' ? 'attention' : 'info',
        title: `${old.status} → ${t.status}`,
        detail: t.title,
        task: key,
        app: t.app,
      });
    } else if (old.priority !== 'Urgent' && t.priority === 'Urgent') {
      changes.push({ level: 'attention', title: 'Chuyển thành Urgent', detail: t.title, task: key, app: t.app });
    }
  }
  for (const [key, t] of prev) {
    if (!next.has(key)) {
      changes.push({ level: 'info', title: 'Không còn ở Todo (đã có người nhận, xong hoặc huỷ)', detail: t.title, task: key, app: t.app });
    }
  }
  return changes;
}

// Tasks assigned to you: seen = Map key → status from earlier polls. New keys are new assignments.
export function diffAssigned(seen, tasks) {
  const changes = [];
  for (const t of tasks) {
    const old = seen.get(t.key);
    if (old === undefined) {
      changes.push({
        level: 'attention',
        type: 'assigned',
        title: 'Task mới giao cho bạn',
        detail: [t.title, t.priority === 'Urgent' ? 'Urgent' : '', t.due ? `hạn ${t.due}` : '', t.reporter ? `từ ${t.reporter}` : ''].filter(Boolean).join(' · '),
        task: t.key,
        app: t.app,
      });
    } else if (old !== t.status) {
      changes.push({ level: 'info', title: `Task của bạn: ${old} → ${t.status}`, detail: t.title, task: t.key, app: t.app });
    }
  }
  return changes;
}

export const newTodo = (seen, tasks) => tasks.filter((t) => t.status === 'Todo' && seen.get(t.key) !== 'Todo');

export function summarizeWorklog(logs, today = ictDate()) {
  const weekStart = new Date(Date.parse(today + 'T00:00:00Z') - 6 * DAY).toISOString().slice(0, 10);
  let todayMin = 0;
  let weekMin = 0;
  let totalMin = 0;
  const byTask = new Map();
  for (const w of logs) {
    const day = String(w.loggedAt).slice(0, 10);
    const min = Number(w.minutes) || 0;
    totalMin += min;
    if (day === today) todayMin += min;
    if (day >= weekStart) weekMin += min;
    const r = byTask.get(w.taskName) ?? { key: w.taskName, title: w.taskTitle, status: w.taskStatus, minutes: 0, last: '' };
    r.minutes += min;
    if (day > r.last) r.last = day;
    byTask.set(w.taskName, r);
  }
  const tasks = [...byTask.values()].sort((a, b) => b.last.localeCompare(a.last) || b.minutes - a.minutes);
  return { todayMin, weekMin, totalMin, taskCount: tasks.length, recent: tasks.slice(0, 15) };
}

export function createPoller({ client, bus, statePath, intervalSec = 120, worklogDays = 30, assignee = null, assignedIntervalSec = 30, assignedDays = 7, onUpdate, onNewTodo }) {
  const boss = {
    configured: Boolean(client),
    ok: false,
    error: client ? null : 'Chưa cấu hình BOSS_TOKEN trong .env',
    lastPoll: null,
    tasks: [],
    cut: false,
    worklog: summarizeWorklog([]),
    assignee,
    assignedEvery: assignedIntervalSec,
    assigned: [], // tasks given to you that are not done yet
    assignedError: null,
  };
  let queue = new Map();
  let loaded = false;
  let running = false;
  let timer = null;
  let assignedTimer = null;
  let assignedSeen = null; // null until the first look: the tasks you already have are not news
  let assignedRunning = false;

  async function loadSaved() {
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      // a file saved with other statuses must not read as all of them leaving the queue
      const kept = saved.tasks.filter((t) => QUEUE_STATUSES.includes(t.status));
      queue = new Map(kept.map((t) => [t.key, t]));
      boss.tasks = kept;
      boss.lastPoll = saved.lastPoll;
      if (Array.isArray(saved.assigned)) assignedSeen = new Map(saved.assigned);
      loaded = true;
    } catch {
      // first run: the first poll fills the queue without announcing every task
    }
  }

  async function save() {
    await mkdir(dirname(statePath), { recursive: true });
    const assigned = assignedSeen ? [...assignedSeen].slice(-SEEN_MAX) : undefined;
    await writeFile(statePath, JSON.stringify({ lastPoll: boss.lastPoll, tasks: boss.tasks, assigned }));
  }

  async function poll() {
    if (!client || running) return;
    running = true;
    try {
      // one call at a time: BOSS rate-limits bursts
      const lists = [];
      for (const status of QUEUE_STATUSES) lists.push(await client.listAll('search_tasks', { status, limit: 100, fields: TASK_FIELDS }));
      const from = ictDate(Date.now() - (worklogDays - 1) * DAY);
      const logs = await client.listAll('search_worklogs', { from_: from, limit: 100, fields: LOG_FIELDS });

      const next = new Map();
      for (const { items } of lists) for (const t of items) next.set(t.name, toTask(t));
      if (loaded) for (const c of diffQueue(queue, next)) bus.post({ kind: 'boss', ...c });
      else bus.post({ kind: 'boss', title: 'Đã tải hàng đợi BOSS', detail: `${next.size} task Todo` });

      queue = next;
      loaded = true;
      if (!boss.ok && boss.error && boss.lastPoll) bus.post({ kind: 'boss', title: 'Kết nối BOSS đã ổn lại' });
      Object.assign(boss, {
        ok: true,
        error: null,
        lastPoll: new Date().toISOString(),
        tasks: [...next.values()],
        cut: lists.some((l) => l.cut) || logs.cut,
        worklog: summarizeWorklog(logs.items),
      });
      await save();
    } catch (err) {
      if (boss.ok || boss.error !== err.message) {
        bus.post({ kind: 'boss', level: 'attention', title: 'Không gọi được BOSS', detail: err.message });
      }
      boss.ok = false;
      boss.error = err.message;
    } finally {
      running = false;
      onUpdate?.(boss);
    }
  }

  // A small, frequent look at what is assigned to you (recently updated, so it stays one page).
  async function pollAssigned() {
    if (!client || !assignee || assignedRunning) return;
    assignedRunning = true;
    try {
      const from = ictDate(Date.now() - assignedDays * DAY);
      const { items } = await client.listAll('search_tasks', { assignee, updated_from: from, limit: 100, fields: ASSIGNED_FIELDS }, 3);
      const tasks = items.map(toTask);
      // new to you in Todo, or moved back into Todo: offered to the approval queue before the feed announces it
      if (assignedSeen) for (const t of newTodo(assignedSeen, tasks)) onNewTodo?.(t);
      if (assignedSeen) for (const c of diffAssigned(assignedSeen, tasks)) bus.post({ kind: 'boss', ...c });
      const seen = new Map(assignedSeen ?? []);
      for (const t of tasks) {
        seen.delete(t.key);
        seen.set(t.key, t.status); // most recent last, so trimming drops the oldest
      }
      assignedSeen = new Map([...seen].slice(-SEEN_MAX));
      const changed = JSON.stringify(boss.assigned) !== JSON.stringify(tasks.filter((t) => !DONE.includes(t.status)));
      boss.assigned = tasks.filter((t) => !DONE.includes(t.status));
      if (boss.assignedError) bus.post({ kind: 'boss', title: 'Đã xem lại được task giao cho bạn' });
      boss.assignedError = null;
      await save();
      if (changed) onUpdate?.(boss);
    } catch (err) {
      if (boss.assignedError !== err.message) {
        bus.post({ kind: 'boss', level: 'attention', title: 'Không xem được task giao cho bạn', detail: err.message });
        boss.assignedError = err.message;
        onUpdate?.(boss);
      }
    } finally {
      assignedRunning = false;
    }
  }

  async function start() {
    await loadSaved();
    if (!client) return;
    await poll();
    await pollAssigned();
    timer = setInterval(poll, intervalSec * 1000);
    if (assignee) assignedTimer = setInterval(pollAssigned, assignedIntervalSec * 1000);
  }

  return {
    boss,
    poll: () => Promise.all([poll(), pollAssigned()]),
    start,
    stop: () => {
      clearInterval(timer);
      clearInterval(assignedTimer);
    },
  };
}
