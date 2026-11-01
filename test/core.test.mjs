import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossClient, parseSseMessages, rateLimitDelay } from '../lib/boss.mjs';
import { diffAssigned, diffQueue, summarizeWorklog, toTask } from '../lib/poller.mjs';
import { createSessions, describeTool, findTaskKey } from '../lib/sessions.mjs';

const fakeBus = () => {
  const posted = [];
  return { posted, post: (i) => posted.push(i) };
};

test('findTaskKey picks the BOSS key from prompts and tool input', () => {
  assert.equal(findTaskKey('/analyze-boss-task sbcb2bbs-5520 giúp mình'), 'SBCB2BBS-5520');
  assert.equal(findTaskKey({ task_id: 'SBCB2BBS-42' }), 'SBCB2BBS-42');
  assert.equal(findTaskKey('không có mã'), null);
});

test('describeTool keeps tool input short', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b/c.ts' }), 'Đọc c.ts');
  assert.equal(describeTool('mcp__claude_ai_BOSS-SBC__read_task', { task_id: 'SBCB2BBS-1' }), 'BOSS-SBC: read_task SBCB2BBS-1');
  assert.ok(describeTool('Bash', { command: 'x'.repeat(500) }).length < 140);
});

test('session goes working → waiting → working → idle and remembers its task', () => {
  const bus = fakeBus();
  const sessions = createSessions({ bus });
  const base = { session_id: 's1', cwd: '/home/u/BSS/b2b_solution' };
  sessions.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '/analyze-boss-task SBCB2BBS-5520' });
  let [s] = sessions.list();
  assert.equal(s.status, 'working');
  assert.equal(s.task, 'SBCB2BBS-5520');
  assert.equal(s.skill, 'analyze-boss-task');
  assert.equal(s.project, 'b2b_solution');

  sessions.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install zod' } });
  sessions.handle({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  [s] = sessions.list();
  assert.equal(s.status, 'waiting');
  assert.match(s.waitingFor, /npm install zod/);
  assert.equal(bus.posted.at(-1).level, 'attention');

  sessions.handle({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(sessions.list()[0].status, 'working');
  sessions.handle({ ...base, hook_event_name: 'Stop' });
  assert.equal(sessions.list()[0].status, 'idle');
});

test('unknown hook events and payloads without session are ignored', () => {
  const sessions = createSessions({ bus: fakeBus() });
  assert.equal(sessions.handle({}), null);
  assert.equal(sessions.handle({ session_id: 'x', hook_event_name: 'PreCompact' }), null);
});

test('prune drops ended sessions after the TTL', () => {
  const sessions = createSessions({ bus: fakeBus() });
  sessions.handle({ session_id: 'a', hook_event_name: 'SessionEnd' });
  sessions.prune(Date.now() + 11 * 60000);
  assert.equal(sessions.list().length, 0);
});

test('toTask maps app and ICT due date', () => {
  const t = toTask({ name: 'K-1', relatedApp: 'bss-b2b-quote', dueDate: '2026-11-02T16:59:59.999Z', assignee: { name: 'A' }, status: 'Todo' });
  assert.equal(t.app, 'Quote');
  assert.equal(t.due, '2026-11-02');
  assert.equal(t.assignee, 'A');
});

test('diffQueue reports new, moved, urgent and closed tasks', () => {
  const a = (key, status, priority = 'Medium') => [key, { key, status, priority, title: key, app: 'Lock' }];
  const prev = new Map([a('A', 'Todo'), a('B', 'In Progress'), a('C', 'CS Review')]);
  const next = new Map([a('A', 'In Progress'), a('B', 'In Progress', 'Urgent'), a('D', 'Todo', 'Urgent')]);
  const titles = diffQueue(prev, next).map((c) => `${c.task}:${c.title}`);
  assert.deepEqual(titles.sort(), [
    'A:Todo → In Progress',
    'B:Chuyển thành Urgent',
    'C:Không còn ở Todo (đã có người nhận, xong hoặc huỷ)',
    'D:Task Todo mới · Lock',
  ]);
});

test('diffAssigned announces new assignments and status changes of your tasks', () => {
  const seen = new Map([['A', 'In Progress'], ['B', 'Todo']]);
  const tasks = [
    { key: 'A', title: 'a', status: 'In Progress', app: 'Lock' },
    { key: 'B', title: 'b', status: 'CS Review', app: 'Quote' },
    { key: 'C', title: 'Giá VAT sai', status: 'Todo', priority: 'Urgent', due: '2026-11-03', reporter: 'Kyle', app: 'Solution' },
  ];
  const out = diffAssigned(seen, tasks);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { level: 'info', title: 'Task của bạn: Todo → CS Review', detail: 'b', task: 'B', app: 'Quote' });
  assert.equal(out[1].type, 'assigned');
  assert.equal(out[1].level, 'attention');
  assert.equal(out[1].detail, 'Giá VAT sai · Urgent · hạn 2026-11-03 · từ Kyle');
});

test('summarizeWorklog totals today, last 7 days and per task', () => {
  const logs = [
    { taskName: 'A', taskTitle: 'a', taskStatus: 'Resolved', minutes: 30, loggedAt: '2026-11-01T00:00:00.000Z' },
    { taskName: 'A', taskTitle: 'a', taskStatus: 'Resolved', minutes: 15, loggedAt: '2026-10-26T00:00:00.000Z' },
    { taskName: 'B', taskTitle: 'b', taskStatus: 'Todo', minutes: 60, loggedAt: '2026-10-25T00:00:00.000Z' },
  ];
  const w = summarizeWorklog(logs, '2026-11-01');
  assert.equal(w.todayMin, 30);
  assert.equal(w.weekMin, 45);
  assert.equal(w.totalMin, 105);
  assert.deepEqual(w.recent.map((t) => [t.key, t.minutes, t.last]), [['A', 45, '2026-11-01'], ['B', 60, '2026-10-25']]);
});

test('parseSseMessages reads JSON-RPC frames', () => {
  const text = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n: ping\n\n';
  assert.deepEqual(parseSseMessages(text), [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
});

test('boss client initializes once, sends the session id and follows cursors', async () => {
  const calls = [];
  const reply = (body, headers = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ method: msg.method, sid: init.headers['Mcp-Session-Id'], auth: init.headers.Authorization });
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'S1' });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const page = msg.params.arguments.cursor ? { items: [2], nextCursor: null } : { items: [1], nextCursor: 'c2' };
    return reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(page) }] } });
  };
  const client = createBossClient({ url: 'http://x/mcp', token: 'T', fetchImpl });
  const out = await client.listAll('search_tasks', { status: 'Todo' });
  assert.deepEqual(out, { items: [1, 2], cut: false });
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  assert.equal(calls[2].sid, 'S1');
  assert.equal(calls[2].auth, 'Bearer T');
});

test('rateLimitDelay reads the wait from the BOSS message', () => {
  assert.equal(rateLimitDelay(new Error('Rate limit exceeded for caller u:1. Retry after 1s.')), 1300);
  assert.equal(rateLimitDelay({ status: 429, message: 'Too many' }), 2300);
  assert.equal(rateLimitDelay(new Error('HTTP 401: bad token')), null);
});

test('boss client waits and retries when rate limited', async () => {
  let calls = 0;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    calls += 1;
    if (calls === 1) return reply({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded for caller u:1. Retry after 0s.' }] } });
    return reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"items":[1]}' }] } });
  };
  const client = createBossClient({ url: 'http://x/mcp', token: 'T', fetchImpl });
  assert.deepEqual(await client.callTool('search_tasks', {}), { items: [1] });
  assert.equal(calls, 2);
});

test('boss client surfaces HTTP auth errors', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'invalid_token', error_description: 'bad token' }), { status: 401 });
  const client = createBossClient({ url: 'http://x/mcp', token: 'T', fetchImpl });
  await assert.rejects(client.callTool('search_tasks', {}), /HTTP 401: bad token/);
});
