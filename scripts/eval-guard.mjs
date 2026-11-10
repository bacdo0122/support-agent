#!/usr/bin/env node
// PreToolUse hook for a blind evaluation run: refuses any tool call that could show the answer of the task being
// evaluated (the task itself, its Crisp chat, the shop's DevHub, the app's own case files and logs).
// EVAL_BLOCK = comma-separated strings (task key, task id, Crisp session, shop domain) that must not appear in a call.

let raw = '';
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  let ev = {};
  try {
    ev = JSON.parse(raw);
  } catch {}
  const tool = String(ev.tool_name ?? '');
  const input = JSON.stringify(ev.tool_input ?? {});
  const block = String(process.env.EVAL_BLOCK ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const FILES = ['team-cases', 'cases.json', 'feedback.json', 'pipeline.json', 'lessons.json', '/support-agent/data', 'boss-autofix-logs/20', 'actions.jsonl', '.claude/projects'];
  // the run's own Sentry/store/image files are named after the task: those paths stay allowed (scrubbed below)
  let reason = null;
  if (/devhub_(read|write)$/.test(tool)) reason = 'DevHub của store có thể chứa đáp án';
  else if (/__(read_task_history|read_customer_tasks)$/.test(tool) && block.some((b) => input.includes(b))) reason = 'lịch sử của chính task';
  else {
    const scrubbed = input.replace(/[^"\s]*boss-autofix-logs\/(sentry|store|img|eval)\/[^"\s]*/g, '');
    const hit = block.find((b) => scrubbed.includes(b)) ?? FILES.find((f) => input.includes(f));
    if (hit) reason = `chạm vào dữ liệu có đáp án (${hit})`;
  }
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Đang chấm mù: ${reason}. Dùng dữ liệu đã có trong prompt và tiền lệ khác.` } }));
  }
  process.exit(0);
});
