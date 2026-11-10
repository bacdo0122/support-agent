import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerOf, createTeamCases, tokens } from '../lib/teamcases.mjs';
import { createLearning } from '../lib/learn.mjs';
import { summarize } from '../lib/evaluate.mjs';

test('the TS answer is the labelled TS comments, not CS notes', () => {
  const a = answerOf([
    { author: 'Lena - SBC.B-CS', body: '<p>rpt link</p>' },
    { author: 'Đức BH - SBC.B-TS', body: '<p>đang check</p>' },
    { author: 'Đức BH - SBC.B-TS', body: '<p><strong>Root Cause:</strong> selector sai</p><pre><code>x()</code></pre>', createdAt: '2026-11-01' },
    { author: 'Sammy - SBC.B-CS', body: '<p>Khách hỏi thêm</p>' },
  ]);
  assert.match(a.text, /Root Cause: selector sai/);
  assert.match(a.text, /```\nx\(\)\n```/);
  assert.ok(!a.text.includes('đang check') && !a.text.includes('rpt'));
  assert.equal(answerOf([{ author: 'Lena - SBC.B-CS', body: 'x' }]), null);
  assert.deepEqual(tokens('Cài đặt CP vào Draft theme'), ['cai', 'dat', 'cp', 'draft', 'theme']);
});

test('sync reads Resolved tasks once; search ranks by symptom and hides the task itself and later answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-'));
  let reads = 0;
  const tasks = [
    { name: 'T-1', title: 'Install CP vào draft theme Dawn', relatedApp: 'bss-b2b-solution', description: '<p>cài CP draft theme</p>', resolvedAt: '2026-10-01T00:00:00Z', updatedAt: 'u1' },
    { name: 'T-2', title: 'Giá B2B không áp ở checkout', relatedApp: 'bss-b2b-solution', description: '<p>checkout giá gốc</p>', resolvedAt: '2026-10-05T00:00:00Z', updatedAt: 'u2' },
    { name: 'T-3', title: 'Install VP vào draft theme', relatedApp: 'bss-b2b-solution', description: '<p>VP draft theme</p>', resolvedAt: '2026-11-01T00:00:00Z', updatedAt: 'u3' },
  ];
  const client = {
    callTool: async (name) => {
      if (name === 'search_tasks') return { items: tasks, nextCursor: null };
      reads++;
      return { items: [{ author: 'A - SBC.B-TS', body: '<p>Root Cause: x</p><p>Solution: code DevHub</p>', createdAt: '2026-09-30' }] };
    },
  };
  try {
    const tc = createTeamCases({ dir, client, now: () => new Date('2026-11-09T00:00:00Z') });
    await tc.load();
    assert.deepEqual(await tc.sync(), { added: 3, total: 3 });
    await tc.sync();
    assert.equal(reads, 3, 'unchanged tasks are not read again');
    const hits = tc.search({ title: '[Install] Install CP vào Draft theme', app: 'Solution' }).map((c) => c.key);
    assert.equal(hits[0], 'T-1');
    assert.ok(!hits.includes('T-2'));
    assert.deepEqual(tc.search({ title: 'Install CP draft theme', exclude: ['T-1'], before: '2026-10-20T00:00:00Z' }).map((c) => c.key), []);
    const note = tc.context({ title: 'Install CP draft theme', app: 'Solution' });
    assert.match(note, /T-1 \(Solution\)/);
    assert.match(note, /team-cases\.jsonl/);
    assert.equal((await readFile(join(dir, 'team-cases.jsonl'), 'utf8')).split('\n').length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the analysis gets the most relevant lessons and your own comments of the same type, never the task itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lc-'));
  const lessons = Array.from({ length: 25 }, (_, i) => ({ id: `l${i}`, state: 'approved', app: 'Solution', topic: 'chung', text: `bài ${i} về email`, createdAt: '2026-11-01', approvedAt: '2026-11-01' }));
  lessons.push({ id: 'draft', state: 'approved', app: 'Solution', topic: 'Draft order', text: 'draft order mất giá: xem lịch sử', createdAt: '2026-11-01', approvedAt: '2026-11-01', fromTask: 'X' });
  const fb = {
    A: { key: 'A', app: 'Solution', analysis: { type: 'install' }, mine: { at: '2026-11-01', text: 'Root Cause: mẫu install A' } },
    B: { key: 'B', app: 'Solution', analysis: { type: 'bug' }, mine: { at: '2026-11-02', text: 'Root Cause: mẫu bug B' } },
    C: { key: 'C', app: 'Solution', analysis: { type: 'install' }, mine: { at: '2026-11-03', text: 'Root Cause: mẫu install C' } },
  };
  await writeFile(join(dir, 'lessons.json'), JSON.stringify(lessons));
  await writeFile(join(dir, 'feedback.json'), JSON.stringify(fb));
  try {
    const learn = createLearning({ dir });
    await learn.load();
    const ctx = learn.context({ key: 'C', app: 'Solution', title: 'Draft order bị mất giá B2B' }, { type: 'install' });
    assert.match(ctx, /draft order mất giá/, 'the relevant lesson is kept although it is not among the newest');
    assert.match(ctx, /mẫu install A/);
    assert.ok(!ctx.includes('mẫu install C'), 'never the task itself');
    assert.ok(ctx.indexOf('mẫu install A') < ctx.indexOf('mẫu bug B'));
    const blind = learn.context({ key: 'Z', app: 'Solution', title: 'Draft order mất giá' }, { exclude: ['X'], before: '2026-10-01' });
    assert.ok(!blind.includes('draft order mất giá') && !blind.includes('mẫu'), 'blind runs see nothing from later or from the task');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluation summary per type counts verdicts and confident mistakes', () => {
  const s = summarize([
    { refType: 'bug', confidence: 'high', judge: { verdict: 'sai', score: 2 }, costUsd: 1 },
    { refType: 'bug', confidence: 'medium', judge: { verdict: 'duyệt được', score: 9 }, costUsd: 1 },
    { refType: 'question', confidence: 'high', judge: { verdict: 'sửa nhẹ', score: 7 }, costUsd: 1.5 },
    { refType: 'question', error: 'x' },
  ]);
  const bug = s.byType.find((g) => g.group === 'bug');
  assert.deepEqual([bug.n, bug.approve, bug.wrong, bug.highConfWrong, bug.score], [2, 1, 1, 1, 5.5]);
  assert.deepEqual([s.n, s.graded, s.errors, s.costUsd], [4, 3, 1, 3.5]);
});

test('the module map is used only once reviewed, only for the task app, and hides the evaluated task', async () => {
  const { createModuleMap, parseModuleMap } = await import('../lib/knowledge.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'km-'));
  const file = join(dir, 'modules.md');
  const text = '# Solution\n## CP\n- không cộng dồn (nguồn: SBCB2BBS-1)\n- PL thay được (nguồn: SBCB2BBS-2)\n# Lock\n## Hide price\n- x\n';
  try {
    assert.deepEqual(Object.keys(parseModuleMap(text)), ['Solution', 'Lock']);
    await writeFile(file, `<!-- draft -->\n${text}`);
    const m = createModuleMap({ file });
    assert.equal(m.note({ app: 'Solution' }), '', 'a draft is not used');
    assert.deepEqual(m.state(), { exists: true, draft: true, apps: ['Solution', 'Lock'] });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, text);
    const n = m.note({ app: 'Solution', title: 'Lock ẩn giá' });
    assert.match(n, /## Solution[\s\S]*## Lock/);
    assert.ok(!m.note({ app: 'Solution' }).includes('Hide price'));
    assert.ok(!m.note({ app: 'Solution', exclude: ['SBCB2BBS-2'] }).includes('PL thay được'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
