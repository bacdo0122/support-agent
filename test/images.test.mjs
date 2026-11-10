import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagePaths, fetchTaskImages, imagesNote } from '../lib/images.mjs';
import { denialsOf, PROFILES } from '../lib/claude.mjs';

test('imagePaths finds description src, attachment url and absolute links once', () => {
  const desc = '<p><img src="/file-view/task/a/x.png?w=1"></p><a href="https://boss.bss-b2b.solutions/file-view/task/a/y.jpg">y</a><a href="/file-view/doc.pdf">pdf</a>';
  const comments = { items: [{ content: '<img src=\\"/file-view/task/a/x.png\\">', attachments: [{ url: '/file-view/c/z.webp' }] }] };
  assert.deepEqual(imagePaths(desc), ['/file-view/task/a/x.png', '/file-view/task/a/y.jpg']);
  assert.deepEqual(imagePaths(comments), ['/file-view/task/a/x.png', '/file-view/c/z.webp']);
});

test('fetchTaskImages saves images, reports failures, and the note lists files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'img-test-'));
  try {
    const client = { callTool: async (name) => (name === 'read_task'
      ? { description: '<img src="/file-view/t/a.png">' }
      : { items: [{ attachments: [{ url: '/file-view/c/b.png' }, { url: '/file-view/c/a.png' }] }] }) };
    const fetchImpl = async (url) => (url.endsWith('/b.png')
      ? { ok: false, status: 404 }
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer });
    const list = await fetchTaskImages({ client, key: 'K-1', dir, fetchImpl });
    assert.equal(list.length, 3);
    assert.equal(list[0].from, 'description');
    assert.equal(await readFile(list[0].file, 'utf8'), 'PNG');
    assert.match(list[1].error, /404/);
    const note = imagesNote(list);
    assert.match(note, /BẮT BUỘC Read/);
    assert.ok(note.includes(list[0].file));
    assert.match(note, /Không tải được/);
    assert.equal(imagesNote([]), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('analysis runs in auto mode like the CLI; writes needing approval stay denied', () => {
  const a = PROFILES.analyze;
  assert.equal(a.mode, 'auto');
  for (const t of ['mcp__claude_ai_BOSS-SBC__add_task_comment', 'mcp__claude_ai_BOSS-SBC__devhub_write', 'mcp__claude_ai_BOSS-SBC__update_task', 'Edit', 'Bash(git -C * push:*)'])
    assert.ok(a.denied.includes(t), t);
  assert.ok(a.allowed.includes('mcp__claude_ai_BOSS-SBC__devhub_read'));
  assert.ok(!a.denied.some((t) => /evaluate_script|__click/.test(t)));
  for (const p of ['devhub', 'status', 'comment', 'lesson']) assert.equal(PROFILES[p].mode, undefined);
});

test('denialsOf shortens refused tool calls', () => {
  assert.deepEqual(denialsOf({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'cd x && curl y' } }, { tool_name: 'mcp__claude_ai_BOSS-SBC__devhub_read', tool_input: { method: 'history' } }] }),
    [{ tool: 'Bash', input: 'cd x && curl y' }, { tool: 'boss:devhub_read', input: '{"method":"history"}' }]);
  assert.deepEqual(denialsOf({}), []);
});
