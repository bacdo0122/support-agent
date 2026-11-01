// Adds the Support Office hooks to ~/.claude/settings.json (idempotent; keeps a backup).
// Usage: node scripts/install-hooks.mjs [--port 4317] [--remove]

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 4317;
const remove = args.includes('--remove');
const file = join(homedir(), '.claude', 'settings.json');
const MARK = '/hooks';
const command = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hooks 2>/dev/null || true`;
const ours = (h) => h?.type === 'command' && typeof h.command === 'string' && h.command.includes('127.0.0.1:') && h.command.includes(MARK);

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
console.log(`${remove ? 'Removed' : 'Installed'} Support Office hooks (${EVENTS.length} events, port ${port}) in ${file}`);
