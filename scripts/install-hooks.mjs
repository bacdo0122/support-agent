// Adds the Support Office hooks to ~/.claude/settings.json (idempotent; keeps a backup).
// Usage: node scripts/install-hooks.mjs [--port 4317] [--remove]
// Another machine on the LAN (sends its Claude Code sessions to the app on that machine):
//   node install-hooks.mjs --url http://192.168.30.108:4317 --key <hook key printed by the server> [--name "Máy demo"]

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const args = process.argv.slice(2);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const port = Number(opt('port')) || 4317;
const url = (opt('url') ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
const key = opt('key');
const name = (opt('name') ?? hostname()).replace(/[^\p{L}\p{N} ._-]/gu, '');
if (!/^http:\/\/[\w.-]+:\d+$/.test(url)) throw new Error(`--url phải dạng http://<ip>:<port>, nhận được ${url}`);
if (key && !/^[0-9a-f]{32}$/.test(key)) throw new Error('--key không đúng dạng (32 ký tự hex server in ra)');
const remove = args.includes('--remove');
const file = join(homedir(), '.claude', 'settings.json');
const MARK = '/hooks';
const extra = key ? ` -H 'X-Hook-Key: ${key}' -H 'X-Hook-Machine: ${encodeURIComponent(name)}'` : '';
const command = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json'${extra} --data-binary @- ${url}/hooks 2>/dev/null || true`;
// any earlier copy of our hook (this machine or a LAN url)
const ours = (h) => h?.type === 'command' && typeof h.command === 'string' && /curl .*http:\/\/[\w.-]+:\d+\/hooks/.test(h.command);

let settings = {};
try {
  settings = JSON.parse(await readFile(file, 'utf8'));
  await copyFile(file, `${file}.bak`);
} catch (err) {
  if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
}

settings.hooks ??= {};
for (const event of EVENTS) {
  // drop any earlier copy of our hook, keep everything else
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) }))
    .filter((g) => g.hooks.length);
  if (!remove) {
    const group = { hooks: [{ type: 'command', async: true, command }] };
    if (TOOL_EVENTS.has(event)) group.matcher = '*';
    groups.push(group);
  }
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Removed' : 'Installed'} Support Office hooks (${EVENTS.length} events → ${url}) in ${file}`);
