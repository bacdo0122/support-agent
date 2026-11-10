// Module capability map (knowledge/modules.md, reviewed by you): what each module of Solution / Quote / Lock can and
// cannot do and when another module is the answer. The section of the task's app goes into the analysis prompt.
// A file still marked <!-- draft --> is not used.

import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'modules.md');
const APPS = ['Solution', 'Quote', 'Lock'];

// '# Solution' / '# Quote' / '# Lock' → their text
export function parseModuleMap(text) {
  const out = {};
  let app = null;
  for (const line of String(text).split('\n')) {
    const h = line.match(/^#\s+(\S+)/);
    if (h && APPS.includes(h[1])) {
      app = h[1];
      out[app] = '';
      continue;
    }
    if (app) out[app] += `${line}\n`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

export function createModuleMap({ file = MODULES_FILE } = {}) {
  let cache = { mtime: 0, draft: true, sections: {} };
  const read = () => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== cache.mtime) {
        const text = readFileSync(file, 'utf8');
        cache = { mtime: m, draft: /<!--\s*draft\s*-->/i.test(text), sections: parseModuleMap(text) };
      }
    } catch {
      cache = { mtime: 0, draft: true, sections: {} };
    }
    return cache;
  };

  // apps: the task's app (+ others named in the title); exclude: task keys whose lines must not show (blind runs)
  function note({ app, title = '', exclude = [] } = {}) {
    const c = read();
    if (c.draft) return '';
    const want = [...new Set([app, ...APPS.filter((a) => new RegExp(`\\b${a}\\b`, 'i').test(title))])].filter((a) => c.sections[a]);
    if (!want.length) return '';
    const strip = (s) => (exclude.length ? s.split('\n').filter((l) => !exclude.some((k) => l.includes(k))).join('\n') : s);
    return `\n\nBản đồ tính năng (user đã duyệt; dùng để xét module khác trước khi kết luận "không làm được", và để kiểm cơ chế; vẫn kiểm chứng lại bằng code/store khi kết luận dựa vào nó):\n${want.map((a) => `## ${a}\n${strip(c.sections[a])}`).join('\n\n')}`;
  }

  const state = () => {
    const c = read();
    return { exists: c.mtime > 0, draft: c.draft, apps: Object.keys(c.sections) };
  };
  return { note, state, file };
}
