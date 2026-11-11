#!/usr/bin/env node
// Blind evaluation of /analyze-boss-task on Resolved tasks.
//   node --env-file=.env scripts/eval.mjs [--n 12] [--team 0] [--app Solution] [--keys K1,K2] [--office 0] [--concurrency 2] [--model opus] [--dry]
//   --office 0: the old single-session analysis (to compare with the office: Thủ thư → Chuyên gia → Kiểm định → Biên tập)
// Read only: nothing is written to BOSS, DevHub or stores. Results: data/eval/<run>.json

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBossClient } from '../lib/boss.mjs';
import { createClaudeRunner } from '../lib/claude.mjs';
import { createLearning } from '../lib/learn.mjs';
import { createTeamCases } from '../lib/teamcases.mjs';
import { pickCases, evaluateCase, summarize, saveRun } from '../lib/evaluate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1] ?? true;
};

const client = createBossClient({ url: process.env.BOSS_MCP_URL || 'https://boss.bss-b2b.solutions/mcp', token: process.env.BOSS_TOKEN });
const runner = createClaudeRunner({ cwd: process.env.CLAUDE_CWD || join(ROOT, '..'), model: process.env.CLAUDE_MODEL || 'opus' });
const learn = createLearning({ dir: DATA, runner: null, client: null });
const teamCases = createTeamCases({ dir: DATA, client: null });
await Promise.all([learn.load(), teamCases.load()]);

const cases = await pickCases({ dataDir: DATA, n: Number(arg('n', 12)), team: Number(arg('team', 0)), keys: arg('keys', null)?.split(','), teamCases, app: arg('app', null) });
const office = arg('office', '1') !== '0';
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
console.log(`Chấm mù ${cases.length} task (run ${runId}, ${office ? 'văn phòng nhiều vai' : 'một phiên như cũ'}):`);
for (const c of cases) console.log(`  ${c.key} [${c.source}/${c.type ?? '?'}] ${c.title}  (cắt tại ${c.before})`);
if (arg('dry', false)) process.exit(0);

const results = [];
const queue = cases.map((c, i) => ({ c, i }));
const conc = Number(arg('concurrency', 2));
await Promise.all(Array.from({ length: conc }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const r = await evaluateCase({ ...job, runId, runner, client, learn, teamCases, model: arg('model', undefined), office });
    results.push(r);
    const j = r.judge ?? {};
    console.log(`✓ ${r.key} ${r.error ?? `${j.verdict ?? '?'} ${j.score ?? '?'}/10 · nguyên nhân ${j.rootCause ?? '?'} · xử lý ${j.solution ?? '?'}`} · $${(r.costUsd ?? 0).toFixed(2)} · ${r.seconds ?? '?'}s`);
    await saveRun(DATA, runId, { runId, office, cases: cases.length, results, summary: summarize(results) });
  }
}));
const summary = summarize(results);
const file = await saveRun(DATA, runId, { runId, office, cases: cases.length, results, summary });
console.log('\nTheo loại task:');
for (const g of [...summary.byType, summary.all].filter(Boolean)) {
  console.log(`  ${g.group.padEnd(10)} n=${g.n}  duyệt được ${g.approve} · sửa nhẹ ${g.minor} · sai ${g.wrong} · điểm TB ${g.score} · sai mà tự tin cao ${g.highConfWrong}`);
}
console.log(`Chi phí $${summary.costUsd} · lỗi ${summary.errors} · ${file}`);
