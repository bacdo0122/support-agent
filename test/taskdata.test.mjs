import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { richText, loadTaskData, taskDataNote } from '../lib/taskdata.mjs';
import { analyzeRules, ANALYZE_RULES, PROFILES, createClaudeRunner } from '../lib/claude.mjs';
import { EventEmitter } from 'node:events';

test('richText keeps links, local images, code indentation and list items', () => {
  const html = '<p>Xem <a href="https://x.test/a">trang</a> và <img src="/file-view/t/a.png"></p><ul><li>một</li><li>hai</li></ul>'
    + '<pre><code class="language-javascript">if (a) {\n  b();\n}</code></pre><p>&lt;div&gt; &amp; <code>x &gt; 1</code></p>';
  const t = richText(html, new Map([['/file-view/t/a.png', '/logs/img/01-a.png']]));
  assert.match(t, /trang \(https:\/\/x\.test\/a\)/);
  assert.match(t, /\[ảnh: \/logs\/img\/01-a\.png\]/);
  assert.match(t, /- một\n- hai/);
  assert.match(t, /```\nif \(a\) \{\n  b\(\);\n\}\n```/);
  assert.match(t, /<div> & `x > 1`/);
});

test('loadTaskData reads Crisp back to the task date, and the note replaces steps 1–2 of the skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-'));
  const calls = [];
  const day = (d) => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;
  const client = {
    callTool: async (name, args) => {
      calls.push([name, args.cursor ?? null]);
      if (name === 'read_task') return { name: 'K-1', title: 'Issue: giá', status: 'Todo', createdAt: day(20), description: '<p>Crisp: https://app.crisp.chat/inbox/session_11111111-2222-3333-4444-555555555555/</p><img src="/file-view/t/a.png">' };
      if (name === 'read_task_comments') return { items: [{ author: 'CS', createdAt: day(21), body: '<p>khách gửi ảnh</p>', attachments: [{ fileName: 'b.png', url: '/file-view/c/b.png' }] }] };
      // newest page first, then an older page
      if (!args.cursor) return { items: [{ messageId: 3, role: 'visitor', body: 'giá sai', createdAt: day(19) }, { messageId: 4, role: 'operator', body: 'để em check', createdAt: day(20) }], nextCursor: 'c1' };
      return { items: [{ messageId: 1, role: 'visitor', body: 'case cũ', createdAt: '2026-09-01T00:00:00.000Z' }, { messageId: 2, role: 'visitor', body: 'hello', createdAt: day(18) }], nextCursor: 'c2' };
    },
  };
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer });
  try {
    const d = await loadTaskData({ client, key: 'K-1', imgDir: dir, fetchImpl });
    assert.deepEqual(calls.filter(([n]) => n === 'read_conversation_messages').map(([, c]) => c), [null, 'c1'], 'stops once older than the task window');
    assert.deepEqual(d.crisp.map((m) => m.body), ['hello', 'giá sai', 'để em check'], 'oldest first, case from September dropped');
    assert.equal(d.images.filter((x) => x.file).length, 2);
    assert.equal(calls.filter(([n]) => n === 'read_task').length, 1, 'images reuse the task already read');
    const note = taskDataNote(d);
    assert.match(note, /Không gọi lại read_task \/ read_task_comments \/ read_conversation_messages cho K-1/);
    assert.ok(note.includes(join(dir, '01-a.png')) && note.includes(join(dir, '02-b.png')));
    assert.match(note, /visitor: giá sai/);
    assert.equal(taskDataNote(null), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rule sections follow the task: install rules only for install tasks, question rules unless clearly install only', () => {
  const bug = analyzeRules({ title: 'Issue (CP): giá B2B không hiện trên PDP' });
  const install = analyzeRules({ title: '[Install] Install CP vào Draft theme' });
  const installQ = analyzeRules({ title: 'Install VP: khách hỏi có cài được lên draft theme không?' });
  assert.ok(bug.includes('Task hỏi cách dùng') && !bug.includes('Task CÀI MODULE'));
  assert.ok(install.includes('Task CÀI MODULE') && !install.includes('Task hỏi cách dùng'));
  assert.ok(installQ.includes('Task CÀI MODULE') && installQ.includes('Task hỏi cách dùng'));
  for (const r of [bug, install]) assert.ok(r.includes('ĐÚNG MỘT khối') && r.includes('"devhub.test" dùng để'));
  assert.ok(ANALYZE_RULES.length > bug.length);
});

test('mechanical steps run on Sonnet; the analysis keeps the default model with a short tool list', async () => {
  for (const p of ['devhub', 'status', 'comment']) assert.equal(PROFILES[p].model, 'sonnet');
  assert.equal(PROFILES.analyze.model, undefined);
  const seen = [];
  const spawnImpl = (bin, args) => {
    seen.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', JSON.stringify({ result: 'ok', is_error: false })); child.emit('close', 0); });
    return child;
  };
  const runner = createClaudeRunner({ cwd: '/x', spawnImpl, model: 'opus' });
  await runner.run({ prompt: 'p', profile: 'devhub' });
  await runner.run({ prompt: 'p', profile: 'analyze' });
  await runner.run({ prompt: 'p', profile: 'lesson', model: 'haiku' });
  const opt = (args, f) => args[args.indexOf(f) + 1];
  assert.deepEqual(seen.map((a) => opt(a, '--model')), ['sonnet', 'opus', 'haiku']);
  assert.equal(opt(seen[1], '--tools'), PROFILES.analyze.tools.join(','));
  assert.ok(!seen[0].includes('--tools'));
});
