// Team case library: Resolved BOSS tasks of the whole team with the TS answer (Root Cause / Solution / code), so a new
// analysis starts from the closest precedents instead of keyword-searching BOSS itself.
// data/team-cases.json (index) + data/team-cases.jsonl (one case per line, for Grep).

import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { richText } from './taskdata.mjs';

const APP = { 'bss-b2b-solution': 'Solution', 'bss-b2b-quote': 'Quote', 'bss-b2b-lock': 'Lock' };
const STAFF_TS = /-\s*(SBC\.?B?-)?(TS|DEV)\s*$/i;
const LABELS = /root\s*cause|solution|technical details|result|trả lời|nguyên nhân/i;
const STOP = new Set('va la cua cho cac khi thi de duoc khong co nhung mot trong nay voi tren duoi tai sau truoc the nao lai van chi nhu cung bi hay hoac neu vao ra len xuong the and the for with not are this that from have has was were you your our can will issue task khach hang nho check giup em anh chi ban minh'.split(' '));

export const tokens = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
  .match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];

// Template lines of the BOSS description (To reproduce / Environment ...) carry no symptom.
const symptomOf = (descText) => descText
  .replace(/^(-\s*)?(Partner|Crisp|To reproduce|Expected behavior|Screenshots \/ Evidence|Environment|Account test\/Tag|Link|Theme)\s*:?\s*(https?:\/\/\S+)?\s*$/gim, '')
  .replace(/^Describe the issue\s*:\s*/gim, '')
  .replace(/^\s*-\s*$/gm, '').replace(/\n{2,}/g, '\n').trim();

// The TS answer: labelled comments (Root Cause / Solution / ...) by TS, else the last TS comments.
export function answerOf(comments) {
  const ts = (comments ?? []).filter((c) => STAFF_TS.test(String(c.author ?? '')) || c.isMine);
  if (!ts.length) return null;
  const labelled = ts.filter((c) => LABELS.test(String(c.body ?? '')));
  const pick = labelled.length ? labelled : ts.slice(-2);
  const text = pick.map((c) => richText(c.body)).join('\n---\n').trim();
  return text ? { text: text.slice(0, 6000), author: pick.at(-1).author ?? '', at: pick.at(-1).createdAt ?? null } : null;
}

export function createTeamCases({ dir, client, now = () => new Date(), sinceDays = 180, concurrency = 4, log = () => {} }) {
  const file = join(dir, 'team-cases.json');
  const lines = join(dir, 'team-cases.jsonl');
  let db = { syncedAt: null, cases: {} };
  let index = null;
  let syncing = null;

  async function load() {
    try {
      db = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      db = { syncedAt: null, cases: {} };
    }
    index = null;
  }

  async function save() {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(db));
    await rename(tmp, file);
    const list = Object.values(db.cases).filter((c) => c.answer);
    await writeFile(`${lines}.tmp`, list.map((c) => JSON.stringify({ key: c.key, app: c.app, title: c.title, resolvedAt: c.resolvedAt, symptom: c.symptom, answer: c.answer })).join('\n'));
    await rename(`${lines}.tmp`, lines);
  }

  async function build(t) {
    const comments = await client.callTool('read_task_comments', { task_id: t.name, fields: ['author', 'body', 'isMine', 'createdAt'] });
    const ans = answerOf(comments?.items);
    return {
      key: t.name, app: APP[t.relatedApp] ?? t.relatedApp ?? null, title: t.title ?? '', createdAt: t.createdAt ?? null,
      resolvedAt: t.resolvedAt ?? null, updatedAt: t.updatedAt ?? null,
      symptom: symptomOf(richText(t.description)).slice(0, 2000),
      answer: ans?.text ?? null, answerBy: ans?.author ?? null, answerAt: ans?.at ?? null,
    };
  }

  // New or changed Resolved tasks since the last sync (first run: sinceDays back).
  async function sync({ maxPages = 400 } = {}) {
    if (!client) return { added: 0 };
    if (syncing) return syncing;
    syncing = (async () => {
      const from = db.syncedAt ? new Date(new Date(db.syncedAt).getTime() - 86400000) : new Date(now().getTime() - sinceDays * 86400000);
      const started = now().toISOString();
      const todo = [];
      let cursor = null;
      let pages = 0;
      do {
        const r = await client.callTool('search_tasks', {
          status: 'Resolved', updated_from: from.toISOString(), limit: 100, cursor,
          fields: ['id', 'name', 'title', 'relatedApp', 'description', 'createdAt', 'resolvedAt', 'updatedAt'],
        });
        for (const t of r?.items ?? []) {
          const old = db.cases[t.name];
          if (!old || old.resolvedAt !== t.resolvedAt || (!old.answer && old.updatedAt !== t.updatedAt)) todo.push(t);
        }
        cursor = r?.nextCursor ?? null;
      } while (cursor && ++pages < maxPages);
      let added = 0;
      for (let i = 0; i < todo.length; i += concurrency) {
        const got = await Promise.all(todo.slice(i, i + concurrency).map((t) => build(t).catch(() => null)));
        for (const c of got) if (c) {
          db.cases[c.key] = c;
          added++;
        }
        if (i % 200 === 0) log(`kho tiền lệ: ${i + got.length}/${todo.length}`);
        if (i % 400 === 0) await save();
      }
      db.syncedAt = started;
      index = null;
      await save();
      return { added, total: Object.keys(db.cases).length };
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  // BM25 over title (×3) + symptom.
  function buildIndex() {
    const docs = Object.values(db.cases).filter((c) => c.answer).map((c) => {
      const tf = new Map();
      for (const w of [...tokens(c.title), ...tokens(c.title), ...tokens(c.title), ...tokens(c.symptom)]) tf.set(w, (tf.get(w) ?? 0) + 1);
      return { c, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) };
    });
    const df = new Map();
    for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
    return { docs, df, avg, n: docs.length };
  }

  // exclude: keys to leave out; before: only cases resolved before this time (blind evaluation).
  function search({ title = '', text = '', app = null, exclude = [], before = null, k = 5 } = {}) {
    index ??= buildIndex();
    const q = [...new Set([...tokens(title), ...tokens(title), ...tokens(text).slice(0, 120)])];
    if (!q.length) return [];
    const k1 = 1.4;
    const b = 0.75;
    const skip = new Set(exclude);
    const cut = before ? new Date(before).getTime() : null;
    return index.docs
      .filter(({ c }) => !skip.has(c.key) && (!cut || (c.resolvedAt && new Date(c.resolvedAt).getTime() < cut)))
      .map((d) => {
        let s = 0;
        for (const w of q) {
          const f = d.tf.get(w);
          if (!f) continue;
          const idf = Math.log(1 + (index.n - index.df.get(w) + 0.5) / (index.df.get(w) + 0.5));
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avg)));
        }
        return { c: d.c, score: s * (app && d.c.app === app ? 1.25 : 1) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, k)
      .map((x) => ({ ...x.c, score: Math.round(x.score * 10) / 10 }));
  }

  // Added to the analysis prompt.
  function context({ title, text, app, exclude, before, k = 5 } = {}) {
    const found = search({ title, text, app, exclude, before, k });
    if (!found.length) return '';
    return `\n\nTiền lệ của team (task đã Resolved, tự tìm theo độ giống triệu chứng; dùng làm điểm xuất phát cho Bước 3 của skill, tự đọc thêm task nếu cần, kiểm chứng lại có cùng nguyên nhân không trước khi dùng):\n${found.map((c) =>
      `### ${c.key} (${c.app ?? '?'}) ${c.title}\nResolved ${String(c.resolvedAt ?? '').slice(0, 10)} · trả lời bởi ${c.answerBy ?? '?'}\nTriệu chứng: ${c.symptom.slice(0, 500).replace(/\n/g, ' / ')}\nTS đã trả lời:\n${c.answer.slice(0, 1800)}${c.answer.length > 1800 ? '\n…(còn nữa, đọc task để xem đủ)' : ''}`).join('\n\n')}${
      before ? '' : `\n\nToàn bộ kho tiền lệ (${index.n} task): ${lines} (mỗi dòng một task JSON) — Grep theo từ khoá để tìm thêm.`}`;
  }

  const stats = () => {
    const all = Object.values(db.cases);
    return { total: all.length, withAnswer: all.filter((c) => c.answer).length, syncedAt: db.syncedAt };
  };

  return { load, sync, search, context, stats, get: (k) => db.cases[k], files: { file, lines } };
}
