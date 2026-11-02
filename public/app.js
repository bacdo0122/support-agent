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
    else if (it.state === 'analyzing') lastAction = 'Đang chạy /analyze-boss-task';
    else if (it.state === 'failed') [status, waitingFor] = ['waiting', `lỗi: ${it.error ?? ''}`];
    else if (it.comment?.state === 'posting') lastAction = 'Đang comment lên task';
    else if (it.devhub?.state === 'running') lastAction = 'Đang ghi DevHub';
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
const DEVHUB_STATE = { running: 'Claude đang ghi DevHub…', written: 'Đã ghi DevHub (đang comment, chờ xác nhận)', skipped: 'Không ghi DevHub', failed: 'Ghi DevHub lỗi', unknown: 'Không rõ đã ghi chưa' };
const drafts = new Map(); // key → comment text you are editing
const codeDrafts = new Map();
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
    actions.append(btn('Duyệt: chuyển In Progress + chạy /analyze-boss-task', 'primary', () => act(`/${it.key}/approve`)), btn('Bỏ qua', '', () => act(`/${it.key}/skip`)));
  } else if (it.state === 'queued' || it.state === 'analyzing') {
    if (it.startedAt) card.append(el('div', 'muted', `Bắt đầu ${clock(it.startedAt)} · thường mất 5–15 phút`));
    actions.append(btn('Huỷ', '', () => act(`/${it.key}/cancel`)));
  } else if (it.state === 'failed') {
    card.append(el('div', 'appr-err', it.error ?? 'Lỗi'));
    actions.append(btn('Thử lại', 'primary', () => act(`/${it.key}/approve`)), btn('Bỏ qua', '', () => act(`/${it.key}/skip`)));
  } else if (it.state === 'review') {
    const a = it.analysis ?? {};
    if (it.error) card.append(el('div', 'appr-err', it.error));
    for (const s of [
      section('Tóm tắt', a.summary),
      section('Loại', [a.type, a.store, a.confidence && `độ chắc: ${a.confidence}`].filter(Boolean).join(' · ')),
      section('Nguyên nhân', a.rootCause),
      section('Cách giải quyết', a.solution),
      section('Cần xác minh', (a.needs ?? []).join(' · ')),
    ]) if (s) card.append(s);

    const det = el('details', 'appr-report');
    det.append(el('summary', '', `Báo cáo đầy đủ${it.costUsd ? ` · $${Number(it.costUsd).toFixed(2)}` : ''}`), el('pre', '', it.report || '(trống)'));
    card.append(det);

    // comment: edit, then approve
    const c = it.comment ?? {};
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
      ta.addEventListener('input', () => drafts.set(it.key, ta.value));
      cbox.append(ta);
      if (c.state === 'failed') cbox.append(el('div', 'appr-err', `${COMMENT_STATE.failed}: ${c.error}`));
      const row = el('div', 'appr-actions');
      row.append(
        btn('Duyệt & comment lên task', 'primary', () => act(`/${it.key}/comment`, { text: ta.value })),
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
      if (['running', 'written', 'unknown'].includes(d.state)) {
        dbox.append(el('pre', 'appr-pre', a.devhub.code));
      } else {
        const ta = el('textarea', 'appr-text mono');
        ta.rows = 8;
        ta.value = codeDrafts.get(it.key) ?? a.devhub.code;
        ta.addEventListener('input', () => codeDrafts.set(it.key, ta.value));
        dbox.append(ta);
        const row = el('div', 'appr-actions');
        row.append(btn('Cấp quyền ghi DevHub', 'primary', () => act(`/${it.key}/devhub`, { code: ta.value })));
        row.append(el('span', 'muted', 'Ghi ở dạng comment (CHỜ XÁC NHẬN) theo luật autofix-boss; bật code bằng /autofix-boss confirm.'));
        dbox.append(row);
      }
      if (d.state) dbox.append(el('div', d.state === 'written' ? 'appr-ok' : d.state === 'running' ? 'muted' : 'appr-err', [DEVHUB_STATE[d.state], d.detail, d.error].filter(Boolean).join(': ')));
      card.append(dbox);
    }
    actions.append(btn('Xong, ẩn khỏi hàng đợi', '', () => act(`/${it.key}/done`)), btn('Bỏ qua', '', () => act(`/${it.key}/skip`)));
  }
  if (actions.childElementCount) card.append(actions);
  return card;
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
      const wasOpen = c?.node.querySelector('details')?.open;
      c = { sig, node: approvalCard(it) };
      if (wasOpen) c.node.querySelector('details').open = true;
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
    box.append(el('div', 'toast-meta', 'Đã tự chuyển In Progress và đang chạy /analyze-boss-task'));
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
