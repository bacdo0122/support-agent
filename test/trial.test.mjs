import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { trialFix } from '../lib/trial.mjs';

const chrome = process.env.CHROME_BIN || 'google-chrome';
let hasChrome = true;
try { execFileSync(chrome, ['--version']); } catch { hasChrome = false; }

// a "storefront": the price is hidden by mistake; the page also tries to POST on load
const posts = [];
const PAGE = `<!doctype html><title>shop</title><div class="price" style="display:none">$10</div>
<script>fetch('/cart/add.js', { method: 'POST', body: '{}' }).catch(() => {});</script>`;

test('a fix is tried on a local copy of the page: before shows the bug, after the code it is gone, writes are blocked', { skip: !hasChrome && 'no Chrome', timeout: 90000 }, async () => {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') posts.push(req.method);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/products/x`;
  const dir = await mkdtemp(join(tmpdir(), 'trial-'));
  try {
    const check = `getComputedStyle(document.querySelector('.price')).display !== 'none'`;
    const ok = await trialFix({ url, dir, check, ready: '.price', chromeBin: chrome, code: `document.querySelector('.price').style.display = 'block';` });
    assert.equal(ok.verdict, 'passed', JSON.stringify(ok));
    assert.deepEqual([ok.before.check, ok.after.check], [false, true]);
    assert.ok(ok.before.blocked >= 1, 'the page POST was blocked');
    assert.deepEqual(posts, [], 'nothing but GET reached the store');
    assert.ok((await stat(join(dir, 'trial-before.png'))).size > 1000);
    assert.ok((await stat(join(dir, 'trial-after.png'))).size > 1000);

    const bad = await trialFix({ url, dir, check, chromeBin: chrome, code: `undefinedFn();` });
    assert.equal(bad.verdict, 'failed');
    assert.match(bad.note, /lỗi khi chạy/);

    const sneaky = await trialFix({ url, dir, check, chromeBin: chrome, code: `fetch('/customer', { method: 'POST' }).catch(() => {}); document.querySelector('.price').style.display = 'block';` });
    assert.equal(sneaky.verdict, 'passed');
    assert.ok(sneaky.after.blocked >= 2);
    assert.deepEqual(posts, []);
  } finally {
    server.close();
  }
});

// a Solution storefront: the app reads its installation hooks once, at start, right after the DevHub script
const SOLUTION_PAGE = (embed) => `<!doctype html><title>shop</title><div class="pp"><span class="pp-price">$10</span></div>
${embed ? '<script id="bss-b2b-customize">\n\twindow.oldDevhub = 1;\n</script>' : ''}
<script>
  const f = window.bssB2BHooks?.filters?.['custom:config_theme/installation'];
  const cfg = f ? f({}, { page: 'product' }) : {};
  if (cfg.selectorPrice) document.querySelector(cfg.selectorPrice)?.setAttribute('bss-b2b-product-price', '');
</script>`;

test('install code for Solution is tried inside script#bss-b2b-customize, before the app starts', { skip: !hasChrome && 'no Chrome', timeout: 120000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(SOLUTION_PAGE(!req.url.includes('noembed')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'trial-hook-'));
  const code = `(() => { if (window.oldDevhub !== 1) return;
  window.bssB2BHooks = window.bssB2BHooks || {}; window.bssB2BHooks.filters = window.bssB2BHooks.filters || {};
  window.bssB2BHooks.filters['custom:config_theme/installation'] = (c, { page }) => (page === 'product' ? { ...c, selectorPrice: '.pp-price' } : c); })();`;
  const check = `!!document.querySelector('[bss-b2b-product-price]')`;
  try {
    // after the page loads it is too late: the app already read its hooks
    const late = await trialFix({ url: `${base}/products/x`, dir, check, chromeBin: chrome, code });
    assert.equal(late.verdict, 'failed');
    const ok = await trialFix({ url: `${base}/products/x?preview_theme_id=1`, dir, check, chromeBin: chrome, code, injectAt: 'hook' });
    assert.equal(ok.verdict, 'passed', JSON.stringify(ok));
    assert.equal(ok.after.hooked, 1);
    const none = await trialFix({ url: `${base}/products/x?noembed=1`, dir, check, chromeBin: chrome, code, injectAt: 'hook' });
    assert.equal(none.verdict, 'unknown');
    assert.match(none.note, /app embed/);
  } finally {
    server.close();
  }
});
