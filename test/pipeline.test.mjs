import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { commentHtml, createPipeline } from '../lib/pipeline.mjs';
import { createClaudeRunner, extractJson, PROFILES } from '../lib/claude.mjs';
import { newTodo } from '../lib/poller.mjs';

const task = { key: 'SBCB2BBS-1', title: 'Giá không ẩn', app: 'Lock', priority: 'Urgent', due: '', reporter: 'CS' };
const bus = () => ({ items: [], post(e) { this.items.push(e); } });
const tick = () => new Promise((r) => setImmediate(r));
const reply = (json) => `## Báo cáo\nnội dung\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;

const statusClient = (status = 'Todo', extra = {}) => ({
  calls: [],
  async callTool(name, args) {
    this.calls.push([name, args]);
    if (name === 'read_task') return { status };
    if (name === 'update_task') return { webUrl: 'u' };
    if (extra[name]) return extra[name](args);
    throw new Error(`unexpected ${name}`);
  },
});
const settle = () => new Promise((r) => setTimeout(r, 10));

async function setup(runner, client = statusClient()) {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const b = bus();
  const p = createPipeline({ statePath: join(dir, 'p.json'), bus: b, runner, client });
  await p.load();
  return { p, b, dir };
}

test('newTodo picks tasks new to you in Todo or moved back into Todo', () => {
  const seen = new Map([['A', 'Todo'], ['B', 'In Progress']]);
  const tasks = [{ key: 'A', status: 'Todo' }, { key: 'B', status: 'Todo' }, { key: 'C', status: 'Todo' }, { key: 'D', status: 'Research' }];
  assert.deepEqual(newTodo(seen, tasks).map((t) => t.key), ['B', 'C']);
});

test('extractJson takes the last json block and returns the report without it', () => {
  const { data, report } = extractJson('a\n```json\n{"x":1}\n```\nb\n```json\n{"x":2}\n```');
  assert.equal(data.x, 2);
  assert.ok(report.includes('"x":1') && !report.includes('"x":2'));
  assert.equal(extractJson('no block').data, null);
});

test('commentHtml bolds the template labels, escapes HTML and links URLs', () => {
  const html = commentHtml('Root Cause: a <b>\nSolution: xem https://x.io/a\n- một\n- hai\nResult: ok');
  assert.equal(html, '<p><strong>Root Cause:</strong> a &lt;b&gt;</p><p><strong>Solution:</strong> xem <a target="_blank" rel="noopener noreferrer" href="https://x.io/a">https://x.io/a</a></p><ul><li>một</li><li>hai</li></ul><p><strong>Result:</strong> ok</p>');
});

test('nothing runs until you approve; analysis lands in review with the comment draft', async () => {
  const calls = [];
  const runner = { run: async (o) => (calls.push(o), { text: reply({ summary: 'S', comment: 'Root Cause: x', devhub: { code: 'f()' } }), sessionId: 'sid', costUsd: 1 }) };
  const { p, dir } = await setup(runner);
  p.offer(task);
  assert.equal(p.offer(task), null, 'no duplicate while active');
  await tick();
  assert.equal(calls.length, 0);
  p.approve(task.key);
  await settle();
  const it = p.get(task.key);
  assert.equal(it.bossStatus.state, 'moved');
  assert.equal(it.state, 'review');
  assert.equal(calls[0].prompt, '/analyze-boss-task SBCB2BBS-1');
  assert.equal(calls[0].profile, 'analyze');
  assert.equal(it.comment.text, 'Root Cause: x');
  assert.equal(it.devhub.state, 'proposed');
  assert.equal(it.report, '## Báo cáo\nnội dung');
  await new Promise((r) => setTimeout(r, 20));
  const saved = JSON.parse(await readFile(join(dir, 'p.json'), 'utf8'));
  assert.equal(saved[0].state, 'review');
});

test('a failed analysis can be retried; skip is final', async () => {
  let fail = true;
  const runner = { run: async () => { if (fail) throw new Error('boom'); return { text: reply({ comment: '' }) }; } };
  const { p, b } = await setup(runner);
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.equal(p.get(task.key).state, 'failed');
  assert.ok(b.items.some((e) => e.title === 'Phân tích lỗi'));
  fail = false;
  p.approve(task.key);
  await settle();
  assert.equal(p.get(task.key).state, 'review');
  p.skip(task.key);
  assert.throws(() => p.approve(task.key), /trạng thái skipped/);
  assert.ok(p.offer(task), 'a skipped task offered again (reopened) comes back');
});

test('the approved comment text is posted as HTML with the app token', async () => {
  const runner = { run: async () => ({ text: reply({ comment: 'draft' }) }) };
  const sent = [];
  const client = statusClient('Todo', { add_task_comment: (args) => (sent.push(['add_task_comment', args]), { webUrl: 'u' }) });
  const { p } = await setup(runner, client);
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.throws(() => p.approveComment(task.key, '  '), /trống/);
  const { done } = p.approveComment(task.key, 'Result: đã sửa');
  assert.throws(() => p.approveComment(task.key, 'again'), /đã gửi hoặc đang gửi/);
  await done;
  assert.deepEqual(sent, [['add_task_comment', { task: 'SBCB2BBS-1', content: '<p><strong>Result:</strong> đã sửa</p>' }]]);
  assert.equal(p.get(task.key).comment.state, 'posted');
});

test('without comment rights the same HTML goes through Claude; DevHub resumes the analysis session', async () => {
  const calls = [];
  const runner = {
    run: async (o) => {
      calls.push(o);
      if (o.profile === 'analyze') return { text: reply({ comment: 'c', devhub: { code: 'run()', purpose: 'p' } }), sessionId: 'sid' };
      if (o.profile === 'status') return { text: reply({ ok: true, from: 'Todo', moved: true }) };
      if (o.profile === 'comment') return { text: reply({ ok: true, webUrl: 'w' }) };
      return { text: reply({ status: 'written', detail: 'ok', block: '// x' }) };
    },
  };
  const client = { callTool: async () => { throw new Error('Tool not permitted by this token'); } };
  const { p } = await setup(runner, client);
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.deepEqual([calls[0].profile, p.get(task.key).bossStatus.via], ['status', 'claude']);
  calls.shift();
  await p.approveComment(task.key, 'Root Cause: a').done;
  const c = p.get(task.key).comment;
  assert.equal(c.state, 'posted');
  assert.equal(c.via, 'claude');
  assert.ok(calls[1].prompt.includes('<p><strong>Root Cause:</strong> a</p>'));
  await p.approveDevhub(task.key, 'edited()').done;
  assert.equal(calls[2].profile, 'devhub');
  assert.equal(calls[2].resume, 'sid');
  assert.ok(calls[2].prompt.includes('edited()') && calls[2].prompt.includes('CHỜ XÁC NHẬN'));
  assert.equal(p.get(task.key).devhub.state, 'written');
});

test('work interrupted by a restart is not reported as finished', async () => {
  const runner = { run: () => new Promise(() => {}) };
  const { p, dir } = await setup(runner);
  p.offer(task);
  p.approve(task.key);
  await new Promise((r) => setTimeout(r, 20));
  const again = createPipeline({ statePath: join(dir, 'p.json'), bus: bus(), runner });
  await again.load();
  assert.equal(again.get(task.key).state, 'failed');
});

test('the analysis profile cannot comment, write DevHub or edit files', () => {
  const { allowed, denied } = PROFILES.analyze;
  for (const t of ['mcp__claude_ai_BOSS-SBC__add_task_comment', 'mcp__claude_ai_BOSS-SBC__devhub_write', 'Edit', 'Write', 'mcp__chrome-devtools__click']) {
    assert.ok(!allowed.includes(t), t);
    assert.ok(denied.includes(t), t);
  }
  assert.equal(PROFILES.devhub.env.AUTOFIX_BOSS_CRON, '1');
});

test('claude runner passes the whitelist and reads the json result', async () => {
  let seen;
  const spawnImpl = (bin, args, opts) => {
    seen = { bin, args, opts };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ result: 'hi', session_id: 's1', total_cost_usd: 0.5, is_error: false }));
      child.emit('close', 0);
    });
    return child;
  };
  const r = await createClaudeRunner({ cwd: '/x', spawnImpl }).run({ prompt: 'p', profile: 'analyze', appendSystem: 'rules' });
  assert.deepEqual(r, { text: 'hi', sessionId: 's1', costUsd: 0.5 });
  assert.equal(seen.args[0], '-p');
  assert.ok(seen.args.includes('dontAsk') && seen.args.includes('--append-system-prompt'));
  assert.equal(seen.opts.env.CLAUDECODE, undefined);
});

test('approving moves the task Todo → In Progress before /analyze-boss-task runs', async () => {
  const order = [];
  const client = statusClient('Todo');
  const orig = client.callTool.bind(client);
  client.callTool = async (n, a) => (order.push(n), orig(n, a));
  const runner = { run: async (o) => (order.push(o.profile), { text: reply({ comment: '' }) }) };
  const { p } = await setup(runner, client);
  p.offer(task);
  await tick();
  assert.deepEqual(order, [], 'nothing happens before approval');
  p.approve(task.key);
  await settle();
  assert.deepEqual(order, ['read_task', 'update_task', 'analyze']);
  assert.deepEqual(client.calls[1], ['update_task', { task: 'SBCB2BBS-1', status: 'In Progress' }]);
});

test('a status someone else already changed is left alone', async () => {
  const client = statusClient('Research');
  const runner = { run: async () => ({ text: reply({ comment: '' }) }) };
  const { p } = await setup(runner, client);
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.ok(!client.calls.some(([n]) => n === 'update_task'));
  assert.deepEqual([p.get(task.key).bossStatus.state, p.get(task.key).state], ['kept', 'review']);
});

test('when the status cannot be changed the analysis does not run; retry tries again', async () => {
  let ok = false;
  const runs = [];
  const client = { callTool: async (n) => { if (n === 'read_task') return { status: 'Todo' }; if (!ok) throw new Error('Tool not permitted'); return {}; } };
  const runner = { run: async (o) => (runs.push(o.profile), o.profile === 'status' ? { text: reply({ ok: false, error: 'no' }) } : { text: reply({ comment: '' }) }) };
  const { p } = await setup(runner, client);
  p.offer(task);
  p.approve(task.key);
  await settle();
  const it = p.get(task.key);
  assert.equal(it.state, 'failed');
  assert.match(it.error, /In Progress/);
  assert.deepEqual(runs, ['status']);
  ok = true;
  p.approve(task.key);
  await settle();
  assert.deepEqual([it.bossStatus.state, it.state], ['moved', 'review']);
});

test('the status profile can only read the task and update it', () => {
  const { allowed, denied } = PROFILES.status;
  assert.deepEqual(allowed, ['ToolSearch', 'mcp__claude_ai_BOSS-SBC__read_task', 'mcp__claude_ai_BOSS-SBC__update_task']);
  assert.ok(!denied.includes('mcp__claude_ai_BOSS-SBC__update_task'));
  assert.ok(PROFILES.analyze.denied.includes('mcp__claude_ai_BOSS-SBC__update_task'));
});

test('with autoAnalyze a new task is analyzed without approval and its BOSS status is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const client = statusClient('Todo');
  const runs = [];
  const runner = { run: async (o) => (runs.push(o.prompt), { text: reply({ comment: 'c' }) }) };
  const p = createPipeline({ statePath: join(dir, 'p.json'), bus: bus(), runner, client, autoAnalyze: true });
  p.offer(task);
  await settle();
  assert.deepEqual(client.calls, [], 'no read_task / update_task');
  assert.deepEqual(runs, ['/analyze-boss-task SBCB2BBS-1']);
  assert.equal(p.get(task.key).bossStatus, null);
  assert.equal(p.get(task.key).state, 'review');
  assert.throws(() => p.approveComment('nope', 'x'), /Không có task/);
  assert.equal(p.get(task.key).comment.state, 'draft', 'the comment still waits for you');
});

test('with autoAnalyze a failed task you approve again does move to In Progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const client = statusClient('Todo');
  let fail = true;
  const runner = { run: async () => { if (fail) { fail = false; throw new Error('boom'); } return { text: reply({ comment: '' }) }; } };
  const p = createPipeline({ statePath: join(dir, 'p.json'), bus: bus(), runner, client, autoAnalyze: true });
  p.offer(task);
  await settle();
  assert.equal(p.get(task.key).state, 'failed');
  assert.deepEqual(client.calls, []);
  p.approve(task.key);
  await settle();
  assert.deepEqual(client.calls.map(([n]) => n), ['read_task', 'update_task']);
  assert.deepEqual([p.get(task.key).bossStatus.state, p.get(task.key).state], ['moved', 'review']);
});
