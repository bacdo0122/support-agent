import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOffice, applyReview } from '../lib/office.mjs';
import { createPipeline } from '../lib/pipeline.mjs';
import { commentTemplateIssue } from '../lib/claude.mjs';

const json = (x) => `báo cáo\n\`\`\`json\n${JSON.stringify(x)}\n\`\`\``;
const GOOD = 'Root Cause: a\nSolution: b\nTechnical Details: c\nResult: d';
const it = { key: 'SBCB2BBS-9', app: 'Solution', title: 'Giá VP không áp ở checkout' };
const d = { task: { name: 'SBCB2BBS-9', title: it.title, description: '<p>VP không áp</p>', status: 'Todo' }, comments: [], crisp: null, images: [] };
const sources = {
  teamCases: { search: () => [{ key: 'SBCB2BBS-1', app: 'Solution', title: 'VP checkout', symptom: 's', answer: 'Root Cause: draft order' }, { key: 'SBCB2BBS-2', app: 'Solution', title: 'khác', symptom: 's', answer: 'x' }], files: {} },
  learn: { similarCases: () => [], pickLessons: () => [{ app: 'Solution', topic: 'VP', text: 'bài học 1' }, { app: 'Solution', text: 'bài học 2' }], styleExamples: () => [], files: {} },
  packs: { pack: (a) => `\nGÓI ${a}` },
  moduleMap: { note: () => '\nBẢN ĐỒ' },
};

// answers by role, recognised from the system prompt
function fakeRunner(over = {}) {
  const calls = [];
  const runner = {
    calls,
    async run(o) {
      const role = o.appendSystem.includes('LỄ TÂN') ? 'receptionist' : o.appendSystem.includes('Thủ thư của phòng') ? 'librarian'
        : o.appendSystem.includes('KIỂM ĐỊNH độc lập') ? 'reviewer' : o.appendSystem.includes('BIÊN TẬP') ? 'editor'
        : o.appendSystem.includes('CHUYÊN GIA của một app') ? 'consult' : o.resume ? 'resume' : 'analyst';
      calls.push({ role, ...o });
      if (over[role]) return over[role](o, calls.filter((c) => c.role === role).length);
      if (role === 'receptionist') return { text: json({ type: 'bug', apps: ['Solution'], crossApp: false, missing: [], summary: 'VP' }), costUsd: 0.01 };
      if (role === 'librarian') return { text: json({ precedents: [{ key: 'SBCB2BBS-1', why: 'cùng VP', use: 'xem draft order' }], lessons: [2], hypotheses: ['kiểm draft order'] }), costUsd: 0.02 };
      if (role === 'analyst') return { text: json({ type: 'bug', confidence: 'high', rootCause: 'theme', solution: 's', comment: 'Root Cause: cũ' }), costUsd: 1, sessionId: 'sid' };
      if (role === 'reviewer') return { text: json({ verdict: 'fix', confidence: 'medium', rootCause: 'draft order bỏ VP', claims: [{ claim: 'do theme', verdict: 'corrected', evidence: 'x.ts:1', fix: 'draft order' }] }), costUsd: 0.8 };
      return { text: json({ comment: GOOD }), costUsd: 0.05 };
    },
  };
  return runner;
}

test('a task goes clerk → librarian → specialist → reviewer → editor, all in the case folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-'));
  const runner = fakeRunner();
  const o = await runOffice({ it, d, runner, rules: 'RULES', sources, caseDir: dir });
  assert.deepEqual(o.steps.map((s) => [s.id, s.state]), [['clerk', 'done'], ['receptionist', 'done'], ['librarian', 'done'], ['analyst', 'done'], ['reviewer', 'done'], ['editor', 'done']]);
  assert.equal(runner.calls.find((c) => c.role === 'receptionist').model, 'haiku');
  assert.match(runner.calls.find((c) => c.role === 'analyst').appendSystem, /Lễ tân đã phân loại[\s\S]*askOtherApp/);
  // librarian: only the picked precedent and lesson reach the specialist, with the app pack and module map
  const analyst = runner.calls.find((c) => c.role === 'analyst');
  assert.match(analyst.appendSystem, /SBCB2BBS-1/);
  assert.doesNotMatch(analyst.appendSystem, /SBCB2BBS-2/);
  assert.match(analyst.appendSystem, /bài học 2/);
  assert.doesNotMatch(analyst.appendSystem, /bài học 1/);
  assert.match(analyst.appendSystem, /GÓI Solution[\s\S]*BẢN ĐỒ/);
  assert.equal(runner.calls.find((c) => c.role === 'librarian').model, 'sonnet');
  assert.equal(runner.calls.find((c) => c.role === 'editor').model, 'sonnet');
  // reviewer corrected the cause and lowered the confidence; the editor wrote the comment
  assert.equal(o.data.rootCause, 'draft order bỏ VP');
  assert.equal(o.data.confidence, 'medium');
  assert.equal(o.data.review.verdict, 'fix');
  assert.equal(o.data.comment, GOOD);
  assert.equal(o.costUsd, 1.88);
  assert.deepEqual(o.escalations, []);
  const files = await readdir(dir);
  for (const f of ['task.md', 'intake.json', 'precedents.md', 'report.md', 'analysis.json', 'review.json', 'comment.md', 'messages.jsonl', 'decisions.jsonl', 'analysis.final.json']) assert.ok(files.includes(f), f);
  const msgs = (await readFile(join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => `${m.from}→${m.to}`), ['Lễ tân→Thủ thư', 'Thủ thư→Chuyên gia Solution', 'Chuyên gia Solution→Kiểm định', 'Kiểm định→Biên tập', 'Biên tập→Giám đốc']);
});

test('when a staff member fails the task still gets through, the old way, and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-'));
  const runner = fakeRunner({
    librarian: () => ({ text: 'không có json' }),
    reviewer: () => { throw new Error('hết giờ'); },
    editor: () => ({ text: json({ comment: 'Solution: thiếu mục' }) }),
  });
  const o = await runOffice({ it, d, runner, rules: 'R', sources, caseDir: dir });
  assert.deepEqual(o.steps.map((s) => s.state), ['done', 'done', 'failed', 'done', 'failed', 'failed']);
  assert.deepEqual(o.escalations.map((e) => e.kind), ['review']);
  // librarian failed: the specialist still gets the candidates by words
  assert.match(runner.calls.find((c) => c.role === 'analyst').appendSystem, /SBCB2BBS-2/);
  // not reviewed: confidence at most medium; editor failed twice (asked to fix the template once): analyst's comment kept
  assert.equal(o.data.review.verdict, 'unchecked');
  assert.equal(o.data.confidence, 'medium');
  assert.equal(runner.calls.filter((c) => c.role === 'editor').length, 2);
  assert.match(runner.calls.filter((c) => c.role === 'editor')[1].prompt, /chưa đúng template/);
  assert.equal(o.data.comment, 'Root Cause: cũ');
  const decisions = await readFile(join(dir, 'decisions.jsonl'), 'utf8');
  assert.match(decisions, /Thủ thư lỗi/);
  assert.match(decisions, /Kiểm định lỗi/);
  assert.match(decisions, /giữ comment của chuyên gia/);
});

test('no analysis: reviewer and editor are skipped', async () => {
  const o = await runOffice({ it, d, runner: fakeRunner({ analyst: () => ({ text: 'không có json' }) }), rules: 'R', sources });
  assert.equal(o.data, null);
  assert.deepEqual(o.steps.slice(3).map((s) => s.state), ['failed', 'skipped', 'skipped']);
  assert.deepEqual(o.escalations.map((e) => e.kind), ['failed']);
});

test('applyReview: question verdicts, wrong verdict forces low confidence, needs merged', () => {
  const { data, verify } = applyReview({ confidence: 'high', needs: ['a'], questions: [{ q: 'x' }] }, {
    verdict: 'wrong', confidence: 'high', needs: ['a', 'b'],
    questions: [{ q: 'x', verdict: 'corrected', answer: 'y' }, { q: 'z', verdict: 'unsure', answer: '?' }], missed: ['z'],
  });
  assert.equal(data.confidence, 'low');
  assert.deepEqual(data.needs, ['a', 'b']);
  assert.deepEqual(data.questions.map((q) => q.verified), [true, false]);
  assert.deepEqual([verify.corrected, verify.unsure, verify.missed], [1, 1, ['z']]);
  assert.deepEqual(data.review.changed, ['questions']);
});

test('commentTemplateIssue', () => {
  assert.equal(commentTemplateIssue(GOOD), '');
  assert.equal(commentTemplateIssue('Solution: b\nRoot Cause: a\nTechnical Details: c\nResult: d'), 'sai thứ tự mục');
  assert.match(commentTemplateIssue('Root Cause: a'), /thiếu Solution/);
});

test('pipeline with the office: the card gets the staff steps and the edited comment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-pipe-'));
  const p = createPipeline({
    loadTask: async () => d, statePath: join(dir, 'p.json'), bus: { post() {} }, runner: fakeRunner(), autoAnalyze: true,
    client: { callTool: async () => ({}) }, office: { sources, caseRoot: join(dir, 'cases') },
  });
  await p.load();
  p.offer({ ...it, priority: '', due: '', reporter: '' });
  for (let i = 0; i < 50 && p.get(it.key).state !== 'review'; i++) await new Promise((r) => setTimeout(r, 10));
  const x = p.get(it.key);
  assert.equal(x.state, 'review');
  assert.equal(x.comment.text, GOOD);
  assert.equal(x.office.length, 6);
  assert.equal(x.caseDir, join(dir, 'cases', it.key));
  assert.ok((await readdir(x.caseDir)).includes('review.json'));
});

test('cross-app: the specialist asks the other app, gets the answer and updates in the same session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-'));
  const runner = fakeRunner({
    analyst: () => ({ text: json({ type: 'bug', confidence: 'medium', rootCause: 'chưa rõ', askOtherApp: [{ app: 'Quote', question: 'Quote lấy giá từ đâu?' }, { app: 'Solution', question: 'tự hỏi mình' }] }), costUsd: 1, sessionId: 'sid' }),
    consult: () => ({ text: json({ answer: 'Quote chỉ lấy giá Shopify', evidence: 'q.ts:9', confidence: 'high' }), costUsd: 0.5 }),
    resume: () => ({ text: json({ type: 'bug', confidence: 'high', rootCause: 'Quote không đọc giá B2B', comment: 'Root Cause: x' }), costUsd: 0.3, sessionId: 'sid' }),
  });
  const o = await runOffice({ it, d, runner, rules: 'R', sources, caseDir: dir });
  assert.deepEqual(o.steps.map((s) => s.id), ['clerk', 'receptionist', 'librarian', 'analyst', 'consult:Quote', 'followup', 'reviewer', 'editor']);
  assert.equal(o.steps.find((s) => s.id === 'consult:Quote').name, 'Chuyên gia Quote');
  assert.equal(runner.calls.filter((c) => c.role === 'consult').length, 1, 'no question to its own app');
  assert.match(runner.calls.find((c) => c.role === 'consult').prompt, /Quote lấy giá từ đâu/);
  const resume = runner.calls.find((c) => c.role === 'resume');
  assert.equal(resume.resume, 'sid');
  assert.match(resume.prompt, /Quote chỉ lấy giá Shopify/);
  assert.equal(o.data.consults[0].answer, 'Quote chỉ lấy giá Shopify');
  assert.equal(o.data.askOtherApp, undefined);
  assert.ok((await readdir(dir)).includes('consults.json'));
});

test('reviewer says wrong: the case goes back to the specialist once, then a second review', async () => {
  let reviews = 0;
  const runner = fakeRunner({
    reviewer: () => (++reviews === 1
      ? { text: json({ verdict: 'wrong', confidence: 'low', claims: [{ claim: 'do theme', verdict: 'wrong', evidence: 'x', fix: 'draft order' }] }), costUsd: 0.5 }
      : { text: json({ verdict: 'ok', confidence: 'high', claims: [{ claim: 'draft order', verdict: 'confirmed' }] }), costUsd: 0.5 }),
    resume: () => ({ text: json({ type: 'bug', confidence: 'high', rootCause: 'draft order', comment: 'Root Cause: y' }), costUsd: 0.4, sessionId: 'sid' }),
  });
  const o = await runOffice({ it, d, runner, rules: 'R', sources });
  assert.deepEqual(o.steps.map((s) => s.id), ['clerk', 'receptionist', 'librarian', 'analyst', 'reviewer', 'redo', 'review2', 'editor']);
  assert.match(runner.calls.find((c) => c.role === 'resume').prompt, /KIỂM ĐỊNH TRẢ HỒ SƠ[\s\S]*do theme[\s\S]*draft order/);
  assert.equal(o.data.rootCause, 'draft order');
  assert.equal(o.data.review.verdict, 'ok');
  assert.deepEqual(o.escalations, []);
});

test('over budget: no extra work, it goes to you instead', async () => {
  const runner = fakeRunner({
    analyst: () => ({ text: json({ type: 'bug', confidence: 'high', rootCause: 'a', askOtherApp: [{ app: 'Lock', question: '?' }] }), costUsd: 5, sessionId: 'sid' }),
    reviewer: () => ({ text: json({ verdict: 'wrong', confidence: 'low', claims: [] }), costUsd: 1 }),
  });
  const o = await runOffice({ it, d, runner, rules: 'R', sources, budgetUsd: 2 });
  assert.equal(runner.calls.filter((c) => c.role === 'consult' || c.role === 'resume').length, 0);
  assert.deepEqual(o.escalations.map((e) => e.kind), ['budget', 'cross-app', 'budget', 'review']);
  assert.match(o.escalations[0].text, /ngân sách \$2/);
});

test('live progress: tool calls of a step are counted and the last 10 kept, newest first', async () => {
  const seen = [];
  const runner = fakeRunner({
    analyst: (o) => {
      for (let i = 0; i < 12; i++) o.onEvent({ tool: 'Read', input: { file_path: `/x/f${i}.ts` }, sub: i === 11 });
      return { text: json({ type: 'bug', confidence: 'high', rootCause: 'a' }), costUsd: 1, sessionId: 'sid' };
    },
  });
  const o = await runOffice({ it, d, runner, rules: 'R', sources, onStep: (steps, opt) => opt?.live && seen.push(steps.find((s) => s.id === 'analyst').tools) });
  const a = o.steps.find((s) => s.id === 'analyst');
  assert.equal(a.tools, 12);
  assert.equal(a.recent.length, 10);
  assert.equal(a.recent[0].text, '↳ Đọc f11.ts');
  assert.equal(a.recent[9].text, 'Đọc f2.ts');
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(runner.calls.find((c) => c.role === 'librarian').onEvent, undefined, 'no-tool staff do not stream');
});
