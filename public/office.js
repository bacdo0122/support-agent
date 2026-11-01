// Isometric office: a daylight cut-away building in a small city (see city.js).
// Claude sessions are people at desks; open BOSS tasks are customers queuing outside each app room.

import { createCity } from './city.js';

const TW = 64; // tile width in world px
const TH = 32;
const BW = 21; // building size in tiles
const BH = 21;
const WALL_H = 78;

const APP = {
  Solution: { name: 'B2B Solution', color: '#4d8fe8' },
  Quote: { name: 'B2B Quote', color: '#a46be0' },
  Lock: { name: 'B2B Lock', color: '#2fa89a' },
  Chung: { name: 'Phòng chung', color: '#e0a43a' },
};
const STATUS = { working: '#35b37a', waiting: '#f0a92e', idle: '#9aa3b2' };
const SKIN = ['#f3cfae', '#e8b993', '#d39a72', '#a8704c', '#7c4f33'];
const HAIR = ['#2a2018', '#4b3222', '#16161c', '#7b4a26', '#c9a26b', '#a63d2a'];
const PANTS = ['#2f3a4f', '#3b3f46', '#4a5568', '#283141', '#5b4b3a'];
const BOOKS = ['#d9534f', '#4d8fe8', '#f0ad4e', '#5cb85c', '#8e6cc9', '#2fa89a', '#e8e1d2', '#c0703a'];

const ROOMS = [
  { app: 'Solution', x0: 0, x1: 7 },
  { app: 'Quote', x0: 7, x1: 14 },
  { app: 'Lock', x0: 14, x1: 21 },
];
const DESK_W = 1.3;
const DESK_D = 0.62;

const DESKS = { Solution: [], Quote: [], Lock: [], Chung: [] };
for (const r of ROOMS) for (const dy of [2.1, 4.8]) for (const dx of [0.6, 2.85, 5.1]) DESKS[r.app].push({ x: r.x0 + dx, y: dy });
for (const dy of [11.0, 13.4]) for (const dx of [12.6, 15.0, 17.4]) DESKS.Chung.push({ x: dx, y: dy });
// the person sits behind the right half of the desk; the monitor stands on the left half so it never hides them
const seatOf = (d) => ({ x: d.x + 0.98, y: d.y - 0.3 });
const CANTEEN_TABLES = [];
for (const ty of [16.9, 19.4]) for (const tx of [2.4, 5.4, 8.4]) CANTEEN_TABLES.push({ x: tx, y: ty });
// where idle sessions go: the sofa, the canteen tables, then standing in the lounge
const LOUNGE_SPOTS = [
  { x: 1.95, y: 11.0, sit: true }, { x: 3.05, y: 11.0, sit: true }, { x: 4.15, y: 11.0, sit: true },
  ...CANTEEN_TABLES.map((t) => ({ x: t.x + 0.55, y: t.y - 0.3, sit: true })),
  { x: 6.1, y: 11.4 }, { x: 7.2, y: 11.9 }, { x: 6.2, y: 12.9 }, { x: 7.3, y: 13.6 }, { x: 4.9, y: 13.9 }, { x: 2.6, y: 14.1 },
];
const DIRECTOR = { x: 17.6, y: 16.8 }; // you: the director, behind the big desk

// ---------- math & colour ----------
const iso = (x, y, z = 0) => ({ x: ((x - y) * TW) / 2, y: ((x + y) * TH) / 2 - z });
const hash = (s) => {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const shade = (hex, k) => `rgb(${rgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(',')})`;
const mix = (a, b, t) => {
  const A = rgb(a);
  const B = rgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function roomForSession(s, tasks) {
  const t = s.task && tasks.find((x) => x.key === s.task);
  if (t && APP[t.app]) return t.app;
  const p = `${s.project} ${s.cwd}`.toLowerCase();
  if (/quote/.test(p)) return 'Quote';
  if (/lock/.test(p)) return 'Lock';
  if (/solution/.test(p)) return 'Solution';
  return 'Chung';
}

// Icon kind from the session's last action (wording from lib/sessions.mjs describeTool).
function actionIcon(text = '') {
  if (/^Chạy lệnh/.test(text)) return 'term';
  if (/^Đọc/.test(text)) return 'doc';
  if (/^Sửa/.test(text)) return 'edit';
  if (/^Tìm/.test(text)) return 'search';
  if (/^Gọi trợ lý/.test(text)) return 'agent';
  if (/web/.test(text)) return 'web';
  return 'spark';
}

export function createOffice(canvas, { onSelect, onView } = {}) {
  const ctx = canvas.getContext('2d');
  let g = ctx; // current drawing context: the canvas, or the background cache while it is built
  // cached layers: the ground (city, floors, shadows) and the office's back walls,
  // so that things behind the office can be drawn between the two
  const bg = document.createElement('canvas');
  const bgctx = bg.getContext('2d');
  const walls = document.createElement('canvas');
  const wallsctx = walls.getContext('2d');
  let bgKey = '';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cam = { zoom: 1, panX: 0, panY: 0 };
  const view = { w: 0, h: 0, dpr: 1, scale: 1, ox: 0, oy: 0, fit: 1 };
  let sessions = [];
  let tasks = [];
  const actors = new Map();
  const deskOf = new Map();
  let hits = [];
  let placed = [];
  let hover = null;
  let selected = null;
  let raf = 0;
  let last = performance.now();
  let lastPaint = 0;

  // focus area: the building with its sidewalk and a strip of road
  const focus = (() => {
    const pts = [iso(-4.5, -4.5, WALL_H + 30), iso(25.5, -4.5), iso(-4.5, 25.5), iso(25.5, 25.5)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  })();
  const fcx = (focus.x0 + focus.x1) / 2;
  const fcy = (focus.y0 + focus.y1) / 2;

  // ---------- camera ----------
  function computeView() {
    view.fit = Math.min(view.w / (focus.x1 - focus.x0), view.h / (focus.y1 - focus.y0));
    view.scale = view.fit * cam.zoom;
    view.ox = view.w / 2 + cam.panX - fcx * view.scale;
    view.oy = view.h / 2 + cam.panY - fcy * view.scale;
    onView?.({ zoom: cam.zoom });
  }

  function resize() {
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const w = Math.max(280, rect.width);
    const legend = wrap.querySelector('.office-legend')?.offsetHeight ?? 0;
    const h = document.fullscreenElement === wrap ? rect.height - legend : Math.max(300, Math.min(w * 0.66, 680));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    Object.assign(view, { w, h, dpr });
    computeView();
    paint(performance.now());
  }

  function zoomAt(zoom, sx, sy) {
    const wx = (sx - view.ox) / view.scale;
    const wy = (sy - view.oy) / view.scale;
    cam.zoom = clamp(zoom, 0.3, 3.5);
    const scale = view.fit * cam.zoom;
    cam.panX = sx - wx * scale - view.w / 2 + fcx * scale;
    cam.panY = sy - wy * scale - view.h / 2 + fcy * scale;
    computeView();
    kick();
  }

  const toScreen = (p) => ({ x: p.x * view.scale + view.ox, y: p.y * view.scale + view.oy });

  // ---------- primitives (world px, current context g) ----------
  function poly(pts, fill, stroke, lw = 1) {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = lw;
      g.stroke();
    }
  }
  const quad = (x0, y0, x1, y1, z = 0) => [iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z)];
  const line = (a, b) => {
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  };

  // Box with back corner (x, y), footprint w×d tiles, height h px, base z px.
  function box(x, y, w, d, h, color, { z = 0, top, edge = true, alpha = 1 } = {}) {
    const prev = g.globalAlpha;
    g.globalAlpha = prev * alpha;
    poly([iso(x, y + d, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x, y + d, z)], shade(color, 0.86));
    poly([iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x + w, y + d, z), iso(x + w, y, z)], shade(color, 0.7));
    poly(quad(x, y, x + w, y + d, z + h), top ?? color);
    if (edge) {
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      const a = iso(x, y + d, z + h);
      const b = iso(x + w, y + d, z + h);
      const c = iso(x + w, y, z + h);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(c.x, c.y);
      g.stroke();
    }
    g.globalAlpha = prev;
  }

  function circle(x, y, r, fill) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  }

  // ---------- static scene ----------
  // Sorted drawables {d: depth, fn}. Shadows and wall-hugging pieces go to the background cache.
  const shadows = [];
  const statics = [];
  const wallPieces = [];
  // pt: a world point used to skip drawables far outside the view
  // back: the drawable stands behind the office (x < 0 or y < 0) and is drawn before its walls
  const add = (list, d, fn, pt, back = false) => list.push({ d, fn, pt, back });
  let now = 0; // seconds, for animated statics

  // Long boxes are cut into ~1-tile pieces so depth sorting against people stays right.
  function addBox(x, y, w, d, h, color, opt = {}) {
    if (opt.shadow !== false && !opt.z) shadows.push({ x, y, w, d, h });
    const target = opt.wall ? wallPieces : statics;
    const alongX = w >= d;
    const len = alongX ? w : d;
    const n = opt.noSplit ? 1 : Math.max(1, Math.round(len));
    for (let i = 0; i < n; i++) {
      const sx = alongX ? x + (w / n) * i : x;
      const sy = alongX ? y : y + (d / n) * i;
      const sw = alongX ? w / n : w;
      const sd = alongX ? d : d / n;
      add(target, sx + sw / 2 + sy + sd / 2 + (opt.bias ?? 0), () => {
        box(sx, sy, sw, sd, h, color, opt);
        opt.after?.(sx, sy, sw, sd, i);
      });
    }
  }

  // Books on a shelf's long visible face: 'y' = face at y+d (runs along x), 'x' = face at x+w (runs along y).
  function shelfBooks(face, x, y, w, d, h, seed) {
    const rows = Math.floor((h - 6) / 12);
    for (let r = 0; r < rows; r++) {
      const z0 = 4 + r * 12;
      const len = face === 'y' ? w : d;
      let t = 0.04;
      let k = hash(seed + ':' + r);
      while (t < len - 0.1) {
        const bw = 0.06 + (k % 3) * 0.015;
        const bh = 7 + (k % 4);
        const col = BOOKS[k % BOOKS.length];
        if (face === 'y') poly([iso(x + t, y + d, z0), iso(x + t + bw, y + d, z0), iso(x + t + bw, y + d, z0 + bh), iso(x + t, y + d, z0 + bh)], col);
        else poly([iso(x + w, y + t, z0), iso(x + w, y + t + bw, z0), iso(x + w, y + t + bw, z0 + bh), iso(x + w, y + t, z0 + bh)], col);
        t += bw + 0.012;
        k = Math.imul(k ^ (k >>> 13), 2654435761) >>> 0;
        if (k % 9 === 0) t += 0.08;
      }
    }
  }

  function plant(x, y, size = 1, list = statics) {
    shadows.push({ x: x - 0.2, y: y - 0.2, w: 0.4, d: 0.4, h: 20 });
    add(list, x + y + 0.2, () => {
      box(x - 0.17, y - 0.17, 0.34, 0.34, 11, '#c87a4a', { edge: false });
      const c = iso(x, y, 16);
      const leaves = [['#3f8f4f', 0, -10, 11], ['#4fa860', -7, -4, 9], ['#4fa860', 7, -5, 9], ['#62bd70', 0, -17, 8], ['#3a8247', -3, 1, 8]];
      for (const [col, dx, dy, r] of leaves) circle(c.x + dx * size, c.y + dy * size, r * size, col);
    });
  }

  function tree(x, y) {
    shadows.push({ x: x - 0.5, y: y - 0.5, w: 1, d: 1, h: 30 });
    add(statics, x + y + 0.3, () => {
      box(x - 0.08, y - 0.08, 0.16, 0.16, 26, '#7a5236', { edge: false });
      const c = iso(x, y, 30);
      for (const [col, dx, dy, r] of [['#2f7d45', 0, -6, 24], ['#3f9455', -12, 2, 17], ['#3f9455', 13, 1, 17], ['#57ad68', -2, -20, 15], ['#4ba15d', 6, -12, 13]]) circle(c.x + dx, c.y + dy, r, col);
    }, iso(x, y), x < 0 || y < 0);
  }

  function lamp(x, y) {
    add(statics, x + y, () => {
      box(x - 0.05, y - 0.05, 0.1, 0.1, 64, '#5a606a', { edge: false });
      box(x - 0.14, y - 0.14, 0.28, 0.28, 6, '#3d424a', { z: 64 });
      const c = iso(x, y, 62);
      circle(c.x, c.y + 2, 3, '#fff3c4');
    }, iso(x, y), x < 0 || y < 0);
  }

  function chair(x, y, color = '#4a505b') {
    add(statics, x + y + 0.1, () => {
      box(x + 0.15, y + 0.15, 0.1, 0.1, 8, '#555b66', { edge: false });
      box(x, y, 0.4, 0.38, 4, color, { z: 8 });
      box(x, y - 0.02, 0.4, 0.08, 16, shade(color, 1.15), { z: 12 });
    });
  }

  function desk(d) {
    shadows.push({ x: d.x, y: d.y, w: DESK_W, d: DESK_D, h: 20 });
    chair(d.x + 0.78, d.y - 0.62);
    add(statics, d.x + DESK_W / 2 + d.y + DESK_D / 2, () => {
      const { x, y } = d;
      for (const [lx, ly] of [[0.04, 0.04], [DESK_W - 0.08, 0.04], [0.04, DESK_D - 0.08], [DESK_W - 0.08, DESK_D - 0.08]]) box(x + lx, y + ly, 0.05, 0.05, 15, '#9aa1ab', { edge: false });
      box(x, y, DESK_W, DESK_D, 3, '#f4f1ea', { z: 15 });
      poly(quad(x + 0.74, y + 0.08, x + 1.2, y + 0.22, 18.2), '#d7d9de');
      box(x + 0.9, y + 0.4, 0.1, 0.1, 6, '#ffffff', { z: 18, edge: false });
      poly(quad(x + 0.66, y + 0.34, x + 0.82, y + 0.5, 18.2), '#e9c46a');
    });
  }

  // drawn every frame: the screen shows the status of whoever sits there
  function monitor(d, status, t) {
    const { x, y } = d;
    box(x + 0.3, y + 0.14, 0.08, 0.06, 7, '#2a2d33', { z: 18, edge: false });
    box(x + 0.06, y + 0.1, 0.58, 0.06, 22, '#1d2026', { z: 24 });
    const flicker = status === 'working' && !reduceMotion ? 0.85 + 0.15 * Math.sin(t * 9 + x) : 1;
    g.globalAlpha = flicker;
    poly([iso(x + 0.09, y + 0.165, 44), iso(x + 0.61, y + 0.165, 44), iso(x + 0.61, y + 0.165, 27), iso(x + 0.09, y + 0.165, 27)], status ? mix(STATUS[status], '#ffffff', 0.25) : '#3a404b');
    g.globalAlpha = 1;
    if (status === 'working') {
      for (let i = 0; i < 3; i++) {
        const len = 0.18 + ((i * 7) % 3) * 0.07;
        poly([iso(x + 0.15, y + 0.166, 40 - i * 4), iso(x + 0.15 + len, y + 0.166, 40 - i * 4), iso(x + 0.15 + len, y + 0.166, 38.6 - i * 4), iso(x + 0.15, y + 0.166, 38.6 - i * 4)], 'rgba(255,255,255,0.55)');
      }
    }
  }

  function whiteboard(xa, xb, accent) {
    poly([iso(xa, 0.03, 60), iso(xb, 0.03, 60), iso(xb, 0.03, 30), iso(xa, 0.03, 30)], '#ffffff', '#b8bec8', 1.5);
    [0.4, 0.7, 0.5, 0.9, 0.6].forEach((v, i) => {
      const x = xa + 0.3 + i * 0.35;
      poly([iso(x, 0.031, 34), iso(x + 0.2, 0.031, 34), iso(x + 0.2, 0.031, 34 + v * 18), iso(x, 0.031, 34 + v * 18)], i === 3 ? accent : '#9fb3cc');
    });
    g.strokeStyle = '#d9534f';
    g.lineWidth = 1.5;
    line(iso(xa + 2.1, 0.031, 50), iso(xb - 0.2, 0.031, 56));
  }

  const city = createCity({
    iso, quad, poly, box, circle, line, hash, shade, mix, add, statics, shadows, person, tree, lamp,
    ctx: () => g,
    time: () => now,
    detail: () => view.scale * TW >= 22, // close enough to draw single windows and signs
    reduceMotion,
  });

  function canteenTable(tx, ty) {
    shadows.push({ x: tx, y: ty, w: 1.1, d: 1.0, h: 16 });
    add(statics, tx + 0.35 + 0.2 + ty - 0.55 + 0.17, () => box(tx + 0.35, ty - 0.55, 0.4, 0.35, 10, '#e07a5f', { top: '#ee8f73' }));
    add(statics, tx + 0.35 + 0.2 + ty + 1.15 + 0.17, () => box(tx + 0.35, ty + 1.15, 0.4, 0.35, 10, '#e07a5f', { top: '#ee8f73' }));
    add(statics, tx + 0.55 + ty + 0.5, () => {
      box(tx + 0.5, ty + 0.45, 0.1, 0.1, 14, '#9aa1ab', { edge: false });
      box(tx, ty, 1.1, 1.0, 3, '#f4f1ea', { z: 14, top: '#ffffff' });
      for (const [px, py, col] of [[0.3, 0.25, '#f2cc8f'], [0.75, 0.7, '#e9c46a']]) {
        const c = iso(tx + px, ty + py, 17.5);
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.ellipse(c.x, c.y, 7, 3.5, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = col;
        g.beginPath();
        g.ellipse(c.x, c.y, 4, 2, 0, 0, Math.PI * 2);
        g.fill();
      }
    });
  }

  function menuBoard() {
    poly([iso(0.01, 16, 70), iso(0.01, 19.6, 70), iso(0.01, 19.6, 44), iso(0.01, 16, 44)], '#2f4f3e', '#7a5a3c', 3);
    g.strokeStyle = '#f1e6c8';
    g.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      line(iso(0.012, 16.4, 64 - i * 5.5), iso(0.012, 18.0 + (i % 2) * 0.5, 64 - i * 5.5));
      line(iso(0.012, 18.9, 64 - i * 5.5), iso(0.012, 19.2, 64 - i * 5.5));
    }
  }

  function buildScene() {
    // app rooms
    for (const r of ROOMS) {
      const col = APP[r.app].color;
      for (const d of DESKS[r.app]) desk(d);
      addBox(r.x0 + 0.3, 0.02, 2.5, 0.38, 52, '#8a6a4c', { wall: true, shadow: false, after: (x, y, w, d, i) => shelfBooks('y', x, y, w, d, 52, r.app + i) });
      wallPieces.push({ d: -1, fn: () => whiteboard(r.x0 + 3.3, r.x0 + 6.2, col) });
      plant(r.x0 + 6.5, 0.55, 1, wallPieces);
      if (r.x1 < BW) addBox(r.x1 - 0.06, 0, 0.12, 7, 42, '#b9d6e8', { alpha: 0.45, shadow: false });
      const cx = (r.x0 + r.x1) / 2;
      addBox(r.x0 + 0.05, 6.94, cx - 1 - r.x0, 0.12, 42, '#b9d6e8', { alpha: 0.45, shadow: false, bias: 0.4 });
      addBox(cx + 1, 6.94, r.x1 - cx - 1.05, 0.12, 42, '#b9d6e8', { alpha: 0.45, shadow: false, bias: 0.4 });
      addBox(cx - 0.8, 6.3, 1.6, 0.42, 22, shade(col, 0.9), { top: '#f4f1ea' });
      plant(r.x0 + 0.5, 6.4, 0.8);
    }

    // lounge: kitchen on the wall, sofa, coffee table, high table
    addBox(0.02, 9.5, 0.62, 2.7, 30, '#e9e4da', { wall: true, top: '#cfc6b6' });
    wallPieces.push({ d: -1, fn: () => box(0.1, 9.75, 0.42, 0.42, 22, '#2c2f35', { z: 30 }) });
    wallPieces.push({ d: -1, fn: () => box(0.12, 10.6, 0.36, 0.5, 8, '#c94f3d', { z: 30 }) });
    addBox(0.02, 12.5, 0.72, 0.85, 66, '#e3e7ec', { wall: true });
    addBox(0.1, 13.7, 0.4, 0.4, 34, '#d6e7f2', { wall: true });
    for (let i = 0; i < 3; i++) {
      const sx = 1.4 + i * 1.1;
      addBox(sx, 10.3, 1.1, 0.28, 28, '#5d6fa8', { noSplit: true });
      addBox(sx, 10.58, 1.1, 0.62, 12, '#6f82bd', { noSplit: true, top: '#7d90cb', bias: -0.5 });
    }
    addBox(1.25, 10.3, 0.18, 0.95, 20, '#53639a', { noSplit: true });
    addBox(4.68, 10.3, 0.18, 0.95, 20, '#53639a', { noSplit: true });
    addBox(2.3, 11.85, 1.5, 0.7, 10, '#b88a5c', { noSplit: true, top: '#c99a6a' });
    add(statics, 3.05 + 12.2, () => box(2.9, 12.05, 0.14, 0.14, 5, '#ffffff', { z: 10, edge: false }));
    addBox(6.3, 11.9, 0.7, 0.7, 30, '#b88a5c', { noSplit: true, top: '#c99a6a' });
    plant(7.9, 9.7);
    plant(0.6, 14.5, 1.1);
    plant(4.6, 14.5);
    addBox(8.3, 9.7, 0.3, 4.9, 38, '#8a6a4c', { after: (x, y, w, d, i) => shelfBooks('x', x, y, w, d, 38, 'div' + i) });

    // shared room
    for (const d of DESKS.Chung) desk(d);
    addBox(9.4, 10.6, 2.4, 1.2, 15, '#f4f1ea', { top: '#ffffff' });
    for (const cx of [9.7, 10.6, 11.5]) {
      chair(cx, 10.05);
      chair(cx, 11.9);
    }
    plant(20.5, 9.8);
    plant(20.5, 14.4, 1.1);
    plant(11.6, 14.4);

    // glass partition between the front rooms and the canteen / director's office, with two doors
    const glassWall = { alpha: 0.45, shadow: false };
    addBox(0.1, 14.94, 5.0, 0.12, 34, '#b9d6e8', glassWall);
    addBox(6.7, 14.94, 8.2, 0.12, 34, '#b9d6e8', glassWall);
    addBox(16.3, 14.94, 4.55, 0.12, 34, '#b9d6e8', glassWall);
    addBox(12.14, 15.06, 0.12, 5.85, 34, '#b9d6e8', glassWall);

    // canteen: serving counter and menu on the wall, vending machines, tables with stools
    addBox(0.02, 15.7, 0.75, 4.6, 30, '#e9e4da', { wall: true, top: '#d8d2c4' });
    wallPieces.push({
      d: -1,
      fn: () => {
        const food = ['#e07a5f', '#f2cc8f', '#81b29a', '#e9c46a', '#d62828', '#90be6d'];
        food.forEach((c, i) => box(0.15, 15.9 + i * 0.72, 0.45, 0.5, 4, c, { z: 30, edge: false }));
        menuBoard();
      },
    });
    addBox(9.9, 15.35, 0.75, 0.55, 62, '#2f80d9', { noSplit: true });
    addBox(10.9, 15.35, 0.75, 0.55, 62, '#d62828', { noSplit: true });
    for (const t of CANTEEN_TABLES) canteenTable(t.x, t.y);
    plant(11.6, 20.4, 1.1);

    // director's office: bookshelf, trophy cabinet, big desk, guest chairs, sofa corner
    addBox(12.7, 15.4, 3.0, 0.42, 54, '#6b4a32', { after: (x, y, w, d, i) => shelfBooks('y', x, y, w, d, 54, 'dir' + i) });
    addBox(19.4, 15.4, 1.2, 0.42, 50, '#c9d6df', { alpha: 0.75, noSplit: true });
    add(statics, 17.35 + 0.27 + 16.3 + 0.05, () => {
      box(17.35, 16.35, 0.55, 0.45, 12, '#3b2a20', { z: 6 });
      box(17.35, 16.28, 0.55, 0.1, 30, '#4a3426', { z: 8 });
    });
    addBox(16.0, 17.2, 2.6, 0.95, 18, '#5a3825', {
      noSplit: true,
      top: '#6b452e',
      after: () => {
        box(16.15, 17.3, 0.6, 0.08, 20, '#1d2026', { z: 18 });
        poly([iso(16.18, 17.385, 36), iso(16.72, 17.385, 36), iso(16.72, 17.385, 22), iso(16.18, 17.385, 22)], '#9cc8e4');
        box(17.4, 17.9, 0.5, 0.12, 5, '#d4a84b', { z: 18 });
        box(18.2, 17.35, 0.1, 0.1, 18, '#3b3f46', { z: 18, edge: false });
        circle(iso(18.25, 17.4, 38).x, iso(18.25, 17.4, 38).y, 5, '#ffe7a3');
      },
    });
    chair(16.6, 18.55, '#7a2e3a');
    chair(17.9, 18.55, '#7a2e3a');
    addBox(12.35, 17.0, 0.3, 2.6, 26, '#3f4a63');
    addBox(12.65, 17.0, 0.6, 2.6, 12, '#4d5a78', { top: '#5a6888' });
    addBox(13.6, 17.6, 0.8, 1.4, 10, '#6b452e', { noSplit: true });
    plant(20.5, 16.1, 1.2);
    plant(20.5, 20.5, 1.1);

    // low outer walls (cut-away); the entrance is at the east end of the corridor
    const low = { top: '#f7f3ea', shadow: false, bias: 0.6 };
    addBox(0, 20.88, BW, 0.12, 12, '#ece6da', low);
    addBox(20.88, 0, 0.12, 7.2, 12, '#ece6da', low);
    addBox(20.88, 9.0, 0.12, 12, 12, '#ece6da', low);

    city.build();
  }

  // ---------- background cache: ground, floors, rugs, shadows, back walls ----------
  function drawGround() {
    city.drawGround();

    const plank = (x0, y0, x1, y1, a, b) => {
      for (let y = y0; y < y1; y += 0.5) poly(quad(x0, y, x1, Math.min(y1, y + 0.5)), Math.round(y * 2) % 2 ? a : b);
      g.strokeStyle = 'rgba(110,75,40,0.10)';
      g.lineWidth = 1;
      for (let y = y0; y < y1; y += 0.5) {
        for (let x = x0 + (Math.round(y * 2) % 2 ? 0.7 : 0); x < x1; x += 1.4) line(iso(x, y), iso(x, Math.min(y1, y + 0.5)));
      }
    };
    for (const r of ROOMS) plank(r.x0, 0, r.x1, 7, '#dcc29a', '#d5ba90');
    for (let x = 0; x < BW; x++) for (let y = 7; y < 9.2; y += 1.1) poly(quad(x, y, x + 1, Math.min(9.2, y + 1.1)), (x + Math.round(y)) % 2 ? '#ebe6dc' : '#e3ddd1');
    for (let i = 0; i < 10; i++) for (let j = 0; j < 7; j++) {
      const x = i * 0.85;
      const y = 9.2 + j * 0.85;
      poly(quad(x, y, Math.min(8.5, x + 0.85), Math.min(15, y + 0.85)), (i + j) % 2 ? '#efe8da' : '#dccfb6');
    }
    plank(8.5, 9.2, BW, 15, '#d2b48b', '#cbad83');
    for (let i = 0; i < 15; i++) for (let j = 0; j < 7; j++) {
      const x = i * 0.85;
      const y = 15 + j * 0.85;
      poly(quad(x, y, Math.min(12.2, x + 0.85), Math.min(BH, y + 0.85)), (i + j) % 2 ? '#e8f1ef' : '#cfe3df');
    }
    plank(12.2, 15, BW, BH, '#a0714d', '#986a47');
    poly(quad(20.2, 7.4, 21, 8.8), '#7c6a58');

    for (const r of ROOMS) {
      poly(quad(r.x0 + 0.35, 1.45, r.x1 - 0.35, 5.95), mix(APP[r.app].color, '#ffffff', 0.62));
      poly(quad(r.x0 + 0.5, 1.6, r.x1 - 0.5, 5.8), null, mix(APP[r.app].color, '#ffffff', 0.35), 2);
    }
    poly(quad(1.1, 10.1, 5.2, 13.8), '#c96f52');
    poly(quad(1.3, 10.3, 5.0, 13.6), null, '#e3a184', 2);
    poly(quad(12.3, 10.3, 19.2, 14.4), '#c9d3df');
    poly(quad(13.3, 16.2, 20.2, 20.4), '#7a2e3a');
    poly(quad(13.5, 16.4, 20.0, 20.2), null, '#d4a84b', 2);

    // soft shadows, light from the back-left
    g.fillStyle = 'rgba(40,30,20,0.13)';
    for (const s of shadows) {
      const k = Math.min(0.6, s.h / 70);
      poly([iso(s.x + 0.05, s.y + 0.05), iso(s.x + s.w + k, s.y + 0.05 + k * 0.4), iso(s.x + s.w + k, s.y + s.d + k), iso(s.x + 0.05 + k * 0.4, s.y + s.d + k)], 'rgba(40,30,20,0.13)');
    }
  }

  function drawWalls() {
    const wall = '#ece6da';
    box(-0.25, -0.25, 0.25, BH + 0.25, WALL_H, wall, { top: '#f8f5ee' });
    box(0, -0.25, BW, 0.25, WALL_H, wall, { top: '#f8f5ee' });
    poly([iso(0, 0, 5), iso(BW, 0, 5), iso(BW, 0, 0), iso(0, 0, 0)], '#d8cfbf');
    poly([iso(0, 0, 5), iso(0, BH, 5), iso(0, BH, 0), iso(0, 0, 0)], '#cfc5b3');
    const glass = (pts) => {
      const grad = g.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y);
      grad.addColorStop(0, '#a9d2ec');
      grad.addColorStop(0.55, '#7fb2d6');
      grad.addColorStop(1, '#9cc8e4');
      poly(pts, grad, '#9aa3ad', 2);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = 1.5;
      line({ x: (pts[0].x * 3 + pts[1].x) / 4, y: (pts[0].y * 3 + pts[1].y) / 4 + 6 }, { x: (pts[3].x * 3 + pts[2].x) / 4 + 6, y: (pts[3].y * 3 + pts[2].y) / 4 - 10 });
    };
    // windows on the back walls, leaving room for shelves and whiteboards
    for (const r of ROOMS) glass([iso(r.x0 + 3.1, 0, 72), iso(r.x0 + 6.4, 0, 72), iso(r.x0 + 6.4, 0, 64), iso(r.x0 + 3.1, 0, 64)]);
    for (let y = 1; y < BH - 1; y += 2.6) {
      if ((y > 8.8 && y < 14.2) || (y > 14.6 && y < 20.4)) continue; // kitchen and canteen counter
      glass([iso(0, y, 66), iso(0, y + 1.8, 66), iso(0, y + 1.8, 22), iso(0, y, 22)]);
    }
    for (const p of wallPieces) p.fn();
  }

  function buildBackground() {
    const key = `${canvas.width}x${canvas.height}|${view.scale.toFixed(4)}|${view.ox.toFixed(1)}|${view.oy.toFixed(1)}`;
    if (key === bgKey) return;
    bgKey = key;
    const world = [view.dpr * view.scale, 0, 0, view.dpr * view.scale, view.dpr * view.ox, view.dpr * view.oy];
    bg.width = walls.width = canvas.width;
    bg.height = walls.height = canvas.height;
    g = bgctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#7aa55c'; // countryside beyond the edge of the city
    g.fillRect(0, 0, bg.width, bg.height);
    g.setTransform(...world);
    drawGround();
    g = wallsctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, walls.width, walls.height);
    g.setTransform(...world);
    drawWalls();
    g = ctx;
  }

  // ---------- people ----------
  function person(p, o) {
    const s = o.scale ?? 1;
    const h = hash(o.seed);
    const t = o.t;
    const y0 = p.y - (o.bob ?? 0);
    const skin = SKIN[h % SKIN.length];
    const hair = HAIR[(h >> 4) % HAIR.length];
    const pants = PANTS[(h >> 8) % PANTS.length];
    const style = (h >> 12) % 5;

    if (o.ring) {
      g.strokeStyle = o.ring;
      g.lineWidth = 2.5;
      g.beginPath();
      g.ellipse(p.x, p.y, 15 * s, 7 * s, 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = 'rgba(30,25,20,0.25)';
    g.beginPath();
    g.ellipse(p.x, p.y, 10 * s, 4.5 * s, 0, 0, Math.PI * 2);
    g.fill();

    if (!o.sitting) {
      const swing = o.walking ? Math.sin(t * 11) * 3 * s : 0;
      g.fillStyle = pants;
      g.beginPath();
      g.roundRect(p.x - 5 * s, y0 - 17 * s, 4.2 * s, 15 * s + swing, 2 * s);
      g.roundRect(p.x + 0.8 * s, y0 - 17 * s, 4.2 * s, 15 * s - swing, 2 * s);
      g.fill();
      g.fillStyle = '#2a2a2e';
      g.beginPath();
      g.ellipse(p.x - 3 * s, y0 - 2 * s + swing, 3 * s, 1.8 * s, 0, 0, Math.PI * 2);
      g.ellipse(p.x + 3 * s, y0 - 2 * s - swing, 3 * s, 1.8 * s, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillStyle = pants;
      g.beginPath();
      g.roundRect(p.x - 6 * s, y0 - 17 * s, 12 * s, 7 * s, 3 * s);
      g.fill();
    }
    const top = o.sitting ? y0 - 12 * s : y0;
    // torso with a darker right half
    g.fillStyle = o.shirt;
    g.beginPath();
    g.moveTo(p.x - 8 * s, top - 33 * s);
    g.quadraticCurveTo(p.x, top - 37 * s, p.x + 8 * s, top - 33 * s);
    g.lineTo(p.x + 7 * s, top - 15 * s);
    g.quadraticCurveTo(p.x, top - 13 * s, p.x - 7 * s, top - 15 * s);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.beginPath();
    g.moveTo(p.x + 1 * s, top - 35.5 * s);
    g.quadraticCurveTo(p.x + 5 * s, top - 35 * s, p.x + 8 * s, top - 33 * s);
    g.lineTo(p.x + 7 * s, top - 15 * s);
    g.quadraticCurveTo(p.x + 4 * s, top - 13.6 * s, p.x + 1 * s, top - 13.3 * s);
    g.closePath();
    g.fill();
    if (o.tie) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(p.x - 3.5 * s, top - 35.5 * s);
      g.lineTo(p.x + 3.5 * s, top - 35.5 * s);
      g.lineTo(p.x, top - 29 * s);
      g.closePath();
      g.fill();
      g.fillStyle = '#c0392b';
      g.fillRect(p.x - 1.2 * s, top - 32 * s, 2.4 * s, 12 * s);
    }
    // arms and hands
    const type = o.typing ? Math.sin(t * 16 + (h % 9)) * 1.6 * s : 0;
    g.fillStyle = shade(o.shirt, 0.9);
    g.beginPath();
    if (o.typing) {
      g.roundRect(p.x - 10.5 * s, top - 32 * s, 4 * s, 12 * s, 2 * s);
      g.roundRect(p.x + 6.5 * s, top - 32 * s, 4 * s, 12 * s, 2 * s);
    } else {
      const sw = o.walking ? Math.sin(t * 11) * 2 * s : 0;
      g.roundRect(p.x - 11 * s, top - 32 * s + sw, 4 * s, 15 * s, 2 * s);
      g.roundRect(p.x + 7 * s, top - 32 * s - sw, 4 * s, 15 * s, 2 * s);
    }
    g.fill();
    if (o.typing) {
      circle(p.x - 7 * s, top - 19 * s + type, 2.4 * s, skin);
      circle(p.x + 7 * s, top - 19 * s - type, 2.4 * s, skin);
    } else {
      circle(p.x - 9 * s, top - 16 * s, 2.4 * s, skin);
      circle(p.x + 9 * s, top - 16 * s, 2.4 * s, skin);
    }
    // neck and head
    g.fillStyle = skin;
    g.fillRect(p.x - 2 * s, top - 38 * s, 4 * s, 4 * s);
    const hy = top - 45 * s;
    if (style === 1) {
      g.fillStyle = hair;
      g.beginPath();
      g.roundRect(p.x - 9.5 * s, hy - 4 * s, 19 * s, 17 * s, 6 * s);
      g.fill();
    }
    circle(p.x, hy, 8.5 * s, skin);
    circle(p.x - 8.3 * s, hy + 1 * s, 2 * s, skin);
    circle(p.x + 8.3 * s, hy + 1 * s, 2 * s, skin);
    if (o.helmet) {
      g.fillStyle = o.helmet;
      g.beginPath();
      g.arc(p.x, hy - 0.5 * s, 10 * s, Math.PI * 0.95, Math.PI * 2.05);
      g.fill();
    } else if (style === 3) {
      g.fillStyle = shade(o.shirt, 0.7);
      g.beginPath();
      g.arc(p.x, hy - 1 * s, 9 * s, Math.PI, 0);
      g.fill();
      g.fillRect(p.x - 2 * s, hy - 2 * s, 12 * s, 2.5 * s);
    } else {
      g.fillStyle = hair;
      g.beginPath();
      g.arc(p.x, hy - 1.2 * s, 9 * s, Math.PI * 1.05, Math.PI * 1.95);
      g.quadraticCurveTo(p.x + 3 * s, hy - 5 * s, p.x - 8.6 * s, hy - 1 * s);
      g.fill();
      if (style === 2) circle(p.x, hy - 10.5 * s, 4 * s, hair);
      if (style === 4) {
        g.fillRect(p.x - 9 * s, hy - 3 * s, 2.5 * s, 6 * s);
        g.fillRect(p.x + 6.5 * s, hy - 3 * s, 2.5 * s, 6 * s);
      }
    }
    g.fillStyle = '#2b2220';
    g.beginPath();
    g.ellipse(p.x - 3 * s, hy + 1.5 * s, 1.1 * s, 1.5 * s, 0, 0, Math.PI * 2);
    g.ellipse(p.x + 3 * s, hy + 1.5 * s, 1.1 * s, 1.5 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(230,110,100,0.35)';
    g.beginPath();
    g.ellipse(p.x - 5 * s, hy + 4 * s, 1.8 * s, 1 * s, 0, 0, Math.PI * 2);
    g.ellipse(p.x + 5 * s, hy + 4 * s, 1.8 * s, 1 * s, 0, 0, Math.PI * 2);
    g.fill();
  }

  // ---------- sessions → places ----------
  function assignSpots() {
    const live = new Set(sessions.map((s) => s.key));
    for (const k of [...deskOf.keys()]) if (!live.has(k)) deskOf.delete(k);
    for (const k of [...actors.keys()]) if (!live.has(k)) actors.delete(k);
    const taken = (room, i) => [...deskOf.values()].some((d) => d.room === room && d.i === i);
    let lounge = 0;
    let stand = 0;
    for (const s of sessions) {
      const want = roomForSession(s, tasks);
      let d = deskOf.get(s.key);
      if (!d || d.want !== want) {
        d = null;
        for (const room of [want, 'Chung']) {
          const i = DESKS[room].findIndex((_, j) => !taken(room, j));
          if (i >= 0) {
            d = { room, i, want };
            break;
          }
        }
        if (d) deskOf.set(s.key, d);
      }
      let target;
      if (s.status === 'idle') target = LOUNGE_SPOTS[lounge++ % LOUNGE_SPOTS.length];
      else if (d) target = { ...seatOf(DESKS[d.room][d.i]), sit: true };
      else target = { x: 10 + (stand++ % 8) * 0.8, y: 8.6 };
      const room = d?.room ?? want;
      const a = actors.get(s.key);
      if (!a) actors.set(s.key, { x: target.x, y: target.y, tx: target.x, ty: target.y, sit: target.sit, s, room });
      else Object.assign(a, { tx: target.x, ty: target.y, sit: target.sit, s, room });
    }
  }

  // ---------- frame ----------
  function paint(ts) {
    const t = ts / 1000;
    now = t;
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    let moving = false;
    for (const a of actors.values()) {
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const dist = Math.hypot(dx, dy);
      const step = reduceMotion ? dist : 3 * dt;
      if (dist > 0.01) {
        moving = true;
        a.walking = dist > step;
        if (dist <= step) {
          a.x = a.tx;
          a.y = a.ty;
        } else {
          a.x += (dx / dist) * step;
          a.y += (dy / dist) * step;
        }
      } else a.walking = false;
    }

    buildBackground();
    const { dpr, scale, ox, oy } = view;
    g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bg, 0, 0);
    g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const list = [...statics];
    for (const [room, desks] of Object.entries(DESKS)) {
      desks.forEach((d, i) => {
        const occ = [...actors.values()].find((a) => {
          const dd = deskOf.get(a.s.key);
          return dd && dd.room === room && dd.i === i && a.s.status !== 'idle' && !a.walking;
        });
        add(list, d.x + DESK_W / 2 + d.y + DESK_D / 2 + 0.01, () => monitor(d, occ?.s.status, t));
      });
    }

    if (!reduceMotion) city.addMoving(list, t);

    // customers queuing outside each app room: its Todo tasks, urgent first
    const labels = [];
    const bodies = []; // people on screen: labels keep clear of them
    for (const r of ROOMS) {
      const q = tasks.filter((x) => x.app === r.app);
      const urgent = q.filter((x) => x.priority === 'Urgent');
      const shown = [...urgent, ...q.filter((x) => x.priority !== 'Urgent')].slice(0, 7);
      shown.forEach((task, i) => {
        const gx = (r.x0 + r.x1) / 2 + 0.2 - i * 0.62;
        const gy = 7.75 + (i % 2) * 0.35;
        const head = toScreen(iso(gx, gy, 50));
        const feet = toScreen(iso(gx, gy));
        bodies.push({ x0: feet.x - 9 * scale, x1: feet.x + 9 * scale, y0: head.y, y1: feet.y });
        add(list, gx + gy, () =>
          person(iso(gx, gy), {
            shirt: task.priority === 'Urgent' ? '#e05a4f' : ['#8fa3bf', '#b3a48f', '#9db89a', '#c49aa4'][hash(task.key) % 4],
            seed: task.key,
            t,
            scale: 0.82,
            bob: reduceMotion ? 0 : Math.max(0, Math.sin(t * 2 + i)) * 0.8,
          }),
        );
      });
      const c = (r.x0 + r.x1) / 2;
      labels.push({ kind: 'sign', p: toScreen(iso(c, 0, WALL_H - 8)), text: APP[r.app].name, color: APP[r.app].color });
      labels.push({
        kind: 'queue',
        p: toScreen(iso(c + 1.6, 8.9)),
        text: q.length ? `${q.length} task Todo${urgent.length ? ` · ${urgent.length} urgent` : ''}` : 'Không có task Todo',
        color: urgent.length ? '#ff8a80' : '#e7e9ee',
      });
    }
    labels.push({ kind: 'note', p: toScreen(iso(4.2, 14.4)), text: 'Phòng nghỉ', color: '#e7e9ee' });
    labels.push({ kind: 'note', p: toScreen(iso(15.5, 14.6)), text: 'Phòng chung', color: APP.Chung.color });
    labels.push({ kind: 'note', p: toScreen(iso(6, 20.6)), text: 'Căn tin', color: '#e7e9ee' });
    labels.push({ kind: 'note', p: toScreen(iso(14.6, 20.6)), text: 'Phòng giám đốc', color: '#d4a84b' });

    // the director (you): shows how many sessions wait for your approval
    const waitingCount = sessions.filter((s) => s.status === 'waiting').length;
    add(list, DIRECTOR.x + DIRECTOR.y + 0.02, () => person(iso(DIRECTOR.x, DIRECTOR.y), { shirt: '#2c3e66', seed: 'director', t, sitting: true, tie: true }));
    {
      const head = toScreen(iso(DIRECTOR.x, DIRECTOR.y, 70));
      const feet = toScreen(iso(DIRECTOR.x, DIRECTOR.y));
      bodies.push({ x0: feet.x - 11 * scale, x1: feet.x + 11 * scale, y0: head.y - 2, y1: feet.y - 14 * scale });
      labels.push({ kind: 'director', p: head, waiting: waitingCount, t });
    }

    // sessions
    hits = [];
    const showAction = sessions.filter((s) => s.status === 'working').length <= 3;
    for (const a of actors.values()) {
      const s = a.s;
      const seated = a.sit && !a.walking;
      const room = APP[a.room] ? a.room : 'Chung';
      const isHover = hover && hover.key === s.key;
      const isSel = selected === s.key;
      add(list, a.x + a.y + 0.02, () => {
        person(iso(a.x, a.y), {
          shirt: APP[room].color,
          seed: s.key,
          t,
          sitting: seated,
          typing: seated && s.status === 'working' && !reduceMotion,
          walking: a.walking && !reduceMotion,
          bob: s.status === 'idle' && !reduceMotion && !seated ? Math.sin(t * 1.5 + (hash(s.key) % 5)) * 0.8 : 0,
          ring: isSel ? '#ffffff' : isHover ? STATUS[s.status] : null,
        });
        for (let i = 0; i < Math.min(3, s.subagents || 0); i++) {
          person(iso(a.x + 0.85 + i * 0.42, a.y + 0.45), { shirt: mix(APP[room].color, '#ffffff', 0.35), seed: s.key + i, t, scale: 0.68, bob: reduceMotion ? 0 : Math.abs(Math.sin(t * 3 + i)) * 1.2 });
        }
      });
      const head = toScreen(iso(a.x, a.y, seated ? 70 : 58));
      const feet = toScreen(iso(a.x, a.y));
      hits.push({ s, x0: feet.x - 16 * scale - 4, x1: feet.x + 16 * scale + 4, y0: head.y - 4, y1: feet.y + 6 });
      bodies.push({ x0: feet.x - 11 * scale, x1: feet.x + 11 * scale, y0: head.y - 2, y1: feet.y - (seated ? 14 * scale : 0) });
      labels.push({ kind: 'session', p: head, s, t, action: s.status === 'waiting' || (s.status === 'working' && (showAction || isHover || isSel)) });
    }

    list.sort((a, b) => a.d - b.d);
    const drawAll = (items) => {
      for (const item of items) {
        if (item.pt) {
          const sp = toScreen(item.pt);
          if (sp.x < -600 || sp.x > view.w + 600 || sp.y < -400 || sp.y > view.h + 900) continue;
        }
        item.fn();
      }
    };
    drawAll(list.filter((i) => i.back));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(walls, 0, 0);
    g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    drawAll(list.filter((i) => !i.back));

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    placed = [...bodies];
    const order = { session: 0, director: 0.5, sign: 1, queue: 2, note: 3 };
    labels.sort((a, b) => order[a.kind] - order[b.kind]);
    // zoomed far out: only what needs you (sessions waiting for approval, and the director)
    const compact = cam.zoom < 0.65;
    for (const l of labels) {
      if (compact && l.kind !== 'director' && !(l.kind === 'session' && l.s.status === 'waiting')) continue;
      if (l.p.x < -20 || l.p.x > view.w + 20 || l.p.y < -20 || l.p.y > view.h + 60) continue; // its owner is off screen
      if (l.kind === 'session') sessionLabel(l);
      else if (l.kind === 'director') directorLabel(l);
      else simpleLabel(l);
    }
    return moving || !reduceMotion;
  }

  // ---------- labels (screen px) ----------
  function measure(str, font) {
    g.font = font;
    return g.measureText(str).width;
  }
  // Reserve a screen rect. Try it where it is, then nudged up and down; keep it inside the canvas.
  // Returns the offset used, or null when it may not move and is covered.
  function place(r, canMove) {
    const pad = 6;
    const dx = clamp(0, pad - r.x0, view.w - pad - r.x1);
    const covered = (dy) => placed.some((p) => r.x0 + dx < p.x1 && r.x1 + dx > p.x0 && r.y0 + dy < p.y1 && r.y1 + dy > p.y0);
    const inside = (dy) => r.y0 + dy >= pad && r.y1 + dy <= view.h - pad;
    const tries = [0];
    if (canMove) for (let k = 8; k <= 120; k += 8) tries.push(-k, k);
    let dy = tries.find((v) => inside(v) && !covered(v));
    if (dy === undefined) {
      if (!canMove) return null;
      dy = clamp(0, pad - r.y0, view.h - pad - r.y1);
    }
    placed.push({ x0: r.x0 + dx - 3, x1: r.x1 + dx + 3, y0: r.y0 + dy - 3, y1: r.y1 + dy + 3 });
    return { dx, dy };
  }
  function roundRect(x, y, w, h, r, fill, stroke, lw = 1) {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = lw;
      g.stroke();
    }
  }
  function text(str, x, y, font, color, align = 'left') {
    g.font = font;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(str, x, y);
  }
  function fitText(str, font, max) {
    if (measure(str, font) <= max) return str;
    let s = str;
    while (s.length > 1 && measure(s + '…', font) > max) s = s.slice(0, -1);
    return s + '…';
  }

  const F = {
    name: '600 12px system-ui, "Segoe UI", sans-serif',
    small: '500 11px system-ui, "Segoe UI", sans-serif',
    task: '500 10px ui-monospace, Consolas, monospace',
    act: '500 12px system-ui, "Segoe UI", sans-serif',
  };

  function simpleLabel(l) {
    const isSign = l.kind === 'sign';
    const font = isSign ? F.name : F.small;
    const w = measure(l.text, font) + (isSign ? 28 : 16);
    const h = isSign ? 24 : 20;
    const at = place({ x0: l.p.x - w / 2, x1: l.p.x + w / 2, y0: l.p.y - h / 2, y1: l.p.y + h / 2 }, l.kind !== 'note');
    if (!at) return;
    const x = l.p.x + at.dx;
    const y = l.p.y + at.dy;
    roundRect(x - w / 2, y - h / 2, w, h, h / 2, 'rgba(17,20,26,0.88)', isSign ? l.color : null, 1.5);
    if (isSign) circle(x - w / 2 + 12, y, 4, l.color);
    text(l.text, x - w / 2 + (isSign ? 21 : 8), y + 0.5, font, isSign ? '#ffffff' : l.color);
  }

  function icon(kind, cx, cy, color) {
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    switch (kind) {
      case 'term':
        g.moveTo(cx - 5, cy - 3);
        g.lineTo(cx - 2, cy);
        g.lineTo(cx - 5, cy + 3);
        g.moveTo(cx, cy + 3.5);
        g.lineTo(cx + 5, cy + 3.5);
        break;
      case 'doc':
        g.rect(cx - 4, cy - 5, 8, 10);
        g.moveTo(cx - 2, cy - 1.5);
        g.lineTo(cx + 2, cy - 1.5);
        g.moveTo(cx - 2, cy + 1.5);
        g.lineTo(cx + 2, cy + 1.5);
        break;
      case 'edit':
        g.moveTo(cx - 4.5, cy + 4.5);
        g.lineTo(cx - 3.5, cy + 1.5);
        g.lineTo(cx + 3, cy - 5);
        g.lineTo(cx + 5, cy - 3);
        g.lineTo(cx - 1.5, cy + 3.5);
        g.closePath();
        break;
      case 'search':
        g.arc(cx - 1, cy - 1, 3.6, 0, Math.PI * 2);
        g.moveTo(cx + 1.8, cy + 1.8);
        g.lineTo(cx + 5, cy + 5);
        break;
      case 'agent':
        g.arc(cx - 2.5, cy - 1.5, 2.2, 0, Math.PI * 2);
        g.moveTo(cx + 5, cy - 1.5);
        g.arc(cx + 2.8, cy - 1.5, 2.2, 0, Math.PI * 2);
        g.moveTo(cx - 6, cy + 5);
        g.quadraticCurveTo(cx - 2.5, cy + 0.5, cx + 1, cy + 5);
        g.moveTo(cx - 0.5, cy + 5);
        g.quadraticCurveTo(cx + 2.8, cy + 0.5, cx + 6, cy + 5);
        break;
      case 'web':
        g.arc(cx, cy, 5, 0, Math.PI * 2);
        g.moveTo(cx - 5, cy);
        g.lineTo(cx + 5, cy);
        g.moveTo(cx, cy - 5);
        g.quadraticCurveTo(cx + 4, cy, cx, cy + 5);
        g.quadraticCurveTo(cx - 4, cy, cx, cy - 5);
        break;
      case 'warn':
        g.moveTo(cx, cy - 5.5);
        g.lineTo(cx + 6, cy + 4.5);
        g.lineTo(cx - 6, cy + 4.5);
        g.closePath();
        g.moveTo(cx, cy - 1.5);
        g.lineTo(cx, cy + 1);
        g.moveTo(cx, cy + 3);
        g.lineTo(cx, cy + 3.1);
        break;
      default:
        g.moveTo(cx, cy - 5);
        g.lineTo(cx + 1.5, cy - 1.5);
        g.lineTo(cx + 5, cy);
        g.lineTo(cx + 1.5, cy + 1.5);
        g.lineTo(cx, cy + 5);
        g.lineTo(cx - 1.5, cy + 1.5);
        g.lineTo(cx - 5, cy);
        g.lineTo(cx - 1.5, cy - 1.5);
        g.closePath();
    }
    g.stroke();
    g.lineCap = 'butt';
  }

  // Name tag (status dot, project, helpers), task key, and an action card for working/waiting sessions.
  function sessionLabel(l) {
    const s = l.s;
    const color = STATUS[s.status] ?? STATUS.idle;
    const name = s.machine ? `${s.project} · ${s.machine}` : s.project;
    const helpers = s.subagents > 0 ? `${s.subagents} trợ lý` : '';
    const nameW = measure(name, F.name) + 30 + (helpers ? measure(helpers, F.small) + 10 : 0);
    const tagH = 24;
    let card = null;
    if (l.action) {
      const waiting = s.status === 'waiting';
      const raw = waiting ? `Chờ duyệt: ${s.waitingFor || 'cần bạn cho phép'}` : s.lastAction || s.prompt || 'Đang làm';
      const str = fitText(raw, F.act, 210);
      card = { str, w: measure(str, F.act) + 46, h: 34, waiting, kind: waiting ? 'warn' : actionIcon(raw) };
    }
    const taskH = s.task ? 17 : 0;
    const width = Math.max(nameW, card?.w ?? 0, s.task ? measure(s.task, F.task) + 12 : 0);
    const total = tagH + (taskH ? taskH + 3 : 0) + (card ? card.h + 8 : 0);
    const base = l.p.y - 6;
    const at = place({ x0: l.p.x - width / 2, x1: l.p.x + width / 2, y0: base - total, y1: base }, true);
    const cx = l.p.x + at.dx;
    const by = base + at.dy;
    if (Math.abs(at.dy) > 4 || Math.abs(at.dx) > 4) {
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1;
      line({ x: l.p.x, y: l.p.y }, { x: cx, y: at.dy > 0 ? by - total : by });
    }
    let y = by - tagH;
    roundRect(cx - nameW / 2, y, nameW, tagH, tagH / 2, 'rgba(17,20,26,0.9)', color, 1.5);
    circle(cx - nameW / 2 + 12, y + tagH / 2, 4, color);
    text(name, cx - nameW / 2 + 21, y + tagH / 2 + 0.5, F.name, '#ffffff');
    if (helpers) text(helpers, cx + nameW / 2 - 10, y + tagH / 2 + 0.5, F.small, '#8fb8ff', 'right');
    if (s.task) {
      y -= taskH + 3;
      const tw = measure(s.task, F.task) + 12;
      roundRect(cx - tw / 2, y, tw, taskH, 5, 'rgba(17,20,26,0.82)');
      text(s.task, cx, y + taskH / 2 + 0.5, F.task, '#b8c0cf', 'center');
    }
    if (card) {
      const bounce = card.waiting && !reduceMotion ? Math.abs(Math.sin(l.t * 3.5)) * 3 : 0;
      y -= card.h + 5 + bounce;
      const x = cx - card.w / 2;
      const accent = card.waiting ? STATUS.waiting : STATUS.working;
      roundRect(x, y, card.w, card.h, 9, card.waiting ? 'rgba(46,36,18,0.95)' : 'rgba(17,20,26,0.92)', accent, card.waiting ? 2 : 1.5);
      roundRect(x + 7, y + 6, 22, 22, 6, card.waiting ? accent : 'rgba(53,179,122,0.18)');
      icon(card.kind, x + 18, y + 17, card.waiting ? '#2a1d05' : accent);
      text(card.str, x + 37, y + card.h / 2 + 0.5, F.act, '#ffffff');
    }
  }

  function directorLabel(l) {
    const name = 'Giám đốc · bạn';
    const msg = l.waiting ? `${l.waiting} phiên chờ bạn duyệt` : 'Mọi việc ổn';
    const nameW = measure(name, F.name) + 30;
    const msgW = measure(msg, F.small) + 20;
    const total = 24 + 4 + 22;
    const width = Math.max(nameW, msgW);
    const base = l.p.y - 6;
    const at = place({ x0: l.p.x - width / 2, x1: l.p.x + width / 2, y0: base - total, y1: base }, true);
    const cx = l.p.x + at.dx;
    let y = base + at.dy - 24;
    roundRect(cx - nameW / 2, y, nameW, 24, 12, 'rgba(17,20,26,0.92)', '#d4a84b', 1.5);
    circle(cx - nameW / 2 + 12, y + 12, 4, '#d4a84b');
    text(name, cx - nameW / 2 + 21, y + 12.5, F.name, '#ffffff');
    const bounce = l.waiting && !reduceMotion ? Math.abs(Math.sin(l.t * 3)) * 2 : 0;
    y -= 26 + bounce;
    roundRect(cx - msgW / 2, y, msgW, 22, 11, l.waiting ? STATUS.waiting : 'rgba(53,179,122,0.9)');
    text(msg, cx, y + 11.5, F.small, l.waiting ? '#2a1d05' : '#ffffff', 'center');
  }

  // ---------- loop (about 30 fps) ----------
  function frame(now) {
    raf = 0;
    if (now - lastPaint < 32) {
      raf = requestAnimationFrame(frame);
      return;
    }
    lastPaint = now;
    if (paint(now)) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  // ---------- input: hover, click, drag to pan, wheel / pinch to zoom ----------
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pick = (p) => {
    let best = null;
    for (const hb of hits) if (p.x >= hb.x0 && p.x <= hb.x1 && p.y >= hb.y0 && p.y <= hb.y1) best = hb;
    return best;
  };

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { start: local(e), panX: cam.panX, panY: cam.panY, moved: false };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: cam.zoom };
      drag = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (drag) {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        cam.panX = drag.panX + dx;
        cam.panY = drag.panY + dy;
        computeView();
        canvas.style.cursor = 'grabbing';
        kick();
      }
      return;
    }
    const hb = pick(p);
    if ((hb?.s.key ?? null) !== (hover?.key ?? null)) {
      hover = hb?.s ?? null;
      kick();
    }
    canvas.style.cursor = hb ? 'pointer' : 'grab';
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (drag && !drag.moved && e.type === 'pointerup') {
      const p = local(e);
      const hb = pick(p);
      selected = hb?.s.key ?? null;
      onSelect?.(hb?.s ?? null, p);
      kick();
    }
    if (pointers.size < 2) pinch = null;
    drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(cam.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    },
    { passive: false },
  );

  buildScene();
  new ResizeObserver(resize).observe(canvas.parentElement);
  document.addEventListener('fullscreenchange', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else kick();
  });

  return {
    update(next) {
      sessions = next.sessions.filter((s) => s.status !== 'ended');
      tasks = next.tasks;
      if (selected && !sessions.some((s) => s.key === selected)) selected = null;
      assignSpots();
      kick();
    },
    deselect() {
      selected = null;
      kick();
    },
    zoomBy(f) {
      zoomAt(cam.zoom * f, view.w / 2, view.h / 2);
    },
    fit() {
      Object.assign(cam, { zoom: 1, panX: 0, panY: 0 });
      computeView();
      kick();
    },
    snapshot: () => canvas.toDataURL('image/png'),
  };
}
