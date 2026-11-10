// Approval pipeline for tasks newly assigned to you in Todo:
// pending (you approve) → analyzing (/analyze-boss-task, read only) → review (you approve again)
// → comment posted on BOSS and/or DevHub code written (commented out, autofix-boss rules).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { probePage, trialFix } from './trial.mjs';
import { imagesNote } from './images.mjs';
import { loadTaskData, taskDataNote } from './taskdata.mjs';
import { analyzeRules, askRules, INSTALL_TASK, QUESTION_TASK, VERIFY_RULES, verifyPrompt, APP_HANDLES, appendBlock, blockCode, commentPrompt, devhubBlock, devhubPrompt, devhubReplacePrompt, enableBlock, extractJson, statusPrompt } from './claude.mjs';

const KEEP = 100; // finished items kept in the file
const ACTIVE = ['pending', 'queued', 'analyzing', 'review', 'failed'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LABEL = /^(Root Cause|Solution|Technical Details|Result|Tóm tắt|Câu hỏi \d+|Trả lời|Hướng dẫn gửi khách \(EN\)|Nguồn)\s*:\s*/i;

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
// logsDir: where the analysis saves images, Sentry snapshots and store screenshots; <dir>/<kind>/<KEY>/ is created before each run.
// devhubApps: apps whose DevHub save is known not to write the customer's theme (see autofix-boss 3B step 2a).
// probeStore(domain) → 'v2' | 'legacy' | 'unknown': Lock shops on the old version get snippets pushed into the theme on save.
// Before the analysis: which of your past comments to show as the model (install / question / unknown).
export const guessType = (title, description = '') => {
  const t = `${title}\n${String(description ?? '').replace(/<[^>]+>/g, ' ')}`;
  return INSTALL_TASK.test(t) ? 'install' : QUESTION_TASK.test(title) ? 'question' : null;
};

export function createPipeline({ statePath, bus, runner, client, onChange, concurrency = 1, autoAnalyze = false, logsDir = null, loadTask = loadTaskData,
  devhubApps = ['Lock'], probeStore = probeLockStore, today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }),
  chromeBin = 'google-chrome', trial = trialFix, probe = probePage, liveDelays = [20000, 30000, 60000],
  hooks = {} }) { // hooks: {finished(item, {reason}), reopened(key), context(item) → text added to the analysis prompt}
  const items = new Map();
  const queue = [];
  const running = new Map(); // key → AbortController
  let auto = autoAnalyze; // switched from the page (setAutoAnalyze); off: new tasks wait in 'pending' for your approval
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
        if (it.asking) {
          it.asking = false;
          it.chat = [...(it.chat ?? []), { role: 'error', text: 'Server dừng khi Claude đang trả lời: gửi lại câu hỏi', at: new Date().toISOString() }];
        }
        if (it.verify?.state === 'running') it.verify = { state: 'failed', error: 'Server dừng giữa chừng' };
        if (it.trial?.state === 'running') it.trial = { state: 'unknown', note: 'Server dừng khi đang thử: bấm Thử lại' };
        if (['enabling', 'checking', 'reverting'].includes(it.devhub?.live?.state)) it.devhub.live = { state: 'unknown', note: 'Server dừng giữa chừng: xem DevHub trước khi làm lại' };
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
    if (old?.state === 'done' || old?.state === 'skipped') hooks.reopened?.(task.key);
    const item = {
      key: task.key, title: task.title, app: task.app, priority: task.priority, due: task.due, reporter: task.reporter,
      source, state: 'pending', createdAt: now(), updatedAt: now(),
      analysis: null, report: '', sessionId: null, costUsd: null, error: null, startedAt: null, finishedAt: null,
      comment: null, devhub: null, bossStatus: null, auto,
    };
    items.set(task.key, item);
    changed(item);
    if (auto) approve(task.key, { auto: true });
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

  // the read-only session cannot run mkdir itself
  const prepareLogs = (key) => logsDir
    ? Promise.all(['img', 'sentry', 'store'].map((k) => mkdir(join(logsDir, k, key), { recursive: true }))).catch(() => {})
    : Promise.resolve();

  // Question tasks: a fresh read-only session re-checks every drafted answer before you see it.
  // Corrected answers and the rewritten comment replace the draft; a failed check keeps the draft and says so.
  async function verifyAnswers(it, data, signal) {
    it.verify = { state: 'running', startedAt: now() };
    changed(it);
    try {
      const r = await runner.run({ prompt: verifyPrompt(it.key, data), profile: 'analyze', appendSystem: VERIFY_RULES, signal });
      const { data: v } = extractJson(r.text);
      if (!Array.isArray(v?.questions) || !v.questions.length) throw new Error('Không đọc được kết quả kiểm chứng');
      const count = (k) => v.questions.filter((q) => q.verdict === k).length;
      data.questions = v.questions.map((q) => ({ ...q, verified: q.verdict !== 'unsure' }));
      if (typeof v.comment === 'string' && v.comment.trim()) data.comment = v.comment;
      it.verify = { state: 'done', confirmed: count('confirmed'), corrected: count('corrected'), unsure: count('unsure'),
        missed: Array.isArray(v.missed) ? v.missed : [], costUsd: r.costUsd ?? null, at: now() };
    } catch (err) {
      if (signal?.aborted) throw err;
      it.verify = { state: 'failed', error: err.message, at: now() };
    }
  }

  async function analyze(it) {
    const ac = new AbortController();
    running.set(it.key, ac);
    Object.assign(it, { state: 'analyzing', startedAt: now(), error: null, verify: null });
    changed(it);
    post({ title: 'Bắt đầu phân tích', detail: it.title, task: it.key, app: it.app });
    try {
      await prepareLogs(it.key);
      // task, comments, Crisp and images read once here, as text: fewer turns and no HTML for Claude to re-read
      const d = await loadTask({ client, key: it.key, imgDir: logsDir ? join(logsDir, 'img', it.key) : null }).catch(() => null);
      const images = d?.images ?? [];
      it.images = { saved: images.filter((x) => x.file).length, failed: images.filter((x) => !x.file).length };
      it.prefetch = d?.task ? { comments: d.comments?.length ?? null, crisp: d.crisp?.length ?? null } : null;
      const rules = analyzeRules({ title: d?.task?.title ?? it.title, description: d?.task?.description });
      const r = await runner.run({ prompt: `/analyze-boss-task ${it.key}`, profile: 'analyze', appendSystem: rules + taskDataNote(d) + imagesNote(images) + (hooks.context?.(it, { text: d?.task?.description ?? '', type: guessType(d?.task?.title ?? it.title, d?.task?.description) }) ?? ''), signal: ac.signal });
      it.denials = r.denials ?? [];
      const { data, report } = extractJson(r.text);
      if (data?.questions?.length) await verifyAnswers(it, data, ac.signal);
      Object.assign(it, {
        state: 'review', analysis: data, report, sessionId: r.sessionId, costUsd: r.costUsd == null && it.verify?.costUsd == null ? null : (r.costUsd ?? 0) + (it.verify?.costUsd ?? 0), finishedAt: now(),
        error: data ? null : 'Không đọc được khối JSON cuối báo cáo: xem báo cáo đầy đủ',
        comment: { state: 'draft', text: data?.comment ?? '' },
        devhub: data?.devhub?.code ? { state: 'proposed' } : null,
      });
      post({ level: 'attention', type: 'review', title: 'Phân tích xong, chờ bạn duyệt', detail: data?.summary ?? it.title, task: it.key, app: it.app });
      autoTrial(it);
    } catch (err) {
      Object.assign(it, { state: 'failed', error: err.message, finishedAt: now() });
      post({ level: 'attention', title: 'Phân tích lỗi', detail: err.message, task: it.key, app: it.app });
    } finally {
      running.delete(it.key);
      changed(it);
      pump();
    }
  }

  // Your approval: first move the task Todo → In Progress on BOSS, then queue /analyze-boss-task.
  // A task started on its own (autoAnalyze) is analyzed straight away and its BOSS status is left as is.
  function approve(key, { auto = false } = {}) {
    const it = need(key, 'pending', 'failed');
    Object.assign(it, { state: 'queued', error: null, note: null, auto });
    changed(it);
    startAfterStatus(it);
    return it;
  }

  async function startAfterStatus(it) {
    if (!it.auto && !['moved', 'kept'].includes(it.bossStatus?.state)) {
      it.bossStatus = { state: 'moving' };
      changed(it);
      it.bossStatus = await moveToInProgress(it.key);
      if (it.bossStatus.state === 'moved') post({ title: 'Đã chuyển task sang In Progress', task: it.key, app: it.app });
      if (it.state !== 'queued') return changed(it); // cancelled meanwhile
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

  function skip(key, reason) {
    const it = need(key, 'pending', 'failed', 'review');
    asks.get(key)?.abort();
    it.state = 'skipped';
    it.skipReason = reason ?? null;
    changed(it);
    hooks.finished?.(it, { reason: it.skipReason });
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
    asks.get(key)?.abort();
    it.state = 'done';
    changed(it);
    hooks.finished?.(it, {});
    return it;
  }

  // Second approval: post exactly the text you approved.
  // Checks run before returning; the posting itself continues in the background (done: the returned promise).
  // When the analysis proposed DevHub code, the same approval also appends it to DevHub (code: your edited version).
  function approveComment(key, text, code) {
    const it = need(key, 'review');
    if (['posting', 'posted'].includes(it.comment?.state)) throw Object.assign(new Error('Comment đã gửi hoặc đang gửi'), { status: 409 });
    const body = String(text ?? '').trim();
    if (!body) throw Object.assign(new Error('Comment trống'), { status: 400 });
    const html = commentHtml(body);
    it.comment = { state: 'posting', text: body, html };
    changed(it);
    const jobs = [postComment(it, key, html)];
    if (it.analysis?.devhub?.code && ['proposed', 'failed'].includes(it.devhub?.state ?? 'proposed')) jobs.push(approveDevhub(key, code).done);
    return { item: it, done: Promise.all(jobs).then(() => it) };
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

  // Append the proposed code to DevHub, commented out (CHỜ XÁC NHẬN); the existing code is kept as is.
  function approveDevhub(key, code) {
    const it = need(key, 'review');
    if (!it.analysis?.devhub) throw Object.assign(new Error('Phân tích không đề xuất code DevHub'), { status: 400 });
    if (['running', 'written'].includes(it.devhub?.state)) throw Object.assign(new Error('DevHub đã ghi hoặc đang ghi'), { status: 409 });
    if (typeof code === 'string' && code.trim()) it.analysis.devhub.code = code;
    it.devhub = { state: 'running', startedAt: now() };
    changed(it);
    return { item: it, done: writeDevhub(it, key) };
  }

  // Why DevHub must not be written for this task, or null.
  async function devhubBlocker(it) {
    const app = APP_HANDLES[it.app] ? it.app : it.analysis?.app;
    const domain = String(it.analysis?.store ?? '').trim().toLowerCase();
    if (!APP_HANDLES[app]) return { reason: 'Không rõ task thuộc app nào' };
    if (!devhubApps.includes(app)) return { reason: `Chưa bật ghi DevHub cho ${app}: chưa xác minh lưu DevHub của app này không ghi vào theme khách (DEVHUB_APPS)` };
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) return { reason: 'Phân tích không có domain .myshopify.com của store' };
    if (app === 'Lock') {
      const v = await probeStore(domain).catch(() => 'unknown');
      if (v === 'legacy') return { reason: 'Store dùng Lock bản cũ: lưu DevHub sẽ làm app ghi snippet vào theme khách' };
      if (v !== 'v2') return { reason: 'Không xác định được Lock bản v2 (storefront không mở được hoặc có mật khẩu)' };
    }
    return { app, domain };
  }

  async function writeDevhub(it, key) {
    try {
      const gate = await devhubBlocker(it);
      if (gate.reason) {
        it.devhub = { state: 'skipped', detail: gate.reason, at: now() };
        post({ level: 'attention', title: 'Không ghi DevHub', detail: gate.reason, task: key, app: it.app });
        return it;
      }
      const block = devhubBlock(key, it.analysis.devhub.purpose, it.analysis.devhub.code, today());
      post({ title: 'Đang thêm code vào DevHub (dạng comment)', detail: gate.domain, task: key, app: it.app });
      const r = await runner.run({ prompt: devhubPrompt({ key, appHandle: APP_HANDLES[gate.app], domain: gate.domain, block }), profile: 'devhub' });
      const { data, report } = extractJson(r.text);
      let state = ['written', 'skipped'].includes(data?.status) ? data.status : 'failed';
      let detail = data?.detail ?? '';
      if (state === 'written' && data.verified !== true) {
        state = 'unknown';
        detail = `Đã lưu nhưng không xác nhận được code cũ còn nguyên: xem DevHub${data.previousVersion != null ? `, khôi phục được version ${data.previousVersion}` : ''}. ${detail}`;
      }
      it.devhub = { state, detail, block, domain: gate.domain, previousVersion: data?.previousVersion ?? null, version: data?.version ?? null, report, at: now() };
      post({ level: state === 'written' ? 'info' : 'attention', title: state === 'written' ? 'Đã thêm code DevHub, chờ xác nhận bỏ comment' : 'Không ghi DevHub', detail, task: key, app: it.app });
      if (state === 'written' && it.trial?.code !== blockCode(block)) autoTrial(it); // you edited the code: try what DevHub now holds
    } catch (err) {
      it.devhub = { state: 'failed', error: err.message, at: now() };
      post({ level: 'attention', title: 'Ghi DevHub lỗi', detail: err.message, task: key, app: it.app });
    } finally {
      changed(it);
    }
    return it;
  }

  // ---- try the fix on the storefront (nothing saved), then enable it for real ----
  const storeOf = (it) => {
    const d = String(it.analysis?.store ?? it.devhub?.domain ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d) ? d : null;
  };
  const shotDir = (key) => join(logsDir ?? join(tmpdir(), 'support-agent-trials'), 'store', key);
  const pageUrl = (domain, path) => {
    const p = String(path ?? '/').trim() || '/';
    if (!p.startsWith('/') || p.startsWith('//')) throw Object.assign(new Error('Đường dẫn phải bắt đầu bằng / (chỉ path, không có domain)'), { status: 400 });
    return `https://${domain}${p}`;
  };
  // the code that would run: what DevHub holds once written, otherwise the proposal
  const norm = (code) => blockCode(devhubBlock('K', '', code, ''));
  const codeToRun = (it) => (it.devhub?.block ? blockCode(it.devhub.block) : norm(it.analysis?.devhub?.code ?? ''));

  function autoTrial(it) {
    if (it.state !== 'review' || !it.analysis?.devhub?.code || !it.analysis.devhub.test?.check || !storeOf(it)) return;
    try {
      tryFix(it.key, {});
    } catch {
      // a manual try will show the reason
    }
  }

  // edits: {code, path, check, ready} from the card; code only while DevHub is not written yet
  function tryFix(key, edits = {}) {
    const it = need(key, 'review');
    const dh = it.analysis?.devhub;
    if (!dh) throw Object.assign(new Error('Phân tích không đề xuất code DevHub'), { status: 400 });
    if (it.trial?.state === 'running') throw Object.assign(new Error('Đang thử'), { status: 409 });
    const domain = storeOf(it);
    if (!domain) throw Object.assign(new Error('Phân tích không có domain .myshopify.com của store'), { status: 400 });
    if (typeof edits.code === 'string' && edits.code.trim() && !it.devhub?.block) dh.code = edits.code;
    const test = { ...(dh.test ?? {}) };
    for (const f of ['path', 'check', 'ready']) if (typeof edits[f] === 'string') test[f] = edits[f].trim() || null;
    if (!test.check) throw Object.assign(new Error('Chưa có biểu thức kiểm tra (true = hết lỗi)'), { status: 400 });
    const url = pageUrl(domain, test.path);
    dh.test = test;
    const code = codeToRun(it);
    it.trial = { state: 'running', url, code, startedAt: now() };
    changed(it);
    const done = (async () => {
      try {
        // Solution prints DevHub code inside script#bss-b2b-customize before the app starts (installation hooks
        // must be there), so the code is tried at that spot; other apps: run after the page loads
        const injectAt = (APP_HANDLES[it.app] ? it.app : it.analysis?.app) === 'Solution' ? 'hook' : 'after';
        const r = await trial({ url, code, check: test.check, ready: test.ready, dir: shotDir(key), chromeBin, injectAt });
        const brief = (x) => x && { check: x.check, checkError: x.checkError, errors: x.errors.length, blocked: x.blocked, finalUrl: x.finalUrl };
        it.trial = { state: r.verdict, note: r.note, url, code, before: brief(r.before), after: brief(r.after), beforeErrors: r.before?.errors ?? [],
          newErrors: r.newErrors ?? [], at: now(), shots: ['trial-before.png', r.after ? 'trial-after.png' : null].filter(Boolean) };
        post({ level: r.verdict === 'passed' ? 'info' : 'attention', title: r.verdict === 'passed' ? 'Thử fix trên store: hết lỗi' : 'Thử fix trên store: chưa đạt', detail: r.note, task: key, app: it.app });
      } catch (err) {
        it.trial = { state: 'unknown', note: `Không thử được: ${err.message}`, url, code, at: now() };
      }
      changed(it);
      return it;
    })();
    return { item: it, done };
  }

  // Your confirmation: uncomment exactly this task's block in DevHub, check the live store, put the comment back if it breaks the page.
  function enableDevhub(key, { force = false } = {}) {
    const it = need(key, 'review');
    const d = it.devhub;
    if (d?.state !== 'written' || !d.block) throw Object.assign(new Error('Code chưa được thêm vào DevHub'), { status: 409 });
    if (['enabling', 'checking', 'reverting', 'live'].includes(d.live?.state)) throw Object.assign(new Error('Code đã bật hoặc đang bật'), { status: 409 });
    const tried = it.trial?.state === 'passed' && it.trial.code === blockCode(d.block);
    if (!tried && !force) throw Object.assign(new Error('Chưa thử fix thành công với đúng code trong DevHub'), { status: 409 });
    d.live = { state: 'enabling', tried, startedAt: now() };
    changed(it);
    return { item: it, done: goLive(it, key) };
  }

  async function swapBlock(it, key, gate, from, to, why) {
    const r = await runner.run({ prompt: devhubReplacePrompt({ key, appHandle: APP_HANDLES[gate.app], domain: gate.domain, from, to, why }), profile: 'devhub' });
    const { data } = extractJson(r.text);
    if (data?.status !== 'done') throw new Error(data?.detail || `DevHub: ${data?.status ?? 'không rõ kết quả'}`);
    if (data.verified !== true) throw Object.assign(new Error(`Đã lưu nhưng không xác nhận được phần còn lại giữ nguyên: xem DevHub${data.previousVersion != null ? `, restore được version ${data.previousVersion}` : ''}`), { unverified: true });
    return data;
  }

  async function goLive(it, key) {
    const d = it.devhub;
    try {
      const gate = await devhubBlocker(it);
      if (gate.reason) {
        d.live = { state: 'failed', note: gate.reason, at: now() };
        return it;
      }
      const on = enableBlock(d.block, today());
      const saved = await swapBlock(it, key, gate, d.block, on, 'bật code (bỏ comment block CHỜ XÁC NHẬN)');
      d.live = { ...d.live, state: 'checking', enabledBlock: on, previousVersion: saved.previousVersion ?? null, version: saved.version ?? null };
      changed(it);
      post({ title: 'Đã bật code DevHub, đang kiểm tra store thật', task: key, app: it.app });
      const test = it.analysis?.devhub?.test;
      if (!test?.check) {
        d.live = { ...d.live, state: 'live-unverified', note: 'Không có biểu thức kiểm tra: tự xem lại store', at: now() };
        return it;
      }
      // DevHub reaches the storefront through app metafields/CDN: allow a short delay
      const known = new Set(it.trial?.beforeErrors ?? []);
      let last = null;
      for (const wait of liveDelays) {
        await new Promise((r) => setTimeout(r, wait));
        last = await probe({ url: pageUrl(gate.domain, test.path), check: test.check, ready: test.ready, chromeBin, shotPath: join(shotDir(key), 'live.png') });
        if (last.check === true) break;
      }
      const fresh = [...new Set((last?.errors ?? []).filter((e) => !known.has(e)))];
      if (last?.check === true && !fresh.length) {
        d.live = { ...d.live, state: 'live', note: 'Store thật: hết lỗi, không có lỗi console mới', newErrors: [], at: now(), shot: 'live.png' };
        post({ title: 'Code DevHub đã chạy trên store, hết lỗi', task: key, app: it.app });
      } else if (fresh.length) {
        // the page breaks with the code: comment the block back right away (autofix-boss 3B-xác nhận step 3)
        d.live = { ...d.live, state: 'reverting', newErrors: fresh, shot: 'live.png' };
        changed(it);
        await swapBlock(it, key, gate, on, d.block, 'comment lại block vì gây lỗi trên store');
        d.live = { ...d.live, state: 'reverted', note: `Code gây ${fresh.length} lỗi console mới trên store thật: đã comment lại block`, at: now() };
        post({ level: 'attention', title: 'Đã tắt lại code DevHub vì gây lỗi', detail: fresh[0], task: key, app: it.app });
      } else {
        d.live = { ...d.live, state: 'live-unverified', note: `Đã bật, nhưng sau ${liveDelays.length} lần kiểm tra store vẫn chưa thấy hết lỗi (có thể cache): xem lại`, newErrors: [], at: now(), shot: last ? 'live.png' : null };
        post({ level: 'attention', title: 'Đã bật code DevHub nhưng chưa thấy hết lỗi', task: key, app: it.app });
      }
    } catch (err) {
      d.live = { ...d.live, state: err.unverified ? 'unknown' : 'failed', note: err.message, at: now() };
      post({ level: 'attention', title: 'Bật code DevHub lỗi', detail: err.message, task: key, app: it.app });
    } finally {
      changed(it);
    }
    return it;
  }

  // Chat on a review card: your question goes to the same analysis session (read only).
  // A reply that changes the conclusion carries a new json block, which replaces the analysis
  // and the drafts that are not sent yet. Checks run before returning; done: the reply.
  const asks = new Map(); // key → AbortController
  function ask(key, text) {
    const it = need(key, 'review');
    const q = String(text ?? '').trim();
    if (!q) throw Object.assign(new Error('Câu hỏi trống'), { status: 400 });
    if (it.asking) throw Object.assign(new Error('Claude đang trả lời câu trước'), { status: 409 });
    if (!it.sessionId) throw Object.assign(new Error('Không có phiên phân tích để hỏi tiếp'), { status: 400 });
    it.chat = [...(it.chat ?? []), { role: 'user', text: q, at: now() }];
    it.asking = true;
    changed(it);
    return { item: it, done: reply(it, q) };
  }

  async function reply(it, q) {
    const ac = new AbortController();
    asks.set(it.key, ac);
    try {
      await prepareLogs(it.key);
      const r = await runner.run({ prompt: q, profile: 'analyze', appendSystem: askRules({ title: it.title }), resume: it.sessionId, signal: ac.signal });
      const { data, report } = extractJson(r.text);
      if (r.sessionId) it.sessionId = r.sessionId;
      const msg = { role: 'assistant', text: report, at: now(), costUsd: r.costUsd ?? null, updated: [], denials: r.denials ?? [] };
      if (data && typeof data === 'object') {
        const old = it.analysis ?? {};
        it.analysis = { ...old, ...data };
        for (const f of ['summary', 'rootCause', 'solution', 'comment', 'checks']) if (data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(old[f])) msg.updated.push(f);
        if (data.comment && !['posting', 'posted'].includes(it.comment?.state)) it.comment = { state: 'draft', text: data.comment };
        if (data.devhub !== undefined && !['running', 'written'].includes(it.devhub?.state)) {
          if (JSON.stringify(data.devhub) !== JSON.stringify(old.devhub ?? null)) msg.updated.push('devhub');
          it.devhub = data.devhub?.code ? { state: 'proposed' } : null;
          if (msg.updated.includes('devhub')) {
            it.trial = null;
            queueMicrotask(() => autoTrial(it));
          }
        }
        it.error = null;
      }
      it.costUsd = (it.costUsd ?? 0) + (r.costUsd ?? 0);
      it.chat.push(msg);
      post({ level: 'attention', title: msg.updated.length ? 'Claude đã cập nhật kết quả phân tích' : 'Claude đã trả lời', detail: report.slice(0, 160), task: it.key, app: it.app });
    } catch (err) {
      it.chat.push({ role: 'error', text: err.message, at: now() });
    } finally {
      asks.delete(it.key);
      it.asking = false;
      changed(it);
    }
    return it;
  }

  function stopAsk(key) {
    const it = need(key);
    asks.get(key)?.abort();
    return it;
  }

  const setAutoAnalyze = (on) => (auto = Boolean(on));
  const autoAnalyzeOn = () => auto;
  return { setAutoAnalyze, autoAnalyzeOn, load, list, offer, approve, skip, cancel, finish, approveComment, approveDevhub, tryFix, enableDevhub, ask, stopAsk, shotDir, get: (k) => items.get(k) };
}

// Lock bản cũ in <script id="bss-ltap-hide-price"> từ snippet theme (b2b-login-access-management-api theme.service.ts).
export async function probeLockStore(domain, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${domain}/`, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok || /\/password/.test(new URL(res.url || `https://${domain}/`).pathname)) return 'unknown';
  const html = await res.text();
  if (html.includes('bss-ltap-hide-price')) return 'legacy';
  return /Shopify\.shop|cdn\.shopify\.com/.test(html) ? 'v2' : 'unknown';
}
