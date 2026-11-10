// Tries a DevHub fix on the customer's storefront without saving anything: a throwaway headless Chrome
// (own empty profile) loads the page, optionally runs the proposed code in that local tab only, then reads
// a check expression and takes a screenshot. Every request other than GET/HEAD/OPTIONS is blocked, so neither
// the page nor the code can change the store (cart, customer, forms).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function launch(bin) {
  const profile = await mkdtemp(join(tmpdir(), 'trial-chrome-'));
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio', '--window-size=1366,900',
    'about:blank',
  ], { stdio: 'ignore', detached: true }); // own process group: renderer/GPU children go with it
  const exited = new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  const close = async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await Promise.race([exited, sleep(5000)]);
    await sleep(200); // let the killed children release the profile
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
  try {
    for (let i = 0; i < 100; i++) {
      const port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [p, path] = port.split('\n');
      if (p && path) return { url: `ws://127.0.0.1:${p}${path}`, close };
      if (child.exitCode !== null) throw new Error(`Chrome thoát ngay (${child.exitCode})`);
      await sleep(100);
    }
    throw new Error('Không mở được Chrome headless');
  } catch (err) {
    await close();
    throw err;
  }
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Không kết nối được Chrome'));
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  return { ready, send, on: (fn) => listeners.add(fn), close: () => ws.close() };
}

const HOOK_SCRIPT = /(<script id="bss-b2b-customize"[^>]*>)([\s\S]*?)(<\/script>)/;

// The page as DevHub would serve it: the code appended inside <script id="bss-b2b-customize"> (where the app embed
// prints the DevHub code, before the app starts). Only this local tab sees it. null when the page has no such script.
export function hookHtml(html, code) {
  if (!HOOK_SCRIPT.test(html)) return null;
  const safe = String(code).replace(/<\/script/gi, '<\\/script');
  return html.replace(HOOK_SCRIPT, (m, open, body, close) =>
    `${open}${body}\n;try {\n${safe}\n} catch (e) { console.error('[thử DevHub] ' + (e && e.stack || e)); }\n${close}`);
}

// One page load. inject: code run in that tab, after the page settles (injectAt 'after') or inside the app's
// DevHub script while the page loads (injectAt 'hook'). → {check, errors, injectError, blocked, password, finalUrl, shot}
export async function probePage({ url, check, ready, inject, injectAt = 'after', shotPath, chromeBin = 'google-chrome', settleMs = 3000, timeoutMs = 45000 }) {
  const browser = await launch(chromeBin);
  const cdp = connect(browser.url);
  const errors = [];
  let blocked = 0;
  let hooked = 0;
  let loaded = false;
  const hookMode = Boolean(inject) && injectAt === 'hook';
  const timer = setTimeout(() => cdp.close(), timeoutMs + 20000);
  try {
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params ?? {};
      if (msg.method === 'Fetch.requestPaused' && p.responseStatusCode !== undefined) {
        // response stage (hook mode, documents only): put the code where DevHub code runs
        (async () => {
          try {
            if (p.responseStatusCode < 200 || p.responseStatusCode >= 300) throw new Error('not a page');
            const b = await s('Fetch.getResponseBody', { requestId: p.requestId });
            const html = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
            const out = hookHtml(html, inject);
            if (out == null) throw new Error('no hook script');
            hooked++;
            const responseHeaders = (p.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
            await s('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders, body: Buffer.from(out).toString('base64') });
          } catch {
            s('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
          }
        })();
      } else if (msg.method === 'Fetch.requestPaused') {
        if (READ_METHODS.has(p.request.method)) s('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
        else {
          blocked++;
          s('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      } else if (msg.method === 'Page.loadEventFired') loaded = true;
      else if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails ?? {};
        errors.push(String(d.exception?.description ?? d.text ?? 'exception').split('\n')[0].slice(0, 300));
      } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      }
    });
    const patterns = [{ urlPattern: '*', requestStage: 'Request' }];
    if (hookMode) patterns.push({ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' });
    await s('Fetch.enable', { patterns });
    await Promise.all([s('Page.enable'), s('Runtime.enable')]);
    await s('Page.navigate', { url });
    const until = Date.now() + timeoutMs;
    while (!loaded && Date.now() < until) await sleep(200);
    const evaluate = async (expression) => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
      if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
      return r.result?.value;
    };
    const finalUrl = await evaluate('location.href').catch(() => url);
    const password = /\/password(\/|$|\?)/.test(new URL(finalUrl).pathname);
    if (ready && !password) {
      const sel = JSON.stringify(ready);
      for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector(${sel})`).catch(() => false)); i++) await sleep(250);
    }
    await sleep(settleMs);
    const before = errors.length;
    let injectError = null;
    if (hookMode && !password && !hooked) {
      injectError = 'Trang không có script#bss-b2b-customize: app embed B2B Solution chưa bật trên theme này (hoặc theme không render app embed)';
    } else if (inject && !hookMode && !password) {
      injectError = await evaluate(`(() => { try { ${inject}\n; return null } catch (e) { return String(e && e.stack || e) } })()`)
        .catch((e) => e.message);
      await sleep(settleMs);
    }
    let checkValue = null;
    let checkError = null;
    if (check && !password) {
      try {
        checkValue = await evaluate(`(async () => (${check}))()`);
      } catch (e) {
        checkError = e.message;
      }
    }
    let shot = null;
    if (shotPath) {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      await mkdir(dirname(shotPath), { recursive: true });
      await writeFile(shotPath, Buffer.from(data, 'base64'));
      shot = shotPath;
    }
    return { loaded, finalUrl, password, check: checkValue, checkError, injectError, errors, errorsAfterInject: errors.slice(before), blocked, hooked, shot };
  } finally {
    clearTimeout(timer);
    cdp.close();
    await browser.close();
  }
}

// before (as the customer sees it) and after (same page + proposed code) → verdict.
export async function trialFix({ url, code, check, ready, dir, chromeBin, injectAt = 'after', probe = probePage }) {
  const before = await probe({ url, check, ready, chromeBin, shotPath: join(dir, 'trial-before.png') });
  if (before.password) return { verdict: 'unknown', note: 'Store đang có mật khẩu: không thử được', before };
  const after = await probe({ url, check, ready, chromeBin, inject: code, injectAt, shotPath: join(dir, 'trial-after.png') });
  const known = new Set(before.errors);
  const newErrors = [...new Set(after.errors.filter((e) => !known.has(e)))];
  let verdict;
  let note;
  if (before.checkError || after.checkError) [verdict, note] = ['unknown', `Biểu thức kiểm tra lỗi: ${before.checkError || after.checkError}`];
  else if (after.injectError && injectAt === 'hook' && !after.hooked) [verdict, note] = ['unknown', after.injectError];
  else if (after.injectError) [verdict, note] = ['failed', `Code lỗi khi chạy: ${after.injectError.split('\n')[0]}`];
  else if (newErrors.length) [verdict, note] = ['failed', `Code gây lỗi console mới (${newErrors.length})`];
  else if (before.check === true) [verdict, note] = ['not-reproduced', 'Không tái hiện được lỗi: kiểm tra đã đúng ngay khi chưa có code'];
  else if (after.check === true) [verdict, note] = ['passed', 'Trước: còn lỗi · Sau khi chạy code: hết lỗi, không có lỗi console mới'];
  else [verdict, note] = ['failed', 'Chạy code xong vẫn còn lỗi'];
  return { verdict, note, before, after, newErrors };
}
