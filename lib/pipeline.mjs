// Approval pipeline for tasks newly assigned to you in Todo:
// pending (you approve) → analyzing (/analyze-boss-task, read only) → review (you approve again)
// → comment posted on BOSS and/or DevHub code written (commented out, autofix-boss rules).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ANALYZE_RULES, commentPrompt, devhubPrompt, extractJson, statusPrompt } from './claude.mjs';

const KEEP = 100; // finished items kept in the file
const ACTIVE = ['pending', 'queued', 'analyzing', 'review', 'failed'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LABEL = /^(Root Cause|Solution|Technical Details|Result)\s*:\s*/i;

// Plain text comment (one item per line) → the HTML BOSS stores: <p><strong>Label:</strong> …</p>, links clickable.
export function commentHtml(text) {
  const link = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a target="_blank" rel="noopener noreferrer" href="${u}">${u}</a>`);
  const out = [];
  let list = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      list ??= [];
      list.push(`<li>${link(line.replace(/^[-*•]\s+/, ''))}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`);
      list = null;
    }
    if (!line) continue;
    const m = LABEL.exec(line);
    out.push(m ? `<p><strong>${esc(m[1])}:</strong> ${link(line.slice(m[0].length))}</p>` : `<p>${link(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

// autoAnalyze: a newly offered task starts right away (status → In Progress, then the analysis) without the first approval.
export function createPipeline({ statePath, bus, runner, client, onChange, concurrency = 1, autoAnalyze = false }) {
  const items = new Map();
  const queue = [];
  const running = new Map(); // key → AbortController
  let saving = Promise.resolve();

  const now = () => new Date().toISOString();
  const list = () => [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const post = (e) => bus.post({ kind: 'boss', ...e });

  function changed(item) {
    if (item) item.updatedAt = now();
    const all = list();
    const done = all.filter((i) => !ACTIVE.includes(i.state));
    for (const old of done.slice(KEEP)) items.delete(old.key);
    saving = saving.then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath + '.tmp', JSON.stringify(list(), null, 1));
      await rename(statePath + '.tmp', statePath); // a reader never sees half a file
    }).catch(() => {});
    onChange?.(list());
  }

  async function load() {
    try {
      for (const it of JSON.parse(await readFile(statePath, 'utf8'))) {
        // work that was running when the server stopped did not finish
        if (it.state === 'queued' || it.state === 'analyzing') Object.assign(it, { state: 'failed', error: 'Server đã dừng giữa chừng, bấm Thử lại' });
        if (it.bossStatus?.state === 'moving') it.bossStatus = { state: 'unknown' }; // retry re-reads the status first
        if (it.comment?.state === 'posting') Object.assign(it.comment, { state: 'unknown', error: 'Server dừng khi đang gửi: xem task trên BOSS trước khi gửi lại' });
        if (it.devhub?.state === 'running') Object.assign(it.devhub, { state: 'unknown', error: 'Server dừng khi đang ghi: xem DevHub và nhật ký autofix trước khi chạy lại' });
        items.set(it.key, it);
      }
    } catch {
      // no file yet
    }
  }

  // A task newly assigned to you in Todo (or reopened into Todo). Returns the item or null when already in progress.
  function offer(task, source = 'auto') {
    const old = items.get(task.key);
    if (old && ACTIVE.includes(old.state)) return null;
    const item = {
      key: task.key, title: task.title, app: task.app, priority: task.priority, due: task.due, reporter: task.reporter,
      source, state: 'pending', createdAt: now(), updatedAt: now(),
      analysis: null, report: '', sessionId: null, costUsd: null, error: null, startedAt: null, finishedAt: null,
      comment: null, devhub: null, bossStatus: null, auto: autoAnalyze,
    };
    items.set(task.key, item);
    changed(item);
    if (autoAnalyze) approve(task.key, { auto: true });
    return item;
  }

  function need(key, ...states) {
    const it = items.get(key);
    if (!it) throw Object.assign(new Error('Không có task này trong hàng đợi'), { status: 404 });
    if (states.length && !states.includes(it.state)) throw Object.assign(new Error(`Task đang ở trạng thái ${it.state}`), { status: 409 });
    return it;
  }

  function pump() {
    while (running.size < concurrency && queue.length) {
      const key = queue.shift();
      const it = items.get(key);
      if (it?.state === 'queued') analyze(it);
    }
  }

  async function analyze(it) {
    const ac = new AbortController();
    running.set(it.key, ac);
    Object.assign(it, { state: 'analyzing', startedAt: now(), error: null });
    changed(it);
    post({ title: 'Bắt đầu phân tích', detail: it.title, task: it.key, app: it.app });
    try {
      const r = await runner.run({ prompt: `/analyze-boss-task ${it.key}`, profile: 'analyze', appendSystem: ANALYZE_RULES, signal: ac.signal });
      const { data, report } = extractJson(r.text);
      Object.assign(it, {
        state: 'review', analysis: data, report, sessionId: r.sessionId, costUsd: r.costUsd, finishedAt: now(),
        error: data ? null : 'Không đọc được khối JSON cuối báo cáo: xem báo cáo đầy đủ',
        comment: { state: 'draft', text: data?.comment ?? '' },
        devhub: data?.devhub?.code ? { state: 'proposed' } : null,
      });
      post({ level: 'attention', type: 'review', title: 'Phân tích xong, chờ bạn duyệt', detail: data?.summary ?? it.title, task: it.key, app: it.app });
    } catch (err) {
      Object.assign(it, { state: 'failed', error: err.message, finishedAt: now() });
      post({ level: 'attention', title: 'Phân tích lỗi', detail: err.message, task: it.key, app: it.app });
    } finally {
      running.delete(it.key);
      changed(it);
      pump();
    }
  }

  // Approval: first move the task Todo → In Progress on BOSS, then queue /analyze-boss-task.
  function approve(key, { auto = false } = {}) {
    const it = need(key, 'pending', 'failed');
    Object.assign(it, { state: 'queued', error: null, note: null, auto });
    changed(it);
    startAfterStatus(it);
    return it;
  }

  async function startAfterStatus(it) {
    if (!['moved', 'kept'].includes(it.bossStatus?.state)) {
      it.bossStatus = { state: 'moving' };
      changed(it);
      it.bossStatus = await moveToInProgress(it.key);
      if (it.bossStatus.state === 'moved') post({ title: 'Đã chuyển task sang In Progress', task: it.key, app: it.app });
      if (it.state !== 'queued') return changed(it); // cancelled meanwhile
      // Started on its own but someone (or your other machine) already took the task: wait for you instead.
      if (it.auto && it.bossStatus.state === 'kept') {
        Object.assign(it, { state: 'pending', note: `Không tự chạy: task đã ở status ${it.bossStatus.from ?? 'khác Todo'}. Bấm Duyệt nếu vẫn muốn phân tích.` });
        post({ level: 'attention', title: 'Không tự phân tích: task không còn ở Todo', detail: it.bossStatus.from ?? '', task: it.key, app: it.app });
        return changed(it);
      }
      if (it.bossStatus.state === 'failed') {
        Object.assign(it, { state: 'failed', error: `Chưa chạy phân tích vì không chuyển được status sang In Progress: ${it.bossStatus.error}` });
        post({ level: 'attention', title: 'Không chuyển được status task', detail: it.bossStatus.error, task: it.key, app: it.app });
        return changed(it);
      }
      changed(it);
    }
    queue.push(it.key);
    pump();
  }

  // Only a task still in Todo is moved; any other status someone set is left alone.
  async function moveToInProgress(key) {
    const at = now();
    let direct;
    try {
      if (!client) throw new Error('Chưa có BOSS_TOKEN');
      const { status } = await client.callTool('read_task', { task_id: key, fields: ['status'] });
      if (status !== 'Todo') return { state: 'kept', from: status, via: 'token', at };
      await client.callTool('update_task', { task: key, status: 'In Progress' });
      return { state: 'moved', from: 'Todo', via: 'token', at };
    } catch (err) {
      direct = err.message;
    }
    // the app's token may lack mcp:task:write: do the same through Claude's BOSS connector
    try {
      const { data } = extractJson((await runner.run({ prompt: statusPrompt(key), profile: 'status' })).text);
      if (!data?.ok) throw new Error(data?.error || 'không xác nhận được');
      return { state: data.moved ? 'moved' : 'kept', from: data.from ?? null, via: 'claude', at };
    } catch (err) {
      return { state: 'failed', error: `${direct} · qua Claude: ${err.message}`, at };
    }
  }

  function skip(key) {
    const it = need(key, 'pending', 'failed', 'review');
    it.state = 'skipped';
    changed(it);
    return it;
  }

  function cancel(key) {
    const it = need(key, 'queued', 'analyzing');
    const i = queue.indexOf(key);
    if (i >= 0) queue.splice(i, 1);
    running.get(key)?.abort();
    if (it.state === 'queued') {
      Object.assign(it, { state: 'failed', error: 'Đã huỷ' });
      changed(it);
    }
    return it;
  }

  function finish(key) {
    const it = need(key, 'review');
    it.state = 'done';
    changed(it);
    return it;
  }

  // Second approval: post exactly the text you approved.
  // Checks run before returning; the posting itself continues in the background (done: the returned promise).
  function approveComment(key, text) {
    const it = need(key, 'review');
    if (['posting', 'posted'].includes(it.comment?.state)) throw Object.assign(new Error('Comment đã gửi hoặc đang gửi'), { status: 409 });
    const body = String(text ?? '').trim();
    if (!body) throw Object.assign(new Error('Comment trống'), { status: 400 });
    const html = commentHtml(body);
    it.comment = { state: 'posting', text: body, html };
    changed(it);
    return { item: it, done: postComment(it, key, html) };
  }

  async function postComment(it, key, html) {
    let via = 'token';
    try {
      let url = null;
      try {
        if (!client) throw new Error('Chưa có BOSS_TOKEN');
        url = (await client.callTool('add_task_comment', { task: key, content: html }))?.webUrl ?? null;
      } catch (direct) {
        // the app's token may not have mcp:task:comment:write: post the same HTML through Claude's BOSS connector
        via = 'claude';
        const r = await runner.run({ prompt: commentPrompt(key, html), profile: 'comment' });
        const { data } = extractJson(r.text);
        if (!data?.ok) throw new Error(`${direct.message} · qua Claude: ${data?.error ?? 'không xác nhận được đã gửi'}`);
        url = data.webUrl ?? null;
      }
      Object.assign(it.comment, { state: 'posted', via, url, at: now() });
      post({ title: 'Đã comment lên task', detail: via === 'claude' ? 'gửi qua Claude (token app không có quyền ghi)' : '', task: key, app: it.app });
    } catch (err) {
      Object.assign(it.comment, { state: 'failed', error: err.message });
      post({ level: 'attention', title: 'Comment lên task lỗi', detail: err.message, task: key, app: it.app });
    }
    changed(it);
    return it;
  }

  // Second approval: let Claude write the proposed code into DevHub (commented out, autofix-boss 3B).
  function approveDevhub(key, code) {
    const it = need(key, 'review');
    if (!it.analysis?.devhub) throw Object.assign(new Error('Phân tích không đề xuất code DevHub'), { status: 400 });
    if (['running', 'written'].includes(it.devhub?.state)) throw Object.assign(new Error('DevHub đã ghi hoặc đang ghi'), { status: 409 });
    if (typeof code === 'string' && code.trim()) it.analysis.devhub.code = code;
    it.devhub = { state: 'running', startedAt: now() };
    changed(it);
    post({ title: 'Bắt đầu ghi DevHub (dạng comment)', task: key, app: it.app });
    return { item: it, done: writeDevhub(it, key) };
  }

  async function writeDevhub(it, key) {
    try {
      const r = await runner.run({ prompt: devhubPrompt(it), profile: 'devhub', resume: it.sessionId ?? undefined });
      const { data, report } = extractJson(r.text);
      const state = data?.status === 'written' ? 'written' : data?.status === 'skipped' ? 'skipped' : 'failed';
      it.devhub = { state, detail: data?.detail ?? '', block: data?.block ?? null, report, at: now() };
      post({ level: state === 'written' ? 'info' : 'attention', title: state === 'written' ? 'Đã ghi DevHub, chờ xác nhận bỏ comment' : 'Không ghi DevHub', detail: it.devhub.detail, task: key, app: it.app });
    } catch (err) {
      it.devhub = { state: 'failed', error: err.message, at: now() };
      post({ level: 'attention', title: 'Ghi DevHub lỗi', detail: err.message, task: key, app: it.app });
    }
    changed(it);
    return it;
  }

  return { load, list, offer, approve, skip, cancel, finish, approveComment, approveDevhub, get: (k) => items.get(k) };
}
