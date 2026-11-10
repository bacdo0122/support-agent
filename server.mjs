import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBossClient } from './lib/boss.mjs';
import { createBus } from './lib/bus.mjs';
import { createClaudeRunner, LOGS } from './lib/claude.mjs';
import { createPipeline } from './lib/pipeline.mjs';
import { createLearning } from './lib/learn.mjs';
import { createTeamCases } from './lib/teamcases.mjs';
import { createModuleMap } from './lib/knowledge.mjs';
import { richText } from './lib/taskdata.mjs';
import { createPoller } from './lib/poller.mjs';
import { createSessions } from './lib/sessions.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
const MAX_HOOK_BODY = 10 * 1024 * 1024;
const list = (v) => (v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const MACHINE = process.env.MACHINE_NAME || hostname();
// Other machines' Support Office URLs (e.g. Tailscale serve); the page connects to each of them.
const PEERS = list(process.env.PEERS);
// Origins allowed to read this server's state from the browser: this app on localhost and on the other machines.
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, ...PEERS, ...list(process.env.ALLOWED_ORIGINS)]);

const cors = (req) => {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
};
// Hook events must come from this machine, never through a proxy such as tailscale serve.
const viaProxy = (req) => Boolean(req.headers['x-forwarded-for'] || req.headers['tailscale-user-login']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const bus = createBus();
const client = process.env.BOSS_TOKEN
  ? createBossClient({ url: process.env.BOSS_MCP_URL || 'https://boss.bss-b2b.solutions/mcp', token: process.env.BOSS_TOKEN })
  : null;
const pipelineOn = process.env.PIPELINE !== '0';
const runner = createClaudeRunner({
  bin: process.env.CLAUDE_BIN || 'claude',
  cwd: process.env.CLAUDE_CWD || join(ROOT, '..'),
  model: process.env.CLAUDE_MODEL || 'opus',
  timeoutMs: (Number(process.env.ANALYZE_TIMEOUT_MIN) || 30) * 60000,
});
// learning from finished tasks: feedback, lessons (you approve), cases
const learn = createLearning({
  dir: join(ROOT, 'data'),
  runner,
  client,
  lessonModel: process.env.LESSON_MODEL || 'sonnet',
  onChange: (st) => bus.broadcast('learn', st),
});
// the team's Resolved tasks with the TS answer: closest precedents go into every analysis; synced every 6 h
const moduleMap = createModuleMap();
const teamCases = createTeamCases({ dir: join(ROOT, 'data'), client, log: (m) => console.log(m) });
const pipeline = createPipeline({
  statePath: join(ROOT, 'data', 'pipeline.json'),
  bus,
  client,
  runner,
  hooks: {
    finished: (it, o) => learn.finished(it, o),
    reopened: (key) => learn.reopened(key),
    context: (it, o = {}) => learn.context(it, o)
      + teamCases.context({ title: it.title, text: richText(o.text ?? ''), app: it.app, exclude: [it.key] })
      + moduleMap.note({ app: it.app, title: it.title }),
  },
  onChange: (items) => bus.broadcast('pipeline', items),
  autoAnalyze: process.env.AUTO_ANALYZE !== '0',
  logsDir: process.env.AUTOFIX_LOGS_DIR || LOGS,
  chromeBin: process.env.CHROME_BIN || 'google-chrome',
  devhubApps: (process.env.DEVHUB_APPS ?? 'Lock').split(',').map((x) => x.trim()).filter(Boolean),
});
const poller = createPoller({
  client,
  bus,
  statePath: join(ROOT, 'data', 'state.json'),
  intervalSec: Number(process.env.BOSS_POLL_SECONDS) || 120,
  worklogDays: Number(process.env.WORKLOG_DAYS) || 30,
  assignee: process.env.BOSS_ASSIGNEE || null,
  assignedIntervalSec: Number(process.env.ASSIGNED_POLL_SECONDS) || 30,
  onUpdate: (boss) => bus.broadcast('boss', boss),
  onNewTodo: (task) => {
    if (pipelineOn) pipeline.offer(task);
  },
});
const sessions = createSessions({ bus, onChange: (s) => bus.broadcast('session', s) });

// Settings switched from the page, kept across restarts (data/settings.json). autoAnalyze: AUTO_ANALYZE is only the default.
const SETTINGS_FILE = join(ROOT, 'data', 'settings.json');
const settings = () => ({ autoAnalyze: pipeline.autoAnalyzeOn() });
async function loadSettings() {
  const s = JSON.parse(await readFile(SETTINGS_FILE, 'utf8').catch(() => '{}'));
  if (typeof s.autoAnalyze === 'boolean') pipeline.setAutoAnalyze(s.autoAnalyze);
}
async function saveSettings() {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings(), null, 1));
  await rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
}

const snapshot = () => ({ settings: settings(), machine: MACHINE, boss: poller.boss, sessions: sessions.list(), pipeline: pipeline.list(), learn: { ...learn.state(), teamCases: teamCases.stats(), moduleMap: moduleMap.state() } });

// Pipeline actions run Claude and write to BOSS: only this app's own page may call them (no form posts from other sites).
const trustedAction = (req) => {
  const origin = req.headers.origin;
  return !viaProxy(req) && origin && new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]).has(origin)
    && String(req.headers['content-type']).startsWith('application/json');
};

async function pipelineAction(req, res, key, action) {
  if (!trustedAction(req)) return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Chỉ trang Phòng Support trên máy này được thao tác');
  const body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
  const reply = (code, data) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  try {
    let item;
    if (action === 'add') {
      const t = poller.boss.assigned.find((x) => x.key === body.key);
      if (!t) return reply(404, { error: 'Task không có trong danh sách giao cho bạn' });
      item = pipeline.offer(t, 'manual');
      if (!item) return reply(409, { error: 'Task đã có trong hàng đợi' });
    } else if (action === 'approve') item = pipeline.approve(key);
    else if (action === 'skip') item = pipeline.skip(key, typeof body.reason === 'string' ? body.reason : null);
    else if (action === 'cancel') item = pipeline.cancel(key);
    else if (action === 'done') item = pipeline.finish(key);
    else if (action === 'comment') item = pipeline.approveComment(key, body.text, body.code).item;
    else if (action === 'devhub') item = pipeline.approveDevhub(key, body.code).item;
    else if (action === 'ask') item = pipeline.ask(key, body.text).item;
    else if (action === 'trial') item = pipeline.tryFix(key, body).item;
    else if (action === 'enable') item = pipeline.enableDevhub(key, { force: body.force === true }).item;
    else if (action === 'askstop') item = pipeline.stopAsk(key);
    else return reply(404, { error: 'Không có thao tác này' });
    return reply(202, item);
  } catch (err) {
    return reply(err.status ?? 500, { error: err.message });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, path) {
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (file.includes('..') || !TYPES[extname(file)]) return false;
  try {
    const body = await readFile(join(ROOT, 'public', file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && pathname === '/hooks') {
      if (viaProxy(req)) return res.writeHead(403).end();
      const body = await readBody(req, MAX_HOOK_BODY);
      res.writeHead(204).end();
      try {
        sessions.handle(JSON.parse(body));
      } catch {
        // a malformed hook payload must never break anything
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/events') return bus.attach(req, res, snapshot, cors(req));
    if (req.method === 'GET' && pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) });
      return res.end(JSON.stringify({ ...snapshot(), feed: bus.feed }));
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ machine: MACHINE, peers: PEERS }));
    }
    if (req.method === 'POST' && pathname === '/api/poll') {
      poller.poll();
      return res.writeHead(202).end();
    }
    // screenshots of the fix trial (customer storefront as a guest)
    const shot = /^\/api\/pipeline\/([A-Z0-9]+-\d+)\/shot\/(trial-before|trial-after|live)\.png$/.exec(pathname);
    if (req.method === 'GET' && shot) {
      const png = await readFile(join(pipeline.shotDir(shot[1]), `${shot[2]}.png`)).catch(() => null);
      if (!png) return res.writeHead(404).end();
      return res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(png);
    }
    const lm = /^\/api\/learn\/lesson\/([0-9a-f-]{36})\/(approve|reject|delete)$/.exec(pathname);
    if (req.method === 'POST' && lm) {
      if (!trustedAction(req)) return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Chỉ trang Phòng Support trên máy này được thao tác');
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
      try {
        const l = learn.lessonAction(lm[1], lm[2], body.text);
        return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(l));
      } catch (err) {
        return res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: err.message }));
      }
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      if (!trustedAction(req)) return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Chỉ trang Phòng Support trên máy này được thao tác');
      const body = JSON.parse((await readBody(req, 4096)) || '{}');
      if (typeof body.autoAnalyze === 'boolean') {
        pipeline.setAutoAnalyze(body.autoAnalyze);
        await saveSettings();
        console.log(`Tự động phân tích task mới: ${body.autoAnalyze ? 'BẬT' : 'TẮT'}`);
      }
      bus.broadcast('settings', settings());
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(settings()));
    }
    const m = /^\/api\/pipeline(?:\/([A-Z0-9]+-\d+))?\/([a-z]+)$/.exec(pathname);
    if (req.method === 'POST' && m) return pipelineAction(req, res, m[1], m[2]);
    if (req.method === 'GET' && (await serveStatic(res, pathname))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(err.message));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Support Office "${MACHINE}": http://${HOST}:${PORT}${PEERS.length ? ` · peers: ${PEERS.join(', ')}` : ''}`);
  if (!client) console.log('BOSS_TOKEN chưa có trong .env: chỉ nhận sự kiện Claude Code, chưa tải hàng đợi BOSS.');
  Promise.all([pipeline.load(), learn.load(), teamCases.load(), loadSettings().catch(() => {})]).then(() => {
    poller.start();
    if (client) {
      learn.start();
      const syncCases = () => teamCases.sync().then((r) => r.added && console.log(`Kho tiền lệ: +${r.added} task (tổng ${r.total})`)).catch((e) => console.log(`Kho tiền lệ lỗi: ${e.message}`));
      setTimeout(syncCases, 60000);
      setInterval(syncCases, 6 * 3600000).unref();
      learn.backfill(pipeline.list()).then((n) => n && console.log(`Học từ task: đã đọc lại ${n} task cũ`)).catch(() => {});
    }
  });
  setInterval(() => sessions.prune(), 60000);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    poller.stop();
    server.close();
    process.exit(0);
  });
}
