// Browser side: one EventSource per machine (this one + PEERS), merged into one view.

import { createOffice } from './office.js';

const BOSS_URL = 'https://boss.bss-b2b.solutions/tasks/';
const STATUS_CLASS = { Todo: 'st-todo', 'In Progress': 'st-progress', Research: 'st-research', 'CS Review': 'st-review', Resolved: 'st-done', Cancel: 'st-cancel' };
const SESSION_LABEL = { waiting: 'Chờ bạn duyệt', working: 'Đang làm', idle: 'Đang nghỉ', ended: 'Đã đóng' };

// origin ('' = this page's server) → {origin, machine, connected, boss, sessions: Map, feed: []}
const sources = new Map();
const ui = { q: '', feedFilter: 'all', notify: false, view: 'office' };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const ictToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}p`);
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  return `${Math.floor(s / 86400)} ngày`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

function taskLink(key, cls = 'tag') {
  const a = el('a', cls, key);
  a.href = BOSS_URL + encodeURIComponent(key);
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}
const chip = (status) => el('span', `chip ${STATUS_CLASS[status] ?? ''}`, status);

// ---------- merged views ----------
// Every machine polls BOSS; show the freshest successful copy.
function bossSource() {
  const all = [...sources.values()].filter((s) => s.boss);
  const ok = all.filter((s) => s.boss.ok).sort((a, b) => String(b.boss.lastPoll).localeCompare(String(a.boss.lastPoll)));
  return ok[0] ?? all[0] ?? null;
}
const boss = () => bossSource()?.boss ?? null;
const multi = () => sources.size > 1;

function allSessions() {
  const out = [];
  for (const src of sources.values()) {
    for (const s of src.sessions.values()) out.push({ ...s, key: `${src.origin}|${s.id}`, machine: multi() ? src.machine : '' });
  }
  return out;
}

function allFeed() {
  const bs = bossSource();
  const out = [];
  for (const src of sources.values()) {
    for (const i of src.feed) {
      if (i.kind === 'boss' && src !== bs) continue;
      out.push({ ...i, key: `${src.origin}|${i.id}`, machine: multi() ? src.machine : '' });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------- header ----------
function renderHeader() {
  const b = boss();
  const pill = $('#boss-pill');
  pill.className = 'pill' + (b?.ok ? ' ok' : b?.error ? ' err' : '');
  $('#boss-text').textContent = b?.ok ? `BOSS · cập nhật ${clock(b.lastPoll)}${b.cut ? ' · bị cắt bớt' : ''}` : b?.error ?? 'Đang kết nối…';
  pill.title = b?.error ?? '';
  const w = b?.worklog;
  $('#st-today').textContent = w ? hm(w.todayMin) : '—';
  $('#st-week').textContent = w ? hm(w.weekMin) : '—';
  $('#st-tasks').textContent = w ? String(w.taskCount) : '—';

  const box = $('#machines');
  box.replaceChildren();
  for (const src of sources.values()) {
    const p = el('span', 'pill' + (src.connected ? ' ok' : ' err'));
    p.append(el('span', 'dot'), el('span', '', `${src.machine ?? src.origin}${src.connected ? '' : ' · offline'}`));
    p.title = src.origin || location.origin;
    box.append(p);
  }
}

// ---------- sessions ----------
function sessionsByTask() {
  const m = new Map();
  for (const s of allSessions()) if (s.task && s.status !== 'ended') m.set(s.task, s);
  return m;
}

function renderSessions() {
  const all = allSessions();
  const by = (st) => all.filter((s) => s.status === st).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = [['waiting', 'Cần bạn duyệt'], ['working', 'Đang làm'], ['idle', 'Đang nghỉ'], ['ended', 'Đã đóng']];
  const waiting = by('waiting').length;
  $('#n-wait').textContent = waiting;
  $('#n-work').textContent = by('working').length;
  $('#n-idle').textContent = by('idle').length;
  $('#sess-summary').textContent = all.length ? `${all.length} phiên đang theo dõi` : 'Chưa có phiên nào gửi sự kiện.';
  $('#sess-hint').hidden = all.length > 0;
  updateTitle(waiting);

  const list = $('#sess-list');
  list.replaceChildren();
  for (const [st, label] of groups) {
    const items = by(st);
    if (!items.length) continue;
    list.append(el('p', 'sess-group', `${label} · ${items.length}`));
    for (const s of items) {
      const card = el('div', `sess ${s.status}`);
      const top = el('div', 'sess-top');
      top.append(el('span', `dot ${s.status}`), el('span', 'sess-name', s.project), el('span', 'sess-time', ago(s.updatedAt)));
      top.title = s.cwd;
      card.append(top);
      const tags = el('div', 'sess-task');
      if (s.machine) tags.append(el('span', 'tag', s.machine));
      if (s.task) tags.append(taskLink(s.task));
      if (s.skill) tags.append(el('span', 'tag', '/' + s.skill));
      if (s.subagents > 0) tags.append(el('span', 'tag', `${s.subagents} trợ lý`));
      if (tags.childElementCount) card.append(tags);
      const line = s.status === 'waiting' ? `Chờ duyệt: ${s.waitingFor}` : s.lastAction || s.prompt || SESSION_LABEL[s.status];
      card.append(el('div', 'sess-action', line));
      list.append(card);
    }
  }
}

// ---------- desks (list view) ----------
function renderDesks() {
  const tasks = boss()?.tasks ?? [];
  const today = ictToday();
  const q = ui.q.trim().toLowerCase();
  const claude = sessionsByTask();
  const rank = (t) => (claude.has(t.key) ? 0 : t.priority === 'Urgent' ? 1 : 2);

  for (const desk of document.querySelectorAll('.desk')) {
    const app = desk.dataset.app;
    const mine = tasks.filter((t) => t.app === app);
    $('.desk-n', desk).textContent = mine.length;
    const urgent = mine.filter((t) => t.priority === 'Urgent').length;
    $('.desk-urgent', desk).textContent = urgent ? `${urgent} urgent` : '';

    const shown = mine
      .filter((t) => !q || `${t.key} ${t.title} ${t.assignee}`.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (a.due || '9999').localeCompare(b.due || '9999'));

    const list = $('.desk-list', desk);
    list.replaceChildren();
    if (!shown.length) list.append(el('div', 'empty', boss()?.ok ? (ui.q ? 'Không có task Todo nào khớp.' : 'Không có task Todo.') : 'Chưa có dữ liệu BOSS.'));
    for (const t of shown) {
      const s = claude.get(t.key);
      const card = el('div', 'card' + (s ? ' has-claude' : '') + (s?.status === 'waiting' ? ' claude-waiting' : ''));
      const top = el('div', 'card-top');
      top.append(taskLink(t.key), chip(t.status));
      if (t.priority === 'Urgent') top.append(el('span', 'urgent-tag', 'Urgent'));
      card.append(top, el('div', 'card-title', t.title));
      const meta = el('div', 'card-meta');
      if (t.assignee) meta.append(el('span', '', t.assignee));
      if (t.due) meta.append(el('span', t.due < today ? 'overdue' : '', `hạn ${t.due}`));
      card.append(meta);
      if (s) card.append(el('div', 'claude-badge', `Claude · ${s.project}${s.machine ? ' · ' + s.machine : ''} · ${SESSION_LABEL[s.status]}`));
      list.append(card);
    }
  }
}

// ---------- my worklog ----------
function renderMine() {
  const w = boss()?.worklog;
  const rows = $('#mine-rows');
  rows.replaceChildren();
  $('#mine-note').textContent = w ? `${w.taskCount} task, ${hm(w.totalMin)} trong khoảng đã tải` : '';
  for (const t of w?.recent ?? []) {
    const tr = el('tr');
    const key = el('td', 'nowrap');
    key.append(taskLink(t.key));
    const st = el('td', 'nowrap');
    st.append(chip(t.status));
    tr.append(key, el('td', '', t.title), st, el('td', 'num', String(t.minutes)), el('td', 'nowrap', t.last));
    rows.append(tr);
  }
}

// ---------- feed ----------
function renderFeed() {
  const f = ui.feedFilter;
  const feed = allFeed();
  const items = feed
    .filter((i) => f === 'all' || (f === 'attention' ? i.level === 'attention' : i.kind === f))
    .slice(-150)
    .reverse();
  const attn = feed.filter((i) => i.level === 'attention' && Date.now() - Date.parse(i.at) < 3600000).length;
  const badge = $('#n-attn');
  badge.hidden = attn === 0;
  badge.textContent = attn;

  const list = $('#feed-list');
  list.replaceChildren();
  for (const i of items) {
    const fresh = Date.now() - Date.parse(i.at) < 4000;
    const li = el('li', `item ${i.kind} ${i.level}` + (fresh ? ' fresh' : ''));
    const top = el('div', 'item-top');
    const who = i.kind === 'claude' ? (i.session?.project ?? 'Claude') + (i.machine ? ` · ${i.machine}` : '') : i.app ? `BOSS · ${i.app}` : 'BOSS';
    top.append(el('span', 'item-src', who));
    if (i.task) top.append(taskLink(i.task));
    top.append(el('span', 'item-time', clock(i.at)));
    li.append(top, el('div', 'item-title', i.title));
    if (i.detail) li.append(el('div', 'item-detail', i.detail));
    list.append(li);
  }
}

// ---------- office ----------
const popover = $('#popover');
let popKey = null;

function showPopover(s, at) {
  popKey = s?.key ?? null;
  if (!s) {
    popover.hidden = true;
    return;
  }
  popover.replaceChildren();
  const head = el('div', 'pop-head');
  const close = el('button', 'pop-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Đóng');
  close.addEventListener('click', () => {
    showPopover(null);
    office.deselect();
  });
  head.append(el('span', `dot ${s.status}`), el('span', 'pop-name', s.project), close);
  popover.append(head);
  const row = (label, value) => {
    if (!value) return;
    const r = el('div', 'pop-row', label + ': ');
    if (value instanceof Node) r.append(value);
    else r.append(el('b', '', value));
    popover.append(r);
  };
  row('Trạng thái', SESSION_LABEL[s.status]);
  row('Máy', s.machine);
  row('Task', s.task ? taskLink(s.task) : null);
  row('Skill', s.skill ? '/' + s.skill : null);
  row(s.status === 'waiting' ? 'Chờ duyệt' : 'Việc gần nhất', s.status === 'waiting' ? s.waitingFor : s.lastAction);
  row('Yêu cầu', s.prompt);
  row('Thư mục', s.cwd);
  row('Cập nhật', ago(s.updatedAt) + ' trước');
  if (s.agent) {
    const go = el('button', 'pop-go', 'Xem trong hàng đợi');
    go.type = 'button';
    go.addEventListener('click', () => document.getElementById(`appr-${s.task}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    popover.append(go);
  }
  popover.hidden = false;
  const wrap = popover.parentElement.getBoundingClientRect();
  const w = popover.offsetWidth;
  const h = popover.offsetHeight;
  popover.style.left = Math.max(8, Math.min(at.x + 12, wrap.width - w - 8)) + 'px';
  popover.style.top = Math.max(8, Math.min(at.y - h / 2, wrap.height - h - 8)) + 'px';
}

const office = createOffice($('#office'), {
  onSelect: (s, at) => showPopover(s, at),
  onView: ({ zoom }) => ($('#oz-level').textContent = `${Math.round(zoom * 100)}%`),
});
$('#oz-fit').addEventListener('click', () => office.fit());
$('#oz-in').addEventListener('click', () => office.zoomBy(1.25));
$('#oz-out').addEventListener('click', () => office.zoomBy(0.8));
$('#oz-shot').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = office.snapshot();
  a.download = `phong-support-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  a.click();
});

// One agent per approval-queue task on this machine, in the room of the task's app; it leaves when the task is done or skipped.
const APP_ROOMS = ['Solution', 'Quote', 'Lock'];
function pipelineAgents() {
  const agents = [];
  for (const it of localPipeline()) {
    if (['done', 'skipped'].includes(it.state)) continue;
    let status = 'working';
    let lastAction = '';
    let waitingFor = '';
    if (it.state === 'pending') [status, waitingFor] = ['waiting', it.note ? 'task không còn Todo, duyệt để phân tích' : 'duyệt phân tích'];
    else if (it.state === 'queued') lastAction = it.bossStatus?.state === 'moving' ? 'Chuyển status sang In Progress' : 'Chờ lượt phân tích';
    else if (it.state === 'analyzing') lastAction = it.verify?.state === 'running' ? 'Đang kiểm chứng từng câu trả lời' : 'Đang chạy /analyze-boss-task';
    else if (it.state === 'failed') [status, waitingFor] = ['waiting', `lỗi: ${it.error ?? ''}`];
    else if (it.comment?.state === 'posting') lastAction = 'Đang comment lên task';
    else if (it.devhub?.state === 'running') lastAction = 'Đang ghi DevHub';
    else if (it.asking) lastAction = 'Đang kiểm tra lại theo câu hỏi của bạn';
    else if (it.trial?.state === 'running') lastAction = 'Đang thử fix trên store (không lưu gì)';
    else if (['enabling', 'checking', 'reverting'].includes(it.devhub?.live?.state)) lastAction = 'Đang bật code DevHub và kiểm tra store';
    else [status, waitingFor] = ['waiting', 'duyệt solution'];
    const app = APP_ROOMS.includes(it.app) ? it.app : APP_ROOMS.includes(it.analysis?.app) ? it.analysis.app : 'Chung';
    agents.push({
      id: `agent-${it.key}`, key: `agent|${it.key}`, agent: true, project: `Agent #${it.key.split('-').pop()}`, task: it.key, app,
      status, lastAction, waitingFor, prompt: it.title, skill: 'analyze-boss-task', cwd: '', machine: '', subagents: 0, updatedAt: it.updatedAt,
    });
  }
  return agents;
}

function renderOffice() {
  const agents = pipelineAgents();
  const byTask = new Map(agents.map((a) => [a.task, a]));
  // a Claude session reporting through hooks for the same task is that agent: show its live action, not a second person
  const sessions = [];
  for (const s of allSessions()) {
    const a = byTask.get(s.task);
    if (a && s.status !== 'ended') {
      if (a.status === 'working' && s.lastAction) a.lastAction = s.lastAction;
    } else sessions.push(s);
  }
  office.update({ sessions: [...sessions, ...agents], tasks: boss()?.tasks ?? [] });
  if (popKey) {
    const s = allSessions().find((x) => x.key === popKey);
    if (!s && !pipelineAgents().some((x) => x.key === popKey)) showPopover(null);
    else if (s?.status === 'ended') showPopover(null);
  }
}

function renderAll() {
  renderHeader();
  renderSessions();
  renderDesks();
  renderMine();
  renderAssigned();
  renderApprovals();
  renderLearn(true);
  renderFeed();
  renderOffice();
}

// ---------- assigned to me ----------
function renderAssigned() {
  const b = boss();
  const rows = $('#assigned-rows');
  rows.replaceChildren();
  const list = b?.assigned ?? [];
  $('#assigned-panel').hidden = !b?.assignee;
  $('#assigned-note').textContent = b?.assignedError ? `Lỗi: ${b.assignedError}` : `${list.length} task chưa xong · kiểm tra mỗi ${b.assignedEvery ?? 30} giây`;
  if (!list.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'Không có task nào đang giao cho bạn.');
    td.colSpan = 6;
    tr.append(td);
    rows.append(tr);
  }
  const today = ictToday();
  for (const t of list) {
    const tr = el('tr');
    const key = el('td', 'nowrap');
    key.append(taskLink(t.key));
    const st = el('td', 'nowrap');
    st.append(chip(t.status));
    const due = el('td', 'nowrap' + (t.due && t.due < today ? ' overdue' : ''), t.due || '');
    const q = el('td', 'nowrap');
    const inQueue = localPipeline().some((i) => i.key === t.key && !['skipped', 'done'].includes(i.state));
    if (t.status === 'Todo' && !inQueue) q.append(btn('Đưa vào hàng đợi', 'small', () => act('/add', { key: t.key })));
    tr.append(key, el('td', '', t.title), el('td', 'nowrap', t.app), st, due, q);
    rows.append(tr);
  }
}

// ---------- approval queue (this machine only: approving runs Claude here) ----------
const APPR_STATE = {
  pending: 'Chờ bạn duyệt phân tích',
  queued: 'Đã duyệt · đang xếp lượt',
  analyzing: 'Claude đang phân tích',
  review: 'Chờ bạn duyệt solution',
  failed: 'Lỗi',
  skipped: 'Đã bỏ qua',
  done: 'Đã xong',
};
const COMMENT_STATE = { posting: 'Đang gửi comment…', posted: 'Đã comment lên task', failed: 'Gửi comment lỗi', unknown: 'Không rõ đã gửi chưa' };
const DEVHUB_STATE = { running: 'Đang thêm code vào DevHub…', written: 'Đã thêm vào DevHub (code cũ giữ nguyên, block mới đang comment, chờ xác nhận)', skipped: 'Không ghi DevHub', failed: 'Ghi DevHub lỗi', unknown: 'Cần kiểm tra lại DevHub' };
// The comment must have exactly the 4 sections of the team template, in order (lib/claude.mjs COMMENT_SECTIONS).
const SECTIONS = ['Root Cause', 'Solution', 'Technical Details', 'Result'];
function templateIssue(text) {
  const found = String(text).split(/\r?\n/).map((l) => l.trim().match(/^(Root Cause|Solution|Technical Details|Result)\s*:/i)?.[1])
    .filter(Boolean).map((x) => SECTIONS.find((s) => s.toLowerCase() === x.toLowerCase()));
  const missing = SECTIONS.filter((s) => !found.includes(s));
  if (missing.length) return `thiếu ${missing.join(', ')}`;
  if (found.length > SECTIONS.length) return 'có mục bị lặp';
  return found.join() === SECTIONS.join() ? '' : 'sai thứ tự mục';
}
const drafts = new Map(); // key → comment text you are editing
const codeDrafts = new Map();
const chatDrafts = new Map();
const CHAT_FIELDS = { checks: 'phần đã kiểm tra', summary: 'tóm tắt', rootCause: 'nguyên nhân', solution: 'solution', comment: 'bản nháp comment', devhub: 'code DevHub' };
const cardCache = new Map(); // key → {sig, node}
const localPipeline = () => sources.get('')?.pipeline ?? [];

async function act(path, body = {}) {
  try {
    const r = await fetch(`/api/pipeline${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alertLine(j.error || `Lỗi ${r.status}`);
      renderApprovals(true);
    }
  } catch (e) {
    alertLine(e.message);
    renderApprovals(true);
  }
}
function alertLine(msg) {
  const box = el('div', 'toast');
  box.append(el('div', 'toast-title', msg));
  $('#toasts').prepend(box);
  setTimeout(() => box.remove(), 6000);
}

function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    b.disabled = true;
    onClick();
  });
  return b;
}

function section(label, text) {
  if (!text) return null;
  const d = el('div', 'appr-sec');
  d.append(el('b', '', label + ': '), el('span', '', text));
  return d;
}

function approvalCard(it) {
  const card = el('div', `appr ${it.state}`);
  card.id = `appr-${it.key}`;
  const top = el('div', 'card-top');
  top.append(taskLink(it.key), el('span', `appr-state s-${it.state}`, APPR_STATE[it.state] ?? it.state));
  if (it.priority === 'Urgent') top.append(el('span', 'urgent-tag', 'Urgent'));
  if (it.app && it.app !== 'Khác') top.append(el('span', 'tag', it.app));
  card.append(top, el('div', 'card-title', it.title));
  const meta = [it.reporter && `từ ${it.reporter}`, it.due && `hạn ${it.due}`, `vào hàng đợi ${clock(it.createdAt)}`].filter(Boolean).join(' · ');
  card.append(el('div', 'card-meta', meta));
  const bs = it.bossStatus;
  if (bs?.state && bs.state !== 'unknown') {
    const text = {
      moving: 'Đang chuyển status trên BOSS sang In Progress…',
      moved: `BOSS: Todo → In Progress${bs.via === 'claude' ? ' (qua Claude)' : ''}`,
      kept: `BOSS: giữ nguyên status ${bs.from ?? ''} (không còn là Todo)`,
      failed: `Không chuyển được status: ${bs.error}`,
    }[bs.state];
    card.append(el('div', bs.state === 'failed' ? 'appr-err' : bs.state === 'moving' ? 'muted' : 'appr-ok', text));
  }
  const actions = el('div', 'appr-actions');

  if (it.state === 'pending') {
    if (it.note) card.append(el('div', 'muted', it.note));
    actions.append(btn('Duyệt: chuyển In Progress + chạy /analyze-boss-task', 'primary', () => act(`/${it.key}/approve`)), skipButton(it));
  } else if (it.state === 'queued' || it.state === 'analyzing') {
    if (it.startedAt) card.append(el('div', 'muted', `Bắt đầu ${clock(it.startedAt)} · thường mất 5–15 phút`));
    if (it.verify?.state === 'running') card.append(el('div', 'muted', 'Đã soạn câu trả lời, đang kiểm chứng lại từng câu bằng một phiên độc lập…'));
    actions.append(btn('Huỷ', '', () => act(`/${it.key}/cancel`)));
  } else if (it.state === 'failed') {
    card.append(el('div', 'appr-err', it.error ?? 'Lỗi'));
    actions.append(btn('Thử lại', 'primary', () => act(`/${it.key}/approve`)), skipButton(it));
  } else if (it.state === 'review') {
    const a = it.analysis ?? {};
    if (it.error) card.append(el('div', 'appr-err', it.error));
    for (const s of [
      section('Tóm tắt', a.summary),
      section('Loại', [a.type, a.store, a.confidence && `độ chắc: ${a.confidence}`].filter(Boolean).join(' · ')),
      section('Nguyên nhân', a.rootCause),
      section('Cách giải quyết', a.solution),
      section('Đã kiểm tra', (a.checks ?? []).map((c) => `[${c.what === 'sentry' ? 'Sentry' : c.what === 'store' ? 'Store' : c.what === 'admin' ? 'Admin' : c.what}] ${c.result ?? ''}`).join(' · ')),
      section('Cần xác minh', (a.needs ?? []).join(' · ')),
    ]) if (s) card.append(s);
    if (a.questions?.length) card.append(questionsBlock(it, a));
    const probe = denialsBlock(it.denials, it.images, it.prefetch);
    if (probe) card.append(probe);

    // the whole report of the skill, as in the CLI (open unless you closed it)
    const det = el('details', 'appr-report');
    det.open = true;
    det.append(el('summary', '', `Báo cáo đầy đủ của /analyze-boss-task${it.costUsd ? ` · $${Number(it.costUsd).toFixed(2)}` : ''}`), el('pre', '', it.report || '(trống)'));
    card.append(det);
    card.append(chatBlock(it));

    // comment: edit, then approve
    const c = it.comment ?? {};
    // the same approval appends the proposed code to DevHub (kept existing code, new block commented out)
    const withDevhub = !!a.devhub?.code && ['proposed', 'failed', undefined].includes(it.devhub?.state);
    const cbox = el('div', 'appr-block');
    cbox.append(el('div', 'appr-block-head', 'Comment lên task (sửa được trước khi duyệt)'));
    if (['posting', 'posted', 'unknown'].includes(c.state)) {
      cbox.append(el('pre', 'appr-pre', c.text));
      const st = el('div', c.state === 'posted' ? 'appr-ok' : 'appr-err', COMMENT_STATE[c.state] + (c.via === 'claude' ? ' (qua Claude)' : ''));
      cbox.append(st);
      if (c.error) cbox.append(el('div', 'appr-err', c.error));
    } else {
      const ta = el('textarea', 'appr-text');
      ta.rows = 6;
      ta.value = drafts.get(it.key) ?? c.text ?? '';
      const fmt = el('div', 'appr-warn');
      const checkFmt = () => {
        const msg = templateIssue(ta.value);
        fmt.textContent = msg ? `Chưa đúng template Root Cause / Solution / Technical Details / Result: ${msg}` : '';
        fmt.hidden = !msg;
      };
      ta.addEventListener('input', () => {
        drafts.set(it.key, ta.value);
        checkFmt();
      });
      checkFmt();
      cbox.append(ta, fmt);
      if (c.state === 'failed') cbox.append(el('div', 'appr-err', `${COMMENT_STATE.failed}: ${c.error}`));
      const row = el('div', 'appr-actions');
      row.append(
        btn(withDevhub ? 'Duyệt: comment lên task + thêm code DevHub' : 'Duyệt & comment lên task', 'primary',
          () => act(`/${it.key}/comment`, { text: ta.value, code: withDevhub ? codeDrafts.get(it.key) ?? a.devhub.code : undefined })),
        btn('Copy', '', () => Promise.resolve(navigator.clipboard?.writeText(ta.value)).catch(() => {}).finally(() => renderApprovals(true))),
      );
      cbox.append(row);
    }
    card.append(cbox);

    // DevHub: only when the analysis proposed code
    if (a.devhub?.code) {
      const d = it.devhub ?? {};
      const dbox = el('div', 'appr-block');
      dbox.append(el('div', 'appr-block-head', `Code DevHub đề xuất${a.devhub.purpose ? ': ' + a.devhub.purpose : ''}`));
      if (a.devhub.notes) dbox.append(el('div', 'muted', a.devhub.notes));
      let codeBox = null;
      if (['running', 'written', 'unknown'].includes(d.state)) {
        dbox.append(el('pre', 'appr-pre', a.devhub.code));
      } else {
        const ta = el('textarea', 'appr-text mono');
        codeBox = ta;
        ta.rows = 8;
        ta.value = codeDrafts.get(it.key) ?? a.devhub.code;
        ta.addEventListener('input', () => codeDrafts.set(it.key, ta.value));
        dbox.append(ta);
        const row = el('div', 'appr-actions');
        row.append(btn('Chỉ thêm code DevHub', '', () => act(`/${it.key}/devhub`, { code: ta.value })));
        row.append(el('span', 'muted', 'Duyệt ở trên là tự thêm vào DevHub: giữ nguyên code đang có, nối block mới ở cuối, dạng comment (CHỜ XÁC NHẬN). Bật code bằng /autofix-boss confirm.'));
        dbox.append(row);
      }
      if (d.state) dbox.append(el('div', d.state === 'written' ? 'appr-ok' : d.state === 'running' ? 'muted' : 'appr-err', [DEVHUB_STATE[d.state], d.detail, d.error].filter(Boolean).join(': ')));
      if (d.state === 'written' || d.state === 'unknown') {
        dbox.append(el('div', 'muted', [d.domain, d.version != null && `version mới ${d.version}`, d.previousVersion != null && `trước đó ${d.previousVersion} (restore được)`].filter(Boolean).join(' · ')));
        if (d.block) {
          const det = el('details', 'appr-report');
          det.append(el('summary', '', 'Block đã thêm'), el('pre', '', d.block));
          dbox.append(det);
        }
      }
      dbox.append(trialBlock(it, a, () => codeBox?.value));
      card.append(dbox);
    }
    actions.append(btn('Xong, ẩn khỏi hàng đợi', '', () => act(`/${it.key}/done`)), skipButton(it));
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

// "Bỏ qua" asks why (feeds the lessons): one click opens the reasons, one more picks one
const skipOpen = new Set();
const SKIP_REASONS = { wrong: 'Sai nguyên nhân / solution', elsewhere: 'Đã xử lý ở chỗ khác', 'not-needed': 'Không cần xử lý', other: 'Khác' };
function skipButton(it) {
  if (!skipOpen.has(it.key)) {
    const b = el('button', '', 'Bỏ qua');
    b.type = 'button';
    b.addEventListener('click', () => (skipOpen.add(it.key), renderApprovals(true)));
    return b;
  }
  const wrap = el('span', 'skip-reasons');
  wrap.append(el('span', 'muted', 'Vì sao bỏ qua?'));
  for (const [k, label] of Object.entries(SKIP_REASONS)) wrap.append(btn(label, '', () => (skipOpen.delete(it.key), act(`/${it.key}/skip`, { reason: k }))));
  const x = el('button', '', '×');
  x.type = 'button';
  x.title = 'Không bỏ qua nữa';
  x.addEventListener('click', () => (skipOpen.delete(it.key), renderApprovals(true)));
  wrap.append(x);
  return wrap;
}

// ---- learning: lessons waiting for you, approved lessons, recent feedback, cases ----
const EDIT_LABEL = { kept: ['appr-ok', 'Giữ nguyên bản nháp'], light: ['muted', 'Sửa một phần'], rewritten: ['appr-err', 'Viết lại'] };
const lessonDrafts = new Map();
let learnSig = '';
async function lessonAct(id, action, body = {}) {
  try {
    const r = await fetch(`/api/learn/lesson/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) alertLine((await r.json().catch(() => ({}))).error || `Lỗi ${r.status}`);
  } catch (e) {
    alertLine(e.message);
  }
}
function renderLearn(force = false) {
  const L = sources.get('')?.learn;
  const panel = $('#learn-panel');
  if (!L) return void (panel.hidden = true);
  const sig = JSON.stringify(L);
  if (!force && sig === learnSig) return;
  // do not rebuild under your cursor while you edit a lesson
  if (!force && panel.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  learnSig = sig;
  const pending = L.lessons.filter((l) => l.state === 'proposed');
  const approved = L.lessons.filter((l) => l.state === 'approved');
  panel.hidden = !pending.length && !approved.length && !L.recent.length && !L.casesCount;
  $('#learn-note').textContent = [pending.length && `${pending.length} bài học chờ duyệt`, `${approved.length} đã duyệt`, `${L.casesCount} case của bạn`,
    L.teamCases?.withAnswer && `${L.teamCases.withAnswer} tiền lệ của team`,
    L.moduleMap?.exists && (L.moduleMap.draft ? 'bản đồ tính năng: chờ duyệt' : 'bản đồ tính năng: đang dùng')].filter(Boolean).join(' · ');
  const body = $('#learn-body');
  const open = new Set([...body.querySelectorAll('details[open]')].map((d) => d.dataset.k));
  const nodes = [];

  const lessonCard = (l) => {
    const card = el('div', 'lesson');
    const top = el('div', 'card-top');
    top.append(el('span', 'tag', l.app), l.topic ? el('b', '', l.topic) : '', l.fromTask ? taskLink(l.fromTask) : '');
    const ta = el('textarea', 'appr-text');
    ta.rows = 2;
    ta.value = lessonDrafts.get(l.id) ?? l.text;
    ta.addEventListener('input', () => lessonDrafts.set(l.id, ta.value));
    const row = el('div', 'appr-actions');
    row.append(
      btn('Duyệt bài học', 'primary', () => (lessonDrafts.delete(l.id), lessonAct(l.id, 'approve', { text: ta.value }))),
      btn('Bỏ', '', () => lessonAct(l.id, 'reject')),
    );
    card.append(top, ta);
    if (l.why) card.append(el('div', 'muted', `Từ: ${l.why}`));
    card.append(row);
    return card;
  };
  // a few at a time so the office stays in view; the rest one click away
  const SHOW = 3;
  for (const l of pending.slice(0, SHOW)) nodes.push(lessonCard(l));
  if (pending.length > SHOW) {
    const more = el('details', 'learn-sec');
    more.dataset.k = 'more';
    more.open = open.has('more');
    more.append(el('summary', '', `Còn ${pending.length - SHOW} bài học chờ duyệt`));
    for (const l of pending.slice(SHOW)) more.append(lessonCard(l));
    nodes.push(more);
  }
  if (!pending.length) nodes.push(el('div', 'muted', 'Không có bài học nào chờ duyệt. Bài học mới xuất hiện khi bạn sửa nhiều bản nháp, bỏ qua vì phân tích sai, hoặc task bị mở lại.'));

  const section = (k, title, fill) => {
    const d = el('details', 'learn-sec');
    d.dataset.k = k;
    d.open = open.has(k);
    d.append(el('summary', '', title));
    fill(d);
    nodes.push(d);
  };
  section('approved', `Bài học đã duyệt (${approved.length}): thêm vào prompt phân tích của đúng app`, (d) => {
    for (const l of approved) {
      const row = el('div', 'learn-row');
      row.append(el('span', 'tag', l.app), el('span', 'learn-text', `${l.topic ? l.topic + ': ' : ''}${l.text}`), btn('Xoá', 'small', () => lessonAct(l.id, 'delete')));
      d.append(row);
    }
  });
  section('recent', `Phản hồi gần đây (${L.recent.length})`, (d) => {
    for (const f of L.recent) {
      const row = el('div', 'learn-row');
      const [cls, label] = f.hasMine ? EDIT_LABEL[f.edit] ?? ['muted', f.edit] : ['muted', 'Chưa thấy comment của bạn'];
      const bits = [
        f.state === 'skipped' && `Bỏ qua${f.skipReason ? ': ' + (L.skipReasons[f.skipReason] ?? f.skipReason) : ''}`,
        f.hasMine && f.similarity != null && `giống ${Math.round(f.similarity * 100)}%`,
        f.reopened && 'bị mở lại',
        f.laterOthers && `${f.laterOthers} comment sau đó`,
        f.lesson === 'running' ? 'đang rút bài học…' : f.lesson === 'done' ? 'đã rút bài học' : f.lesson === 'failed' ? 'rút bài học lỗi' : null,
        f.caseSaved && 'đã lưu case',
      ].filter(Boolean).join(' · ');
      row.append(taskLink(f.key), el('span', cls, label), el('span', 'muted learn-text', bits));
      d.append(row);
    }
  });
  section('cases', `Kho case (${L.casesCount}): phân tích lần sau đọc các case giống nhất trước`, (d) => {
    for (const c of L.cases) {
      const row = el('div', 'learn-row');
      row.append(taskLink(c.key), el('span', 'tag', c.app ?? ''), el('span', 'learn-text', c.title ?? ''));
      d.append(row);
    }
  });
  body.replaceChildren(...nodes);
}

// ---- question tasks: each question, the direct answer, and whether an independent check confirmed it ----
const VERDICT = { confirmed: ['ok', '✓ Đã kiểm chứng'], corrected: ['fix', '✎ Đã sửa khi kiểm chứng'], unsure: ['unsure', '? Chưa chắc'] };
function questionsBlock(it, a) {
  const box = el('div', 'appr-block');
  const v = it.verify;
  box.append(el('div', 'appr-block-head', `Câu hỏi (${a.questions.length})`));
  if (v?.state === 'done') {
    const parts = [v.confirmed && `${v.confirmed} đúng`, v.corrected && `${v.corrected} đã sửa`, v.unsure && `${v.unsure} chưa chắc`, v.missed?.length && `${v.missed.length} câu bị sót đã thêm`].filter(Boolean).join(' · ');
    box.append(el('div', v.unsure || v.corrected ? 'appr-err' : 'appr-ok', `Kiểm chứng độc lập: ${parts}${v.costUsd ? ` · $${Number(v.costUsd).toFixed(2)}` : ''}`));
  } else if (v?.state === 'failed') box.append(el('div', 'appr-err', `Chưa kiểm chứng được: ${v.error}. Câu trả lời dưới đây là bản soạn đầu.`));
  a.questions.forEach((q, i) => {
    const row = el('div', 'qa');
    const verdict = VERDICT[q.verdict] ?? (q.verified === false ? VERDICT.unsure : null);
    const head = el('div', 'qa-q', `${i + 1}. ${q.q ?? ''}`);
    if (verdict) head.append(el('span', `qa-badge ${verdict[0]}`, verdict[1]));
    row.append(head, el('div', 'qa-a', q.answer ?? ''));
    if (q.note) row.append(el('div', 'muted', `Kiểm chứng: ${q.note}`));
    if (q.evidence) row.append(el('div', 'qa-ev', `Căn cứ: ${q.evidence}`));
    box.append(row);
  });
  return box;
}

// ---- try the fix on the storefront (local Chrome, nothing saved), then enable it in DevHub ----
const TRIAL_STATE = {
  running: ['muted', 'Đang thử trên store (Chrome riêng, chặn mọi request ghi)…'],
  passed: ['appr-ok', 'Thử fix: ĐẠT'],
  failed: ['appr-err', 'Thử fix: chưa đạt'],
  'not-reproduced': ['appr-err', 'Thử fix: không tái hiện được lỗi'],
  unknown: ['appr-err', 'Thử fix: không có kết quả'],
};
const LIVE_STATE = {
  enabling: ['muted', 'Đang bỏ comment block trong DevHub…'],
  checking: ['muted', 'Đã bật, đang kiểm tra store thật (đợi cache tối đa ~2 phút)…'],
  reverting: ['appr-err', 'Code gây lỗi, đang comment lại block…'],
  live: ['appr-ok', 'Code đang chạy trên store'],
  'live-unverified': ['appr-err', 'Đã bật, chưa xác nhận được trên store'],
  reverted: ['appr-err', 'Đã tắt lại (comment lại block)'],
  failed: ['appr-err', 'Không bật được'],
  unknown: ['appr-err', 'Không rõ trạng thái: xem DevHub'],
};
const trialDrafts = new Map(); // key → {path, check, ready}
const armed = new Set(); // two-click "enable without a passed trial"
// same as lib/claude.mjs blockCode: the code a commented block runs
const blockCode = (block) => block.split('\n').slice(1, -1).map((l) => (l === '//' ? '' : l.replace(/^\/\/ /, ''))).join('\n');
const shotUrl = (key, name, at) => `/api/pipeline/${key}/shot/${name}?t=${encodeURIComponent(at ?? '')}`;

function shotFig(key, name, at, caption) {
  const fig = el('figure', 'trial-shot');
  const a = document.createElement('a');
  a.href = shotUrl(key, name, at);
  a.target = '_blank';
  a.rel = 'noopener';
  const img = document.createElement('img');
  img.src = a.href;
  img.alt = caption;
  img.loading = 'lazy';
  a.append(img);
  fig.append(a, el('figcaption', '', caption));
  return fig;
}

const checkText = (x) => (x == null ? '' : x.checkError ? `kiểm tra lỗi: ${x.checkError}` : `${x.check === true ? 'hết lỗi' : x.check === false ? 'còn lỗi' : `check=${JSON.stringify(x.check)}`}${x.errors ? ` · ${x.errors} lỗi console` : ''}${x.blocked ? ` · chặn ${x.blocked} request ghi` : ''}`);

function trialBlock(it, a, currentCode) {
  const box = el('div', 'trial');
  const t = it.trial;
  const d = it.devhub ?? {};
  const test = a.devhub.test ?? {};
  const draft = trialDrafts.get(it.key) ?? {};
  box.append(el('div', 'appr-block-head', 'Thử fix trên store trước khi bật (không lưu gì)'));

  // how the trial checks the bug: editable
  const det = el('details', 'trial-spec');
  det.open = !test.check;
  det.append(el('summary', '', `Kiểm tra: ${test.path || '/'}${test.check ? ` → ${test.check}` : ' (chưa có biểu thức)'}`));
  const field = (name, label, ph, mono) => {
    const wrap = el('label', 'trial-field');
    const inp = document.createElement('input');
    inp.className = `appr-input${mono ? ' mono' : ''}`;
    inp.placeholder = ph;
    inp.value = draft[name] ?? test[name] ?? '';
    inp.addEventListener('input', () => trialDrafts.set(it.key, { ...(trialDrafts.get(it.key) ?? {}), [name]: inp.value }));
    wrap.append(el('span', 'muted', label), inp);
    det.append(wrap);
  };
  field('path', 'Trang', '/products/handle', false);
  field('check', 'Biểu thức (true = hết lỗi)', "getComputedStyle(document.querySelector('.price')).display !== 'none'", true);
  field('ready', 'Chờ selector', '.product-form (tuỳ chọn)', true);
  box.append(det);

  if (t?.state) {
    const [cls, label] = TRIAL_STATE[t.state] ?? ['muted', t.state];
    box.append(el('div', cls, [label, t.note].filter(Boolean).join(': ')));
    if (t.state !== 'running' && t.shots?.length) {
      const row = el('div', 'trial-shots');
      row.append(shotFig(it.key, 'trial-before.png', t.at, `Trước: ${checkText(t.before)}`));
      if (t.shots.includes('trial-after.png')) row.append(shotFig(it.key, 'trial-after.png', t.at, `Sau khi chạy code: ${checkText(t.after)}`));
      box.append(row);
    }
    if (t.newErrors?.length) box.append(el('pre', 'appr-pre', t.newErrors.join('\n')));
    if (t.url) box.append(el('div', 'muted', `${t.url} · khách vãng lai, Chrome riêng không đăng nhập · code chạy sau khi trang tải xong`));
    if (t.state !== 'running' && d.block && t.code !== blockCode(d.block)) box.append(el('div', 'appr-err', 'Lần thử này dùng code khác với code đang có trong DevHub: bấm Thử lại'));
  }
  const row = el('div', 'appr-actions');
  if (t?.state !== 'running') {
    row.append(btn(t ? 'Thử lại' : 'Thử fix', '', () => {
      const dr = trialDrafts.get(it.key) ?? {};
      act(`/${it.key}/trial`, { ...dr, code: currentCode() });
    }));
  }

  // enable in DevHub: only once the commented block is there
  const live = d.live;
  if (d.state === 'written' && (!live || ['failed', 'reverted'].includes(live.state))) {
    const passed = t?.state === 'passed';
    if (passed && t.code === blockCode(d.block)) row.append(btn('Bật code trên store', 'primary', () => act(`/${it.key}/enable`, {})));
    else {
      const sure = armed.has(it.key);
      const b = btn(sure ? 'Bấm lần nữa để bật dù chưa thử đạt' : 'Bật dù chưa thử đạt', sure ? 'danger' : '', () => {
        if (!armed.has(it.key)) {
          armed.add(it.key);
          setTimeout(() => (armed.delete(it.key), renderApprovals(true)), 5000);
          return renderApprovals(true);
        }
        armed.delete(it.key);
        act(`/${it.key}/enable`, { force: true });
      });
      row.append(b);
    }
  }
  if (row.childElementCount) box.append(row);
  if (live?.state) {
    const [cls, label] = LIVE_STATE[live.state] ?? ['muted', live.state];
    box.append(el('div', cls, [label, live.note].filter(Boolean).join(': ')));
    if (live.newErrors?.length) box.append(el('pre', 'appr-pre', live.newErrors.join('\n')));
    if (live.shot) {
      const r = el('div', 'trial-shots');
      r.append(shotFig(it.key, 'live.png', live.at, 'Store thật sau khi bật'));
      box.append(r);
    }
    const v = [live.version != null && `version ${live.version}`, live.previousVersion != null && `restore được version ${live.previousVersion}`].filter(Boolean).join(' · ');
    if (v) box.append(el('div', 'muted', v));
  }
  return box;
}

// What the session could not do (refused tool calls) and the task images the app downloaded for it.
function denialsBlock(denials, images, prefetch) {
  const n = denials?.length ?? 0;
  if (!n && !images && !prefetch) return null;
  const box = el('div', 'appr-probe');
  if (prefetch) box.append(el('div', 'appr-muted', `Đã đọc sẵn cho Claude: task, ${prefetch.comments ?? '?'} comment${prefetch.crisp != null ? `, ${prefetch.crisp} tin Crisp` : ''}`));
  if (images) box.append(el('div', images.failed ? 'appr-warn' : 'appr-muted',
    images.saved || images.failed ? `Ảnh task: đã tải ${images.saved}${images.failed ? `, lỗi ${images.failed}` : ''}` : 'Ảnh task: không có'));
  if (n) {
    const d = el('details', 'appr-denials');
    d.append(el('summary', 'appr-warn', `⚠ ${n} thao tác bị chặn: kết quả có thể thiếu bằng chứng`));
    for (const x of denials) d.append(el('div', 'appr-muted mono', `${x.tool}: ${x.input}`));
    box.append(d);
  }
  return box;
}

// Ask Claude again in the same analysis session (read only); a changed conclusion updates the card above.
function chatBlock(it) {
  const box = el('div', 'appr-block appr-chat');
  box.append(el('div', 'appr-block-head', 'Hỏi lại Claude về kết quả này'));
  for (const m of it.chat ?? []) {
    const row = el('div', `chat-msg chat-${m.role}`);
    row.append(el('div', 'chat-who', m.role === 'user' ? `Bạn · ${clock(m.at)}` : m.role === 'error' ? `Lỗi · ${clock(m.at)}` : `Claude · ${clock(m.at)}${m.costUsd ? ` · $${Number(m.costUsd).toFixed(2)}` : ''}`));
    row.append(el('div', 'chat-text', m.text || '(trống)'));
    if (m.updated?.length) row.append(el('div', 'appr-ok', `Đã cập nhật: ${m.updated.map((f) => CHAT_FIELDS[f] ?? f).join(', ')}`));
    const dn = denialsBlock(m.denials);
    if (dn) row.append(dn);
    box.append(row);
  }
  if (it.asking) {
    const row = el('div', 'appr-actions');
    row.append(el('span', 'muted', 'Claude đang kiểm tra lại…'), btn('Dừng', '', () => act(`/${it.key}/askstop`)));
    box.append(row);
    return box;
  }
  const ta = el('textarea', 'appr-text');
  ta.rows = 2;
  ta.dataset.keep = 'chat';
  ta.placeholder = 'VD: Kiểm tra lại xem store có bật app embed không? / Solution này có ảnh hưởng tới Quick Order không? (Ctrl+Enter để gửi)';
  ta.value = chatDrafts.get(it.key) ?? '';
  const send = () => {
    if (!ta.value.trim()) return;
    chatDrafts.delete(it.key);
    act(`/${it.key}/ask`, { text: ta.value });
  };
  ta.addEventListener('input', () => chatDrafts.set(it.key, ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });
  const row = el('div', 'appr-actions');
  row.append(btn('Gửi', 'primary', send), el('span', 'muted', 'Cùng phiên phân tích, chỉ đọc. Kết luận thay đổi thì thẻ này tự cập nhật (comment/code chưa gửi).'));
  box.append(ta, row);
  return box;
}

function renderApprovals(force = false) {
  const all = localPipeline();
  const active = all.filter((i) => !['skipped', 'done'].includes(i.state));
  $('#appr-panel').hidden = !active.length;
  const n = (st) => active.filter((i) => i.state === st).length;
  $('#appr-note').textContent = [n('pending') && `${n('pending')} chờ duyệt phân tích`, n('analyzing') + n('queued') && `${n('analyzing') + n('queued')} đang phân tích`, n('review') && `${n('review')} chờ duyệt solution`].filter(Boolean).join(' · ');
  const list = $('#appr-list');
  const keep = new Set();
  const nodes = [];
  for (const it of active) {
    keep.add(it.key);
    const sig = JSON.stringify(it);
    let c = cardCache.get(it.key);
    if (force || !c || c.sig !== sig) {
      // keep what you typed and whether the report was open
      const wasOpen = c?.node.querySelector('details.appr-report')?.open;
      const focused = c?.node.contains(document.activeElement) ? document.activeElement.dataset.keep : null;
      c = { sig, node: approvalCard(it) };
      const rep = c.node.querySelector('details.appr-report');
      if (rep && wasOpen !== undefined) rep.open = wasOpen;
      if (focused) queueMicrotask(() => c.node.querySelector(`[data-keep="${focused}"]`)?.focus());
      cardCache.set(it.key, c);
    }
    nodes.push(c.node);
  }
  for (const k of cardCache.keys()) if (!keep.has(k)) cardCache.delete(k);
  if (nodes.length !== list.children.length || nodes.some((nd, i) => list.children[i] !== nd)) list.replaceChildren(...nodes);
}

// ---------- toasts: a task newly assigned to you ----------
let openToasts = 0;
function updateTitle(waiting = allSessions().filter((s) => s.status === 'waiting').length) {
  document.title = (openToasts ? '(Task mới) ' : '') + (waiting ? `(${waiting}) ` : '') + 'Phòng Support';
}

function chime() {
  try {
    const ac = new AudioContext();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.6);
  } catch {
    // the browser may block sound until the page has been clicked once
  }
}

function showToast(item, src) {
  const box = el('div', 'toast');
  box.setAttribute('role', 'status');
  const head = el('div', 'toast-head');
  const close = el('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Đóng');
  head.append(el('b', '', item.title), item.task ? taskLink(item.task) : '', close);
  box.append(head);
  const [title, ...meta] = String(item.detail || '').split(' · ');
  if (title) box.append(el('div', 'toast-title', title));
  const extra = [item.app && item.app !== 'Khác' ? `B2B ${item.app}` : '', ...meta].filter(Boolean).join(' · ');
  if (extra) box.append(el('div', 'toast-meta', extra));
  const actions = el('div', 'toast-actions');
  if (item.task) {
    const open = taskLink(item.task, 'primary');
    open.textContent = 'Mở trên BOSS';
    actions.append(open);
  }
  const queued = localPipeline().find((i) => i.key === item.task);
  if (item.type === 'assigned' && queued && ['queued', 'analyzing'].includes(queued.state) && src === sources.get('')) {
    box.append(el('div', 'toast-meta', 'Đang tự chạy /analyze-boss-task'));
  }
  if (item.type === 'assigned' && queued?.state === 'pending' && src === sources.get('')) {
    actions.prepend(btn('Duyệt phân tích', 'primary', () => {
      act(`/${item.task}/approve`);
      dismiss();
    }));
  }
  if (item.type === 'review') {
    actions.prepend(btn('Xem solution', 'primary', () => {
      document.getElementById(`appr-${item.task}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      dismiss();
    }));
  }
  const later = el('button', '', 'Để sau');
  later.type = 'button';
  actions.append(later);
  box.append(actions);
  function dismiss() {
    box.remove();
    openToasts = Math.max(0, openToasts - 1);
    updateTitle();
  }
  close.addEventListener('click', dismiss);
  later.addEventListener('click', dismiss);
  actions.querySelector('a')?.addEventListener('click', dismiss);
  $('#toasts').prepend(box);
  openToasts += 1;
  updateTitle();
  chime();
}

// ---------- notifications ----------
function notify(item, src) {
  if (!ui.notify || item.level !== 'attention' || !('Notification' in window)) return;
  if (item.kind === 'boss' && src !== bossSource()) return;
  const who = item.kind === 'claude' ? `${item.session?.project ?? 'Claude'}${multi() ? ' · ' + src.machine : ''}` : 'BOSS';
  const n = new Notification(`${who}: ${item.title}`, { body: [item.task, item.detail].filter(Boolean).join(' · '), tag: `so-${src.origin}-${item.id}`, requireInteraction: item.type === 'assigned' });
  n.onclick = () => window.focus();
}

const NOTIFY_KEY = 'support-office:notify';
function setNotify(on) {
  ui.notify = on;
  $('#btn-notify').textContent = on ? 'Tắt thông báo' : 'Bật thông báo';
  try {
    localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
  } catch {
    // private window: the choice lasts until the page is closed
  }
}
$('#btn-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  setNotify(ui.notify ? false : (await Notification.requestPermission()) === 'granted');
});
try {
  if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1') setNotify(true);
} catch {
  // storage unavailable: notifications start off
}

// ---------- controls ----------
// Auto-analysis of new tasks assigned to you (this machine's server only)
let autoOn = null;
function renderAuto(s) {
  if (typeof s?.autoAnalyze !== 'boolean') return;
  autoOn = s.autoAnalyze;
  const b = $('#btn-auto');
  b.hidden = false;
  b.disabled = false;
  b.setAttribute('aria-pressed', String(autoOn));
  b.textContent = `Tự động phân tích: ${autoOn ? 'Bật' : 'Tắt'}`;
}
$('#btn-auto').addEventListener('click', async () => {
  if (autoOn === null) return;
  const b = $('#btn-auto');
  b.disabled = true;
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoAnalyze: !autoOn }) });
    if (!r.ok) throw new Error(await r.text() || `Lỗi ${r.status}`);
    renderAuto(await r.json());
  } catch (e) {
    b.disabled = false;
    alertLine(e.message);
  }
});
$('#btn-poll').addEventListener('click', () => {
  for (const src of sources.values()) fetch(`${src.origin}/api/poll`, { method: 'POST' }).catch(() => {});
});
$('#q').addEventListener('input', (e) => {
  ui.q = e.target.value;
  renderDesks();
});
for (const b of document.querySelectorAll('#feed-filter button')) {
  b.addEventListener('click', () => {
    ui.feedFilter = b.dataset.feed;
    for (const x of document.querySelectorAll('#feed-filter button')) x.setAttribute('aria-pressed', String(x === b));
    renderFeed();
  });
}
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    ui.view = b.dataset.view;
    for (const x of document.querySelectorAll('.tabs button')) {
      x.setAttribute('aria-pressed', String(x === b));
      x.setAttribute('aria-selected', String(x === b));
    }
    $('#view-office').hidden = ui.view !== 'office';
    $('#view-list').hidden = ui.view !== 'list';
    showPopover(null);
  });
}
$('#btn-full').addEventListener('click', async () => {
  const wrap = $('#view-office');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await wrap.requestFullscreen();
  } catch {
    // fullscreen refused (e.g. iframe or phone browser): stay inline
  }
});
document.addEventListener('fullscreenchange', () => {
  $('#btn-full').title = document.fullscreenElement ? 'Thoát toàn màn hình' : 'Toàn màn hình';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    showPopover(null);
    office.deselect();
  }
});

// ---------- live connections ----------
function connect(origin, machine) {
  const src = { origin, machine, connected: false, boss: null, sessions: new Map(), feed: [], pipeline: [] };
  sources.set(origin, src);
  const es = new EventSource(`${origin}/events`);
  es.onopen = () => {
    src.connected = true;
    renderHeader();
  };
  es.onerror = () => {
    src.connected = false;
    renderHeader();
  };
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    src.machine = d.machine ?? src.machine;
    src.boss = d.boss;
    src.sessions = new Map(d.sessions.map((s) => [s.id, s]));
    src.feed = d.feed;
    src.pipeline = d.pipeline ?? [];
    src.learn = d.learn ?? null;
    if (origin === '') renderAuto(d.settings);
    renderAll();
  });
  es.addEventListener('boss', (e) => {
    src.boss = JSON.parse(e.data);
    renderHeader();
    renderDesks();
    renderMine();
    renderAssigned();
    renderOffice();
  });
  es.addEventListener('pipeline', (e) => {
    src.pipeline = JSON.parse(e.data);
    if (origin === '') {
      renderApprovals();
      renderAssigned();
      renderOffice();
    }
  });
  if (origin === '') es.addEventListener('settings', (e) => renderAuto(JSON.parse(e.data)));
  es.addEventListener('learn', (e) => {
    src.learn = JSON.parse(e.data);
    if (origin === '') renderLearn();
  });
  es.addEventListener('session', (e) => {
    const s = JSON.parse(e.data);
    if (s.removed) src.sessions.delete(s.id);
    else src.sessions.set(s.id, s);
    renderSessions();
    renderDesks();
    renderOffice();
  });
  es.addEventListener('feed', (e) => {
    const item = JSON.parse(e.data);
    src.feed.push(item);
    if (src.feed.length > 300) src.feed.shift();
    renderFeed();
    if (item.type === 'assigned' && src === bossSource()) showToast(item, src);
    if (item.type === 'review' && src === sources.get('')) showToast(item, src);
    notify(item, src);
  });
}

async function start() {
  let cfg = { machine: 'Máy này', peers: [] };
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch {
    // older server: no peers
  }
  connect('', cfg.machine);
  for (const p of cfg.peers) if (p !== location.origin) connect(p, new URL(p).hostname.split('.')[0]);
}

start();
const tick = () => ($('#clock').textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
tick();
setInterval(() => {
  tick();
  renderSessions();
}, 30000);
