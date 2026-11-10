import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { commentHtml, createPipeline, probeLockStore } from '../lib/pipeline.mjs';
import { appendBlock, createClaudeRunner, devhubBlock, extractJson, PROFILES } from '../lib/claude.mjs';
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
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: b, runner, client });
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
  // the analysis gave no store domain: nothing is written
  assert.equal(calls.length, 2);
  assert.equal(p.get(task.key).devhub.state, 'skipped');
  assert.match(p.get(task.key).devhub.detail, /domain/);
});

test('work interrupted by a restart is not reported as finished', async () => {
  const runner = { run: () => new Promise(() => {}) };
  const { p, dir } = await setup(runner);
  p.offer(task);
  p.approve(task.key);
  await new Promise((r) => setTimeout(r, 20));
  const again = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner });
  await again.load();
  assert.equal(again.get(task.key).state, 'failed');
});

test('the analysis profile cannot comment, write DevHub or edit files', () => {
  const { allowed, denied } = PROFILES.analyze;
  for (const t of ['mcp__claude_ai_BOSS-SBC__add_task_comment', 'mcp__claude_ai_BOSS-SBC__devhub_write', 'Edit', 'Write']) {
    assert.ok(!allowed.includes(t), t);
    assert.ok(denied.includes(t), t);
  }
  assert.deepEqual(PROFILES.devhub.allowed, ['ToolSearch', 'mcp__claude_ai_BOSS-SBC__devhub_read', 'mcp__claude_ai_BOSS-SBC__devhub_write']);
  for (const t of ['Bash', 'Edit', 'mcp__chrome-devtools', 'mcp__claude_ai_BOSS-SBC__add_task_comment']) assert.ok(PROFILES.devhub.denied.includes(t), t);
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
  assert.deepEqual(r, { text: 'hi', sessionId: 's1', costUsd: 0.5, denials: [] });
  assert.equal(seen.args[0], '-p');
  assert.equal(seen.args[seen.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(seen.args.includes('--append-system-prompt'));
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
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client, autoAnalyze: true });
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
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client, autoAnalyze: true });
  p.offer(task);
  await settle();
  assert.equal(p.get(task.key).state, 'failed');
  assert.deepEqual(client.calls, []);
  p.approve(task.key);
  await settle();
  assert.deepEqual(client.calls.map(([n]) => n), ['read_task', 'update_task']);
  assert.deepEqual([p.get(task.key).bossStatus.state, p.get(task.key).state], ['moved', 'review']);
});

test('chat on a review card resumes the analysis session and updates the drafts when the conclusion changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const calls = [];
  const answers = [
    { text: reply({ summary: 's', rootCause: 'r1', solution: 'a', comment: 'c1' }), sessionId: 'S1', costUsd: 1 },
    { text: 'Đúng, đã kiểm tra lại: không đổi.', sessionId: 'S1', costUsd: 0.1 },
    { text: 'Sai ở bước 2.\n' + reply({ summary: 's', rootCause: 'r2', solution: 'b', comment: 'c2' }), sessionId: 'S1', costUsd: 0.2 },
  ];
  const runner = { run: async (o) => (calls.push(o), answers.shift()) };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client: statusClient('Todo') });
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.throws(() => p.ask(task.key, '  '), /trống/);
  await p.ask(task.key, 'Chắc chưa?').done;
  const it = p.get(task.key);
  assert.deepEqual([calls[1].prompt, calls[1].resume, calls[1].profile], ['Chắc chưa?', 'S1', 'analyze']);
  assert.match(calls[1].appendSystem, /KHÔNG thêm khối json/);
  assert.deepEqual([it.analysis.rootCause, it.comment.text, it.chat.at(-1).updated], ['r1', 'c1', []]);
  const { done } = p.ask(task.key, 'Xem lại bước 2');
  assert.throws(() => p.ask(task.key, 'nữa'), /đang trả lời/);
  await done;
  assert.deepEqual([it.analysis.rootCause, it.analysis.solution, it.comment.text, it.asking], ['r2', 'b', 'c2', false]);
  assert.deepEqual(it.chat.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(it.chat.at(-1).updated, ['rootCause', 'solution', 'comment']);
  assert.match(it.chat.at(-1).text, /^Sai ở bước 2\.\n## Báo cáo/);
  assert.doesNotMatch(it.chat.at(-1).text, /```json/);
  assert.ok(Math.abs(it.costUsd - 1.3) < 1e-9);
});

test('a chat question never replaces a comment already posted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const answers = [{ text: reply({ comment: 'c1' }), sessionId: 'S1' }, { text: reply({ comment: 'c2' }), sessionId: 'S1' }];
  const runner = { run: async () => answers.shift() };
  const client = { calls: [], callTool: async (n, a) => (client.calls.push([n, a]), n === 'read_task' ? { status: 'Todo' } : { webUrl: 'u' }) };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client });
  p.offer(task);
  p.approve(task.key);
  await settle();
  await p.approveComment(task.key, 'c1').done;
  await p.ask(task.key, 'lại').done;
  assert.deepEqual([p.get(task.key).comment.state, p.get(task.key).comment.text], ['posted', 'c1']);
});

test('the per-task log folders exist before the read-only analysis starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const { stat } = await import('node:fs/promises');
  let seen = null;
  const runner = { run: async () => {
    seen = await Promise.all(['img', 'sentry', 'store'].map((k) => stat(join(dir, 'logs', k, task.key)).then((s) => s.isDirectory())));
    return { text: reply({ comment: '' }) };
  } };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client: statusClient('Todo'), logsDir: join(dir, 'logs') });
  p.offer(task);
  p.approve(task.key);
  await settle();
  assert.deepEqual(seen, [true, true, true]);
});


test('the DevHub block is fully commented out and the existing code is kept byte for byte', () => {
  const block = devhubBlock('SBCB2BBS-7', ' hide  price\n', 'if (a) {\n\n  b();\n}\n', '2026-11-04');
  assert.equal(block, [
    '// [SBCB2BBS-7] autofix-boss 2026-11-04 START — CHỜ XÁC NHẬN — hide price',
    '// if (a) {', '//', '//   b();', '// }',
    '// [SBCB2BBS-7] END',
  ].join('\n'));
  assert.ok(block.split('\n').every((l) => l.startsWith('//')));
  const old = 'console.log(1);  \n\n';
  assert.ok(appendBlock(old, block).startsWith(old));
  assert.equal(appendBlock('x()', 'B'), 'x()\n\nB\n');
  assert.equal(appendBlock('  \n', 'B'), 'B\n');
});

const devhubCase = async ({ app = 'Lock', store = 'shop-a.myshopify.com', probe = 'v2', devhubApps, answer }) => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const calls = [];
  const runner = { run: async (o) => {
    calls.push(o);
    if (o.profile === 'analyze') return { text: reply({ app, store, comment: 'Root Cause: x', devhub: { code: 'fix();', purpose: 'p' } }), sessionId: 'sid' };
    return { text: reply(answer ?? { status: 'written', detail: 'ok', previousVersion: 4, version: 5, verified: true }) };
  } };
  const client = { callTool: async (n) => (n === 'read_task' ? { status: 'Todo' } : { webUrl: 'u' }) };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client, devhubApps, probeStore: async () => probe, today: () => '2026-11-04' });
  p.offer({ ...task, app });
  p.approve(task.key);
  await settle();
  return { p, calls };
};

test('approving the solution also appends the proposed code to DevHub', async () => {
  const { p, calls } = await devhubCase({});
  await p.approveComment(task.key, 'Root Cause: x', 'edited();').done;
  const it = p.get(task.key);
  assert.equal(it.comment.state, 'posted');
  const d = calls.find((c) => c.profile === 'devhub');
  assert.ok(d && !d.resume);
  assert.ok(d.prompt.includes('app_handle="bss-b2b-lock"') && d.prompt.includes('domain="shop-a.myshopify.com"'));
  assert.ok(d.prompt.includes('// edited();') && !d.prompt.includes('// fix();'));
  assert.match(d.prompt, /giữ NGUYÊN từng ký tự/);
  assert.deepEqual([it.devhub.state, it.devhub.previousVersion, it.devhub.version], ['written', 4, 5]);
  assert.throws(() => p.approveDevhub(task.key), /đã ghi/);
});

test('DevHub is not written for an app not enabled, a legacy Lock shop, or an unknown Lock version', async () => {
  for (const [opts, re] of [
    [{ app: 'Solution' }, /Chưa bật ghi DevHub cho Solution/],
    [{ probe: 'legacy' }, /bản cũ/],
    [{ probe: 'unknown' }, /Không xác định/],
    [{ store: 'shop.com' }, /domain/],
  ]) {
    const { p, calls } = await devhubCase(opts);
    await p.approveComment(task.key, 'Root Cause: x').done;
    assert.equal(p.get(task.key).devhub.state, 'skipped');
    assert.match(p.get(task.key).devhub.detail, re);
    assert.ok(!calls.some((c) => c.profile === 'devhub'));
  }
  const { p, calls } = await devhubCase({ app: 'Solution', devhubApps: ['Lock', 'Solution'] });
  await p.approveDevhub(task.key).done;
  assert.ok(calls.some((c) => c.profile === 'devhub' && c.prompt.includes('bss-b2b-solution')));
});

test('a save that cannot be verified is flagged for you to check', async () => {
  const { p } = await devhubCase({ answer: { status: 'written', previousVersion: 9, verified: false } });
  await p.approveDevhub(task.key).done;
  assert.equal(p.get(task.key).devhub.state, 'unknown');
  assert.match(p.get(task.key).devhub.detail, /version 9/);
});

test('the Lock version is read from the storefront HTML', async () => {
  const page = (html, url = 'https://s.myshopify.com/', ok = true) => async () => ({ ok, url, text: async () => html });
  assert.equal(await probeLockStore('s.myshopify.com', page('<script id="bss-ltap-hide-price">')), 'legacy');
  assert.equal(await probeLockStore('s.myshopify.com', page('<script>Shopify.shop="s"</script>')), 'v2');
  assert.equal(await probeLockStore('s.myshopify.com', page('', 'https://s.myshopify.com/password')), 'unknown');
  assert.equal(await probeLockStore('s.myshopify.com', page('', undefined, false)), 'unknown');
});

const liveCase = async ({ trialVerdict = 'passed', liveCheck = true, liveErrors = [], replace = { status: 'done', verified: true, previousVersion: 5, version: 6 } } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const calls = [];
  const trials = [];
  const probes = [];
  const runner = { run: async (o) => {
    calls.push(o);
    if (o.profile === 'analyze') return { text: reply({ app: 'Lock', store: 'shop-a.myshopify.com', comment: 'c', devhub: { code: 'fix();\n', purpose: 'p', test: { path: '/products/x', check: 'ok()', ready: '.p' } } }), sessionId: 'sid' };
    if (o.prompt.includes('THÊM code')) return { text: reply({ status: 'written', previousVersion: 4, version: 5, verified: true }) };
    return { text: reply(replace) };
  } };
  const trial = async (o) => (trials.push(o), { verdict: trialVerdict, note: 'n', before: { check: false, errors: ['old error'], blocked: 1 }, after: { check: true, errors: ['old error'], blocked: 1 }, newErrors: [] });
  const probe = async (o) => (probes.push(o), { check: liveCheck, errors: ['old error', ...liveErrors], blocked: 0 });
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client: statusClient('Todo'), probeStore: async () => 'v2', today: () => '2026-11-05', trial, probe, liveDelays: [0, 0] });
  p.offer({ ...task, app: 'Lock' });
  p.approve(task.key);
  await settle();
  return { p, calls, trials, probes };
};

test('a proposed fix is tried on the storefront right after the analysis, on the customer domain only', async () => {
  const { p, trials } = await liveCase();
  await settle();
  assert.equal(trials.length, 1);
  assert.deepEqual([trials[0].url, trials[0].code, trials[0].check, trials[0].ready], ['https://shop-a.myshopify.com/products/x', 'fix();', 'ok()', '.p']);
  assert.equal(p.get(task.key).trial.state, 'passed');
  assert.throws(() => p.tryFix(task.key, { path: 'https://evil.com/x' }), /bắt đầu bằng \//);
  assert.throws(() => p.tryFix(task.key, { path: '//evil.com/x' }), /bắt đầu bằng \//);
  assert.throws(() => p.enableDevhub(task.key), /chưa được thêm/);
});

test('enable needs a passed trial of the exact code in DevHub, then checks the live store', async () => {
  const { p, calls, trials, probes } = await liveCase();
  await settle();
  await p.approveDevhub(task.key, 'fix2();').done;
  await settle();
  assert.equal(trials.length, 2, 'edited code is tried again once it is in DevHub');
  assert.equal(trials[1].code, 'fix2();');
  await p.enableDevhub(task.key).done;
  const it = p.get(task.key);
  const swap = calls.find((c) => c.prompt.includes('bật code'));
  assert.ok(swap.prompt.includes('// fix2();') && swap.prompt.includes('ĐÃ XÁC NHẬN 2026-11-05'));
  assert.equal(probes[0].url, 'https://shop-a.myshopify.com/products/x');
  assert.equal(probes[0].inject, undefined, 'the live check runs nothing itself');
  assert.deepEqual([it.devhub.live.state, it.devhub.live.previousVersion], ['live', 5]);
  assert.throws(() => p.enableDevhub(task.key), /đã bật/);
});

test('without a passed trial, enabling takes an explicit force', async () => {
  const { p } = await liveCase({ trialVerdict: 'failed' });
  await settle();
  await p.approveDevhub(task.key).done;
  await settle();
  assert.throws(() => p.enableDevhub(task.key), /Chưa thử fix thành công/);
  await p.enableDevhub(task.key, { force: true }).done;
  assert.equal(p.get(task.key).devhub.live.state, 'live');
  assert.equal(p.get(task.key).devhub.live.tried, false);
});

test('code that breaks the live store is commented back right away', async () => {
  const { p, calls } = await liveCase({ liveCheck: false, liveErrors: ['TypeError: boom'] });
  await settle();
  await p.approveDevhub(task.key).done;
  await settle();
  await p.enableDevhub(task.key).done;
  const it = p.get(task.key);
  assert.equal(it.devhub.live.state, 'reverted');
  assert.deepEqual(it.devhub.live.newErrors, ['TypeError: boom']);
  const revert = calls.at(-1).prompt;
  assert.match(revert, /comment lại block/);
  assert.ok(revert.indexOf('ĐÃ XÁC NHẬN') < revert.indexOf('CHỜ XÁC NHẬN'), 'FROM is the enabled block, TO the commented one');
});

test('a live check that never turns green leaves the code on but flags it; an unverified save is not called live', async () => {
  const a = await liveCase({ liveCheck: false });
  await settle();
  await a.p.approveDevhub(task.key).done;
  await settle();
  await a.p.enableDevhub(task.key).done;
  assert.equal(a.p.get(task.key).devhub.live.state, 'live-unverified');
  assert.equal(a.probes.length, 2);
  const b = await liveCase({ replace: { status: 'done', verified: false, previousVersion: 5 } });
  await settle();
  await b.p.approveDevhub(task.key).done;
  await settle();
  await b.p.enableDevhub(task.key).done;
  assert.equal(b.p.get(task.key).devhub.live.state, 'unknown');
  assert.match(b.p.get(task.key).devhub.live.note, /version 5/);
  assert.equal(b.probes.length, 0);
});

test('question tasks are re-checked by an independent session before review; corrections replace the draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  const calls = [];
  const runner = { run: async (o) => {
    calls.push(o);
    if (o.appendSystem?.includes('KIỂM CHỨNG')) return { costUsd: 0.4, text: reply({
      questions: [
        { q: 'Có ẩn giá cho khách chưa login được không?', verdict: 'confirmed', answer: 'Được: bật Hide price.', answerEn: 'Yes.', evidence: 'knowledge/x' },
        { q: 'Có áp dụng cho từng collection không?', verdict: 'corrected', answer: 'Được, chọn collection trong rule.', answerEn: 'Yes, per rule.', evidence: 'rule.ts:42', note: 'bản đầu nói không' },
      ],
      missed: [],
      comment: 'Tóm tắt: hỏi ẩn giá\nCâu hỏi 1: ...\nTrả lời: Được\nNhờ CS doublecheck lại trước khi gửi khách giúp mình nhé.',
    }) };
    return { costUsd: 1, sessionId: 'sid', text: reply({ type: 'question', comment: 'bản đầu', questions: [
      { q: 'Có ẩn giá cho khách chưa login được không?', answer: 'Được', verified: true, evidence: 'knowledge/x' },
      { q: 'Có áp dụng cho từng collection không?', answer: 'Không', verified: true, evidence: 'đoán' },
    ] }) };
  } };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client: statusClient('Todo') });
  p.offer(task);
  p.approve(task.key);
  await settle();
  const it = p.get(task.key);
  assert.equal(it.state, 'review');
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].resume, 'a fresh session, not the analysis one');
  assert.equal(calls[1].profile, 'analyze', 'read only');
  assert.ok(calls[1].prompt.includes('"answer": "Không"'), 'the draft answers are given to check');
  assert.deepEqual([it.verify.state, it.verify.confirmed, it.verify.corrected, it.verify.unsure], ['done', 1, 1, 0]);
  assert.equal(it.analysis.questions[1].answer, 'Được, chọn collection trong rule.');
  assert.match(it.comment.text, /^Tóm tắt: hỏi ẩn giá/);
  assert.equal(it.costUsd, 1.4);
});

test('a failed check keeps the drafted answers and says so; tasks without questions are not re-checked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  let n = 0;
  const runner = { run: async (o) => {
    n++;
    if (o.appendSystem?.includes('KIỂM CHỨNG')) throw new Error('timeout');
    return { text: reply({ type: 'question', comment: 'bản đầu', questions: [{ q: 'a?', answer: 'b' }] }) };
  } };
  const p = createPipeline({ loadTask: async () => null, statePath: join(dir, 'p.json'), bus: bus(), runner, client: statusClient('Todo') });
  p.offer(task);
  p.approve(task.key);
  await settle();
  const it = p.get(task.key);
  assert.deepEqual([it.state, it.verify.state, it.comment.text], ['review', 'failed', 'bản đầu']);
  assert.equal(n, 2);
});

test('question comments keep their labels in BOSS HTML', () => {
  assert.equal(commentHtml('Câu hỏi 2: x?\nTrả lời: y\nHướng dẫn gửi khách (EN): z'),
    '<p><strong>Câu hỏi 2:</strong> x?</p><p><strong>Trả lời:</strong> y</p><p><strong>Hướng dẫn gửi khách (EN):</strong> z</p>');
});

test('auto analysis can be switched off: a new task then waits for approval', async () => {
  const { createPipeline } = await import('../lib/pipeline.mjs');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pl-auto-'));
  let runs = 0;
  const runner = { run: async () => { runs++; return { text: '```json\n{"type":"bug"}\n```', sessionId: 's', costUsd: 0 }; } };
  const p = createPipeline({ statePath: join(dir, 's.json'), runner, client: null, autoAnalyze: true, loadTask: async () => null });
  assert.equal(p.autoAnalyzeOn(), true);
  p.setAutoAnalyze(false);
  const it = p.offer({ key: 'SBCB2BBS-1', title: 't', app: 'Lock' });
  assert.equal(it.state, 'pending');
  assert.equal(it.auto, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 0);
});
