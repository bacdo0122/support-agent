// The city around the office, on all four sides: a grid of roads, neighbouring blocks, a stadium, a park,
// traffic and people on the sidewalks. Drawing goes through the toolkit `k` that office.js passes in.
// The office block is [0, 21] × [0, 21]; anything with x < 0 or y < 0 is "behind" it and is drawn before its walls.

export const LO = -36; // world extent in tiles, both axes
export const HI = 62;

// Roads: 'x' runs along x at y ∈ [c, c+3]; 'y' runs along y at x ∈ [c, c+3].
const CROSS = [-20, -4, 22, 38];
const ROADS = CROSS.flatMap((c) => [{ axis: 'x', c0: c, c1: c + 3 }, { axis: 'y', c0: c, c1: c + 3 }]);
const SPANS = [[LO, -20], [-17, -4], [-1, 22], [25, 38], [41, HI]]; // blocks between the roads
const OFFICE = [2, 2]; // index of the office's block in SPANS × SPANS

const KINDS = {
  car: { len: 1.5, wid: 0.8, h: 17 },
  taxi: { len: 1.5, wid: 0.8, h: 17 },
  police: { len: 1.6, wid: 0.8, h: 17 },
  ambulance: { len: 2.0, wid: 0.9, h: 28 },
  bus: { len: 3.1, wid: 0.95, h: 34 },
  truck: { len: 2.7, wid: 0.95, h: 30 },
  van: { len: 1.8, wid: 0.85, h: 25 },
  moto: { len: 0.8, wid: 0.3, h: 9 },
  bike: { len: 0.75, wid: 0.22, h: 8 },
};
const road = (axis, c0) => ROADS.find((r) => r.axis === axis && r.c0 === c0);

// road, lane (+1 near side going forward, -1 far side going back), kind, colour, speed (tiles/s), phase
const TRAFFIC = [
  // in front and to the right of the office
  [road('x', 22), 1, 'bus', '#d9483b', 1.3, 0], [road('x', 22), -1, 'car', '#f1f1f1', 2.1, 31], [road('x', 22), 1, 'taxi', '#f5c542', 1.9, 49],
  [road('x', 22), -1, 'truck', '#e9edf2', 1.4, 70], [road('x', 22), 1, 'moto', '#2f3a4f', 2.6, 87], [road('x', 22), -1, 'police', '#f5f7fa', 2.3, 14],
  [road('y', 22), 1, 'bus', '#d9483b', 1.2, 38], [road('y', 22), -1, 'taxi', '#f5c542', 2.0, 3], [road('y', 22), 1, 'car', '#56606e', 1.7, 60],
  [road('y', 22), -1, 'ambulance', '#ffffff', 2.2, 78], [road('y', 22), 1, 'moto', '#8e44ad', 2.5, 96], [road('y', 22), -1, 'truck', '#f0ad4e', 1.3, 25],
  [road('x', 38), 1, 'van', '#4d8fe8', 1.6, 5], [road('x', 38), -1, 'car', '#c0392b', 2.0, 51], [road('x', 38), 1, 'bike', '#2fa89a', 0.9, 33],
  [road('y', 38), 1, 'car', '#3c6fd1', 1.9, 2], [road('y', 38), -1, 'van', '#e9e4da', 1.5, 46], [road('y', 38), 1, 'bike', '#e05a4f', 1.0, 67],
  // behind and to the left of the office
  [road('x', -4), 1, 'car', '#2e8b57', 1.8, 12], [road('x', -4), -1, 'bus', '#2f80d9', 1.2, 55], [road('x', -4), 1, 'taxi', '#f5c542', 2.0, 80],
  [road('x', -4), -1, 'moto', '#d35400', 2.4, 35],
  [road('y', -4), 1, 'truck', '#e9edf2', 1.3, 20], [road('y', -4), -1, 'car', '#7f8c8d', 2.0, 64], [road('y', -4), 1, 'police', '#f5f7fa', 2.2, 90],
  [road('y', -4), -1, 'bike', '#27ae60', 0.9, 44],
  [road('x', -20), 1, 'van', '#c0392b', 1.6, 18], [road('x', -20), -1, 'car', '#f1f1f1', 2.0, 72],
  [road('y', -20), 1, 'bus', '#d9483b', 1.2, 40], [road('y', -20), -1, 'car', '#3c6fd1', 1.9, 8],
].map(([r, lane, kind, color, speed, off]) => ({ road: r, lane, kind, color, speed, off, ...KINDS[kind] }));

// sidewalk walkers: along x at y, or along y at x, between a and b
const WALKERS = [
  { axis: 'x', at: 21.55, a: 1, b: 20.5, speed: 0.6, off: 0, shirt: '#e07a5f' },
  { axis: 'x', at: 21.7, a: 2, b: 20, speed: 0.5, off: 9, shirt: '#3d5a80' },
  { axis: 'y', at: 21.55, a: 10, b: 20.5, speed: 0.55, off: 4, shirt: '#81b29a' },
  { axis: 'x', at: 25.5, a: 1, b: 21, speed: 0.45, off: 2, shirt: '#f2cc8f' },
  { axis: 'y', at: 25.5, a: 1, b: 21, speed: 0.6, off: 7, shirt: '#b56576' },
  { axis: 'y', at: 37.5, a: 2, b: 21, speed: 0.5, off: 5, shirt: '#6d597a' },
  { axis: 'x', at: 37.5, a: 26, b: 37, speed: 0.55, off: 3, shirt: '#457b9d' },
  { axis: 'x', at: -0.55, a: 1, b: 20, speed: 0.5, off: 6, shirt: '#e63946' },
  { axis: 'y', at: -0.55, a: 1, b: 20, speed: 0.45, off: 1, shirt: '#2a9d8f' },
  { axis: 'x', at: -4.5, a: -16, b: -5, speed: 0.5, off: 8, shirt: '#f4a261' },
  { axis: 'y', at: -4.5, a: 1, b: 20, speed: 0.55, off: 13, shirt: '#264653' },
  { axis: 'x', at: -17.5, a: 1, b: 21, speed: 0.5, off: 4, shirt: '#9b5de5' },
];

const BUILDING_WINDOW = '#2d4256';
const LIT = '#ffe7a3';
const PALETTE = ['#c9ced6', '#d4c8b8', '#9bb3c9', '#c98f6b', '#b9c7a9', '#e3c1a3', '#c4b5d1', '#aeb7c4', '#d9c7a7', '#f0dcc0', '#bfcfd9', '#e8d9c4'];

export function createCity(k) {
  const { iso, quad, poly, box, circle, line, hash, shade } = k;
  const g = () => k.ctx();
  const isBack = (x, y) => x < 0 || y < 0;
  const add = (d, fn, cx, cy, z = 0) => k.add(k.statics, d, fn, iso(cx, cy, z), isBack(cx, cy));

  // ---------- ground (cached) ----------
  function drawGround() {
    poly(quad(LO, LO, HI, HI), '#86b866');
    SPANS.forEach(([x0, x1], ix) =>
      SPANS.forEach(([y0, y1], iy) => {
        poly(quad(x0, y0, x1, y1), '#cfcbc3');
        if (ix === OFFICE[0] && iy === OFFICE[1]) return;
        const fill = ix === 2 && iy === 3 ? '#7fb35d' : hash(`${ix}${iy}`) % 3 === 0 ? '#d8d4cc' : '#a7c98d';
        poly(quad(x0 + 0.9, y0 + 0.9, x1 - 0.9, y1 - 0.9), fill);
      }),
    );
    // sidewalk joints around the office
    g().strokeStyle = 'rgba(0,0,0,0.05)';
    g().lineWidth = 1;
    for (let i = -1; i <= 22; i++) {
      line(iso(i, 21), iso(i, 22));
      line(iso(i, -1), iso(i, 0));
    }
    for (let j = -1; j <= 22; j++) {
      line(iso(21, j), iso(22, j));
      line(iso(-1, j), iso(0, j));
    }
    // roads, curbs, lane marks
    for (const r of ROADS) {
      poly(r.axis === 'x' ? quad(LO, r.c0, HI, r.c1) : quad(r.c0, LO, r.c1, HI), '#4b5058');
      const curb = (a, b) => poly(r.axis === 'x' ? quad(LO, a, HI, b) : quad(a, LO, b, HI), '#a9a59c');
      curb(r.c0 - 0.08, r.c0);
      curb(r.c1, r.c1 + 0.08);
      const mid = (r.c0 + r.c1) / 2;
      for (let s = LO + 0.4; s < HI; s += 1.3) {
        if (CROSS.some((c) => s > c - 1.2 && s < c + 3.4)) continue;
        poly(r.axis === 'x' ? quad(s, mid - 0.03, s + 0.65, mid + 0.03) : quad(mid - 0.03, s, mid + 0.03, s + 0.65), '#e9e2c4');
      }
    }
    for (const a of CROSS) {
      for (const b of CROSS) {
        poly(quad(a, b, a + 3, b + 3), '#474c54');
        for (let i = 0; i < 6; i++) {
          const o = 0.15 + i * 0.47;
          poly(quad(a + o, b - 1.1, a + o + 0.24, b - 0.15), '#ecebe6');
          poly(quad(a + o, b + 3.15, a + o + 0.24, b + 4.1), '#ecebe6');
          poly(quad(a - 1.1, b + o, a - 0.15, b + o + 0.24), '#ecebe6');
          poly(quad(a + 3.15, b + o, a + 4.1, b + o + 0.24), '#ecebe6');
        }
      }
    }
    // park in front: paths and a pond
    poly(quad(1, 31, 21, 32), '#d9cbb0');
    poly(quad(10.5, 26, 11.5, 37), '#d9cbb0');
    ellipse(5.5, 28.8, 2.6, 1.7, '#7fb9d9', '#6aa2c2');
    // parking by the shops
    poly(quad(27, 14.2, 36.5, 20.5), '#5d636c');
    g().strokeStyle = 'rgba(255,255,255,0.7)';
    g().lineWidth = 1.5;
    for (let x = 27.4; x <= 36.4; x += 1.2) {
      line(iso(x, 14.4), iso(x, 16.2));
      line(iso(x, 18.5), iso(x, 20.3));
    }
    // stadium on the left: running track around a pitch
    ellipse(-10.5, 10.5, 4.8, 9.2, '#c4553f');
    ellipse(-10.5, 10.5, 3.8, 8.0, '#5fa04e');
    poly(quad(-13.6, 4.2, -7.4, 16.8), '#6ab257');
    g().strokeStyle = 'rgba(255,255,255,0.85)';
    g().lineWidth = 1.5;
    poly(quad(-13.6, 4.2, -7.4, 16.8), null, 'rgba(255,255,255,0.85)', 1.5);
    line(iso(-13.6, 10.5), iso(-7.4, 10.5));
    ellipse(-10.5, 10.5, 1.2, 1.2, null, 'rgba(255,255,255,0.85)');
    // school yard
    poly(quad(-16, 27, -6, 36.5), '#d9cbb0');
    poly(quad(-15, 31, -11, 36), '#4f8fc0');
    poly(quad(-15, 31, -11, 36), null, '#ffffff', 1.5);
  }

  function ellipse(cx, cy, rx, ry, fill, stroke) {
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push(iso(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    poly(pts, fill, stroke, 2);
  }

  // ---------- buildings ----------
  // A block of floors, cut in ≤3-tile pieces for depth sorting, windows on the two visible faces.
  function building(x, y, w, d, h, o = {}) {
    const color = o.color ?? '#c9ced6';
    const floorH = o.floorH ?? 18;
    const alongX = w >= d;
    const n = Math.max(1, Math.ceil((alongX ? w : d) / 3));
    k.shadows.push({ x, y, w, d, h: Math.min(h, 70) });
    for (let i = 0; i < n; i++) {
      const sx = alongX ? x + (w / n) * i : x;
      const sy = alongX ? y : y + (d / n) * i;
      const sw = alongX ? w / n : w;
      const sd = alongX ? d : d / n;
      const ownX = !alongX || i === n - 1; // this piece owns the +x face
      const ownY = alongX || i === n - 1; // this piece owns the +y face
      add(sx + sw / 2 + sy + sd / 2, () => {
        box(sx, sy, sw, sd, h, color, { top: o.roof ?? shade(color, 1.05) });
        if (k.detail()) {
          let r = hash(`${x},${y},${i}`);
          const next = () => (r = Math.imul(r ^ (r >>> 15), 2246822519) >>> 0);
          const win = (face, a, b, z0, z1, lit) => {
            const pts = face === 'y' ? [iso(a, sy + sd, z1), iso(b, sy + sd, z1), iso(b, sy + sd, z0), iso(a, sy + sd, z0)] : [iso(sx + sw, a, z1), iso(sx + sw, b, z1), iso(sx + sw, b, z0), iso(sx + sw, a, z0)];
            poly(pts, lit ? LIT : o.glass ?? BUILDING_WINDOW);
          };
          for (let z = 10; z + floorH - 6 < h - 4; z += floorH) {
            if (ownY) for (let a = sx + 0.15; a + 0.35 <= sx + sw - 0.05; a += 0.55) win('y', a, a + 0.35, z, z + floorH - 7, next() % 7 === 0);
            if (ownX) for (let a = sy + 0.15; a + 0.35 <= sy + sd - 0.05; a += 0.55) win('x', a, a + 0.35, z, z + floorH - 7, next() % 7 === 0);
          }
        } else {
          // far away: floor bands instead of single windows
          for (let z = 14; z < h - 6; z += floorH * 2) {
            if (ownY) poly([iso(sx + 0.1, sy + sd, z + 6), iso(sx + sw - 0.1, sy + sd, z + 6), iso(sx + sw - 0.1, sy + sd, z), iso(sx + 0.1, sy + sd, z)], o.glass ?? BUILDING_WINDOW);
            if (ownX) poly([iso(sx + sw, sy + 0.1, z + 6), iso(sx + sw, sy + sd - 0.1, z + 6), iso(sx + sw, sy + sd - 0.1, z), iso(sx + sw, sy + 0.1, z)], o.glass ?? BUILDING_WINDOW);
          }
        }
        if (o.roofItems && i === 0) {
          box(sx + 0.4, sy + 0.4, 0.8, 0.6, 10, '#9aa1ab', { z: h });
          box(sx + sw - 1, sy + 0.5, 0.5, 0.5, 16, '#7d6a55', { z: h });
        }
        o.decorate?.(sx, sy, sw, sd, i, n);
      }, sx + sw / 2, sy + sd / 2, h / 2);
    }
  }

  function signText(textStr, c, color = '#ffffff', size = 7) {
    const ctx = g();
    ctx.save();
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix([1, 0.5, 0, 1, c.x, c.y])));
    ctx.fillText(textStr, 0, 0);
    ctx.restore();
  }

  function shopRow(x, y, d) {
    const fronts = [['#e07a5f', 'CAFÉ'], ['#3d5a80', 'MART'], ['#81b29a', 'PHO'], ['#f2cc8f', 'BOOKS']];
    fronts.forEach(([col, name], i) => {
      const sx = x + i * 2.4;
      add(sx + 1.15 + y + d / 2, () => {
        box(sx, y, 2.3, d, 46, '#efe9df', { top: '#e2dbcf' });
        poly([iso(sx + 0.25, y + d, 26), iso(sx + 2.05, y + d, 26), iso(sx + 2.05, y + d, 4), iso(sx + 0.25, y + d, 4)], '#3a5266');
        for (let s = 0; s < 6; s++) {
          const a = sx + 0.15 + s * 0.333;
          poly([iso(a, y + d, 32), iso(a + 0.333, y + d, 32), iso(a + 0.333, y + d + 0.45, 26), iso(a, y + d + 0.45, 26)], s % 2 ? '#ffffff' : col);
        }
        poly([iso(sx + 0.4, y + d, 43), iso(sx + 1.9, y + d, 43), iso(sx + 1.9, y + d, 35), iso(sx + 0.4, y + d, 35)], col);
        if (k.detail()) signText(name, iso(sx + 1.15, y + d, 39));
      }, sx + 1.15, y + d / 2, 20);
    });
  }

  function parkedCar(x, y, color) {
    add(x + 0.4 + y + 0.75, () => {
      box(x, y, 0.8, 1.5, 9, color, { z: 3 });
      box(x + 0.06, y + 0.4, 0.68, 0.7, 7, '#2d3f52', { z: 12, top: shade(color, 0.95) });
    }, x + 0.4, y + 0.75);
  }

  function bench(x, y) {
    add(x + 0.6 + y + 0.2, () => {
      box(x, y, 1.2, 0.35, 6, '#8a6a4c', { z: 5 });
      box(x, y - 0.05, 1.2, 0.08, 10, '#7a5a3c', { z: 10 });
    }, x + 0.6, y + 0.2);
  }

  function fountain(x, y) {
    add(x + y, () => {
      const ring = (r, z, fill) => {
        const pts = [];
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          pts.push(iso(x + Math.cos(a) * r, y + Math.sin(a) * r, z));
        }
        poly(pts, fill);
      };
      ring(1.1, 0, '#b9b4aa');
      ring(1.0, 8, '#d7d2c7');
      ring(0.85, 8, '#8ec6e3');
      box(x - 0.12, y - 0.12, 0.24, 0.24, 26, '#cfc9bd', { edge: false });
      const top = iso(x, y, 30);
      const t = k.time();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t;
        circle(top.x + Math.cos(a) * 6, top.y + Math.sin(a) * 3 + (k.reduceMotion ? 0 : Math.sin(t * 4 + i) * 1.5), 2, 'rgba(180,220,245,0.9)');
      }
    }, x, y);
  }

  function trafficLight(x, y) {
    add(x + y, () => {
      box(x - 0.04, y - 0.04, 0.08, 0.08, 52, '#3d424a', { edge: false });
      box(x - 0.1, y - 0.1, 0.2, 0.2, 22, '#22252b', { z: 52 });
      const phase = Math.floor((k.time() + (hash(`${x},${y}`) % 7)) / 4) % 3;
      ['#e74c3c', '#f1c40f', '#2ecc71'].forEach((col, i) => {
        const c = iso(x + 0.1, y + 0.1, 68 - i * 7);
        circle(c.x, c.y, 2.3, i === phase ? col : '#3b3f46');
      });
    }, x, y);
  }

  function stands(x, y, w, d, alongX) {
    // stepped bleachers facing the pitch
    for (let s = 0; s < 4; s++) {
      const off = s * 0.45;
      const bx = alongX ? x : x - off;
      const by = alongX ? y - off : y;
      add(bx + (alongX ? w : 0.45) / 2 + by + (alongX ? 0.45 : d) / 2, () => box(bx, by, alongX ? w : 0.45, alongX ? 0.45 : d, 6 + s * 7, s % 2 ? '#d9483b' : '#e9e4da'), bx, by);
    }
  }

  // Outer blocks: deterministic filler buildings, low in front of the office so they never hide it.
  function fillBlock(ix, iy) {
    const [x0, x1] = SPANS[ix];
    const [y0, y1] = SPANS[iy];
    const front = iy >= 3 || ix >= 3; // between the office and the viewer
    const cell = 6.5;
    for (let cx = x0 + 1.2; cx + 3 <= x1 - 1; cx += cell) {
      for (let cy = y0 + 1.2; cy + 3 <= y1 - 1; cy += cell) {
        const r = hash(`fill${ix},${iy},${cx},${cy}`);
        if (r % 6 === 0) {
          k.tree(cx + 2, cy + 2);
          k.tree(cx + 4, cy + 3.5);
          continue;
        }
        const w = Math.min(x1 - 1 - cx, 3 + (r % 3));
        const d = Math.min(y1 - 1 - cy, 3 + ((r >> 3) % 3));
        const h = front ? 40 + ((r >> 6) % 5) * 14 : 70 + ((r >> 6) % 8) * 22;
        building(cx, cy, w, d, h, { color: PALETTE[(r >> 9) % PALETTE.length], floorH: 15 + ((r >> 12) % 4), roofItems: h > 100 });
      }
    }
  }

  function build() {
    // --- right of the office: a glass tower, shops and their parking ---
    building(27, 1.4, 5, 6, 230, { color: '#9bb3c9', glass: '#3c5a74', floorH: 16, roofItems: true });
    building(33.2, 1.4, 3.6, 4, 150, { color: '#d4c8b8', floorH: 18, roofItems: true });
    shopRow(27, 9.6, 2.2);
    for (const [i, c] of ['#d9483b', '#f1f1f1', '#3c6fd1', '#56606e', '#f5c542', '#2e8b57'].entries()) parkedCar(27.6 + i * 1.5, i % 2 ? 18.7 : 14.5, c);
    // --- in front: the park ---
    fountain(15.5, 31.5);
    for (const [x, y] of [[2, 26.6], [8.6, 26.8], [14, 26.7], [19.6, 27.2], [2.2, 34.8], [7.4, 36], [13.8, 35.4], [19.4, 35.8], [16.8, 28.4], [3.4, 32.6]]) k.tree(x, y);
    bench(12.2, 30.2);
    bench(8.2, 32.5);
    bench(17.2, 33.4);
    // --- front-right corner: apartments and a clinic ---
    building(26.8, 26.8, 6, 4.6, 120, { color: '#c98f6b', floorH: 17, roofItems: true });
    building(34, 27, 2.8, 6, 80, {
      color: '#f2f2ef',
      floorH: 16,
      decorate: (sx, sy, sw, sd) => {
        const c = iso(sx + sw / 2, sy + sd, 62);
        g().fillStyle = '#e74c3c';
        g().fillRect(c.x - 3, c.y - 10, 6, 20);
        g().fillRect(c.x - 10, c.y - 3, 20, 6);
      },
    });
    building(27, 33, 4, 3.4, 60, { color: '#b9c7a9', floorH: 15 });

    // --- behind the office: hotel, offices and a parking garage ---
    building(0.5, -15.5, 6, 5, 200, { color: '#e3d5c3', floorH: 16, roofItems: true, decorate: (sx, sy, sw, sd, i) => i === 0 && k.detail() && signText('HOTEL', iso(sx + sw / 2, sy + sd, 186), '#c0392b', 9) });
    building(8.5, -15.5, 5, 9.5, 150, { color: '#aeb7c4', glass: '#35506a', floorH: 15, roofItems: true });
    building(15.2, -15.5, 6, 4.5, 110, { color: '#c4b5d1', floorH: 17 });
    building(15.2, -9.6, 6, 4, 46, { color: '#9aa1ab', floorH: 11, glass: '#4b5058' }); // parking garage
    building(0.5, -9, 6, 3.5, 70, { color: '#d9c7a7', floorH: 16 });
    // --- behind-left corner: twin towers ---
    building(-16, -16, 4.5, 4.5, 260, { color: '#8fa8c0', glass: '#2f4a63', floorH: 14, roofItems: true });
    building(-9.5, -16, 4.5, 4.5, 260, { color: '#8fa8c0', glass: '#2f4a63', floorH: 14, roofItems: true });
    building(-16, -9.5, 11, 4.4, 60, { color: '#d4c8b8', floorH: 15 });
    // --- left: stadium with bleachers ---
    stands(-15.2, 1.15, 9.4, 0, true);
    stands(-15.45, 1.6, 0, 17.8, false);
    for (const [x, y] of [[-6, 2], [-6, 19.5], [-15.5, 20.5]]) k.tree(x, y);
    // --- behind-right: a campus ---
    building(26.5, -15.5, 7, 5, 130, { color: '#cfd8dc', glass: '#37474f', floorH: 16, roofItems: true });
    building(26.5, -8.6, 4, 3.8, 80, { color: '#e8d9c4', floorH: 16 });
    for (const [x, y] of [[33, -8], [35.5, -6], [35.5, -13]]) k.tree(x, y);
    // --- front-left: a school ---
    building(-16, 25.6, 9.5, 1.3, 40, { color: '#f0c987', floorH: 13, roof: '#c0703a' });
    for (const [x, y] of [[-5.5, 27], [-5.5, 33], [-9, 36]]) k.tree(x, y);

    // --- outer ring of the city ---
    for (let ix = 0; ix < SPANS.length; ix++) for (let iy = 0; iy < SPANS.length; iy++) if (ix === 0 || iy === 0 || ix === 4 || iy === 4) fillBlock(ix, iy);

    // --- street trees, lamps, traffic lights around the office block ---
    for (const y of [2, 5.6, 11.6, 15.6, 19.4]) k.tree(21.55, y);
    for (const x of [2.5, 6.8, 11.4, 16, 19.8]) k.tree(x, 21.55);
    for (const y of [3, 9, 14, 20]) k.tree(37.45, y);
    for (const x of [27.5, 31.5, 35.5]) k.tree(x, 25.55);
    for (const x of [3, 9, 15, 20]) k.tree(x, -0.5);
    for (const y of [3, 9, 15, 20]) k.tree(-0.5, y);
    for (const [x, y] of [[21.55, 3.8], [21.55, 9.8], [4.6, 21.55], [13.6, 21.55], [25.45, 6], [25.45, 16], [30, 21.45], [8, 25.45], [16, 25.45], [6, -0.55], [-0.55, 6], [-0.55, 13]]) k.lamp(x, y);
    for (const a of CROSS) {
      for (const b of CROSS) {
        trafficLight(a - 0.35, b - 0.35);
        trafficLight(a + 3.35, b + 3.35);
      }
    }
  }

  // ---------- moving things ----------
  function vehicleShape(v, x, y, w, d, alongX, forward, alpha) {
    const ctx = g();
    ctx.globalAlpha = alpha;
    poly([iso(x + 0.1, y + 0.1), iso(x + w + 0.12, y + 0.1), iso(x + w + 0.12, y + d + 0.12), iso(x + 0.1, y + d + 0.12)], 'rgba(0,0,0,0.25)');
    const glass = '#2d3f52';
    const t = k.time();
    const wl = alongX ? [[0.2, 0], [w - 0.45, 0], [0.2, d - 0.05], [w - 0.45, d - 0.05]] : [[0, 0.2], [0, d - 0.45], [w - 0.05, 0.2], [w - 0.05, d - 0.45]];
    if (v.kind !== 'moto' && v.kind !== 'bike') for (const [wx, wy] of wl) box(x + wx, y + wy, alongX ? 0.25 : 0.05, alongX ? 0.05 : 0.25, 6, '#1e1f22', { edge: false });
    // part of the length measured from the front, as fractions → rect
    const part = (f0, f1) => {
      const a = forward ? 1 - f1 : f0;
      const b = forward ? 1 - f0 : f1;
      return alongX ? [x + a * w, y, (b - a) * w, d] : [x, y + a * d, w, (b - a) * d];
    };
    const sideStripe = (z0, z1, color) => {
      if (alongX) poly([iso(x, y + d, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x, y + d, z0)], color);
      else poly([iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x + w, y, z0)], color);
    };
    switch (v.kind) {
      case 'bus': {
        box(x, y, w, d, v.h - 6, v.color, { z: 4 });
        const n = 6;
        const span = (alongX ? w : d) - 0.4;
        for (let i = 0; i < n; i++) {
          const a = (alongX ? x : y) + 0.2 + i * (span / n);
          const b = a + span / n - 0.08;
          if (alongX) poly([iso(a, y + d, v.h - 4), iso(b, y + d, v.h - 4), iso(b, y + d, v.h - 14), iso(a, y + d, v.h - 14)], glass);
          else poly([iso(x + w, a, v.h - 4), iso(x + w, b, v.h - 4), iso(x + w, b, v.h - 14), iso(x + w, a, v.h - 14)], glass);
        }
        box(x + 0.1, y + 0.1, w - 0.2, d - 0.2, 2, '#f1f1f1', { z: v.h - 2 });
        break;
      }
      case 'truck': {
        const [cx, cy, cw, cd] = part(0, 0.28);
        box(cx, cy, cw, cd, 20, v.color === '#e9edf2' ? '#2f80d9' : '#c0392b', { z: 4 });
        const [bx, by, bw, bd] = part(0.32, 1);
        box(bx, by, bw, bd, v.h - 4, v.color, { z: 4 });
        if (alongX) poly([iso(bx + 0.2, by + bd, 22), iso(bx + bw - 0.2, by + bd, 22), iso(bx + bw - 0.2, by + bd, 17), iso(bx + 0.2, by + bd, 17)], '#2fa89a');
        else poly([iso(bx + bw, by + 0.2, 22), iso(bx + bw, by + bd - 0.2, 22), iso(bx + bw, by + bd - 0.2, 17), iso(bx + bw, by + 0.2, 17)], '#2fa89a');
        break;
      }
      case 'van':
      case 'ambulance': {
        box(x, y, w, d, v.h - 4, v.color, { z: 4 });
        const [gx, gy, gw, gd] = part(0, 0.22);
        box(gx + 0.02, gy + 0.02, gw - 0.04, gd - 0.04, 8, glass, { z: v.h - 14, edge: false });
        if (v.kind === 'ambulance') {
          sideStripe(10, 14, '#e74c3c');
          const on = Math.floor(t * 4) % 2;
          const c = iso(x + w / 2, y + d / 2, v.h + 2);
          circle(c.x - 4, c.y, 2.5, on ? '#e74c3c' : '#f5b7b1');
          circle(c.x + 4, c.y, 2.5, on ? '#f5b7b1' : '#e74c3c');
        }
        break;
      }
      case 'moto':
      case 'bike': {
        box(x, y, w, d, v.kind === 'moto' ? 6 : 3, v.kind === 'moto' ? v.color : '#3b3f46', { z: 3, edge: false });
        k.person(iso(x + w / 2, y + d / 2, v.kind === 'moto' ? 2 : 0), { shirt: v.kind === 'moto' ? '#2f3a4f' : v.color, seed: `${v.off}${v.kind}`, scale: 0.55, sitting: true, helmet: v.kind === 'moto' ? v.color : null, t });
        break;
      }
      default: {
        // car, taxi, police
        box(x, y, w, d, 9, v.color, { z: 3 });
        const [cx, cy, cw, cd] = part(0.25, 0.75);
        const inset = 0.06;
        box(alongX ? cx : cx + inset, alongX ? cy + inset : cy, alongX ? cw : cw - inset * 2, alongX ? cd - inset * 2 : cd, 7, glass, { z: 12, top: shade(v.kind === 'police' ? '#1f2a44' : v.color, 0.95) });
        if (v.kind === 'taxi') box(x + w / 2 - 0.12, y + d / 2 - 0.12, 0.24, 0.24, 4, '#222222', { z: 19 });
        if (v.kind === 'police') {
          const on = Math.floor(t * 5) % 2;
          box(x + w / 2 - 0.15, y + d / 2 - 0.15, 0.3, 0.3, 3, on ? '#e74c3c' : '#3498db', { z: 19, edge: false });
          sideStripe(5, 10, '#1f2a44');
        }
      }
    }
    // headlights on the front, tail lights on the back: only the visible +x / +y end
    if (v.kind !== 'bike') {
      const lamp = forward ? '#fff6c8' : '#e74c3c';
      if (alongX) {
        poly([iso(x + w, y + 0.1, 8), iso(x + w, y + 0.25, 8), iso(x + w, y + 0.25, 5), iso(x + w, y + 0.1, 5)], lamp);
        poly([iso(x + w, y + d - 0.25, 8), iso(x + w, y + d - 0.1, 8), iso(x + w, y + d - 0.1, 5), iso(x + w, y + d - 0.25, 5)], lamp);
      } else {
        poly([iso(x + 0.1, y + d, 8), iso(x + 0.25, y + d, 8), iso(x + 0.25, y + d, 5), iso(x + 0.1, y + d, 5)], lamp);
        poly([iso(x + w - 0.25, y + d, 8), iso(x + w - 0.1, y + d, 8), iso(x + w - 0.1, y + d, 5), iso(x + w - 0.25, y + d, 5)], lamp);
      }
    }
    ctx.globalAlpha = 1;
  }

  function addMoving(list, t) {
    const L = HI - LO;
    for (const v of TRAFFIC) {
      let s = LO + ((t * v.speed + v.off) % (L + 6)) - 3;
      if (v.lane < 0) s = LO + HI - s;
      const fade = Math.max(0, Math.min(1, Math.min(s - LO - 0.5, HI - 0.5 - s) / 1.5));
      if (fade <= 0) continue;
      const laneC = v.lane > 0 ? v.road.c0 + 0.85 : v.road.c1 - 0.85;
      const alongX = v.road.axis === 'x';
      const x = alongX ? s - v.len / 2 : laneC - v.wid / 2;
      const y = alongX ? laneC - v.wid / 2 : s - v.len / 2;
      const w = alongX ? v.len : v.wid;
      const d = alongX ? v.wid : v.len;
      const cx = x + w / 2;
      const cy = y + d / 2;
      k.add(list, cx + cy, () => vehicleShape(v, x, y, w, d, alongX, v.lane > 0, fade), iso(cx, cy), isBack(cx, cy));
    }
    for (const p of WALKERS) {
      const len = p.b - p.a;
      const u = ((t * p.speed + p.off) % (2 * len)) / len; // ping-pong 0..2
      const s = p.a + (u < 1 ? u : 2 - u) * len;
      const x = p.axis === 'x' ? s : p.at;
      const y = p.axis === 'x' ? p.at : s;
      k.add(list, x + y, () => k.person(iso(x, y), { shirt: p.shirt, seed: `walker${p.off}${p.at}`, t, scale: 0.8, walking: true }), iso(x, y), isBack(x, y));
    }
  }

  return { drawGround, build, addMoving };
}
