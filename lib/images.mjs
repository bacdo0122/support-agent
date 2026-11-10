// Downloads the images of a BOSS task (description, comments, comment attachments) before the analysis runs,
// so Claude only has to Read local files. BOSS serves /file-view/... without login.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const ORIGIN = 'https://boss.bss-b2b.solutions';
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Every /file-view/... path found anywhere in the task data (HTML src, attachment url, absolute links).
export function imagePaths(value) {
  const text = JSON.stringify(value ?? '').replace(/\\u0026|&amp;/g, '&').replace(/\\\//g, '/');
  const out = [];
  for (const m of text.matchAll(/(?:https:\/\/boss\.bss-b2b\.solutions)?(\/file-view\/[^"'\s<>\\)]+)/g)) {
    const p = m[1].replace(/[?#].*$/, '');
    if (IMAGE.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

const safeName = (p, i) => `${String(i + 1).padStart(2, '0')}-${basename(p).replace(/[^\w.-]/g, '_').slice(-80)}`;

// → [{file, url, from}] for the images saved (or already there); failures carry error instead of file.
// task / comments: pass what was already read to skip reading them again.
export async function fetchTaskImages({ client, key, dir, fetchImpl = globalThis.fetch, max = 25, maxBytes = 15 * 1024 * 1024, timeoutMs = 20000, task, comments }) {
  if (!client || !dir) return [];
  [task, comments] = await Promise.all([
    task !== undefined ? task : client.callTool('read_task', { task_id: key, fields: ['description'] }).catch(() => null),
    comments !== undefined ? comments : client.callTool('read_task_comments', { task_id: key }).catch(() => null),
  ]);
  const found = [
    ...imagePaths(task?.description).map((p) => ({ p, from: 'description' })),
    ...imagePaths(comments).map((p) => ({ p, from: 'comment' })),
  ].filter((x, i, all) => all.findIndex((y) => y.p === x.p) === i).slice(0, max);
  if (!found.length) return [];
  await mkdir(dir, { recursive: true });
  return Promise.all(found.map(async ({ p, from }, i) => {
    const url = `${ORIGIN}${p}`;
    const file = join(dir, safeName(p, i));
    try {
      if ((await stat(file).catch(() => null))?.size > 0) return { file, url, from };
      const res = await (fetchImpl ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > maxBytes) throw new Error(`kích thước ${buf.length}`);
      await writeFile(file, buf);
      return { file, url, from };
    } catch (err) {
      return { url, from, error: err.message };
    }
  }));
}

// Added to the analysis prompt.
export function imagesNote(list) {
  if (!list?.length) return '';
  const ok = list.filter((x) => x.file);
  const bad = list.filter((x) => !x.file);
  return `\n- Ảnh của task đã được app tải sẵn (${ok.length} ảnh). BẮT BUỘC Read từng file trước khi kết luận:\n${ok.map((x) => `  * ${x.file} (${x.from})`).join('\n')}${
    bad.length ? `\n  Không tải được: ${bad.map((x) => `${x.url} (${x.error})`).join(', ')} → thử tải lại bằng curl, vẫn lỗi thì ghi rõ là chưa xem được.` : ''}`;
}
