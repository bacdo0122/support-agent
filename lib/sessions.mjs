// Tracks Claude Code sessions from hook events (SessionStart, UserPromptSubmit, PreToolUse,
// PostToolUse, Notification, Stop, SubagentStop, SessionEnd).

import { basename } from 'node:path';

const TASK_RE = /\bSBCB2BBS-\d+\b/i;
const ENDED_TTL = 10 * 60000;
const STALE_TTL = 3 * 3600000;

const clip = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function findTaskKey(value) {
  const m = TASK_RE.exec(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  return m ? m[0].toUpperCase() : null;
}

// One short line describing a tool call, without dumping its whole input.
export function describeTool(name = '', input = {}) {
  const short = name.startsWith('mcp__') ? name.split('__').slice(-1)[0] : name;
  switch (name) {
    case 'Bash':
      return `Chạy lệnh: ${clip(input.command, 120)}`;
    case 'Read':
      return `Đọc ${basename(String(input.file_path ?? ''))}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Sửa ${basename(String(input.file_path ?? ''))}`;
    case 'Grep':
    case 'Glob':
      return `Tìm: ${clip(input.pattern, 80)}`;
    case 'WebFetch':
      return `Mở web: ${clip(input.url, 100)}`;
    case 'WebSearch':
      return `Tra web: ${clip(input.query, 100)}`;
    case 'Task':
    case 'Agent':
      return `Gọi trợ lý ${input.subagent_type ?? ''}: ${clip(input.description, 80)}`.replace('  ', ' ');
    case 'Skill':
      return `Dùng skill /${input.skill ?? input.command ?? ''}`;
    default:
      if (name.startsWith('mcp__')) {
        const server = name.split('__')[1]?.replace(/^claude_ai_/, '') ?? '';
        const key = findTaskKey(input);
        return `${server}: ${short}${key ? ' ' + key : ''}`;
      }
      return short || 'Công cụ';
  }
}

export function createSessions({ bus, onChange }) {
  const sessions = new Map();

  function touch(id, cwd) {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        project: cwd ? basename(cwd) : id.slice(0, 8),
        cwd: cwd ?? '',
        status: 'idle',
        task: null,
        skill: null,
        prompt: '',
        lastAction: '',
        waitingFor: '',
        subagents: 0,
        startedAt: new Date().toISOString(),
        updatedAt: null,
      };
      sessions.set(id, s);
    }
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      s.project = basename(cwd);
    }
    s.updatedAt = new Date().toISOString();
    return s;
  }

  function post(s, level, title, detail = '') {
    bus.post({ kind: 'claude', level, title, detail, task: s.task, session: { id: s.id, project: s.project } });
  }

  function handle(ev) {
    const id = ev?.session_id;
    if (!id) return null;
    const s = touch(id, ev.cwd);
    const name = ev.hook_event_name;

    switch (name) {
      case 'SessionStart':
        s.status = 'idle';
        post(s, 'info', 'Mở phiên', ev.source ? `(${ev.source})` : '');
        break;

      case 'UserPromptSubmit': {
        const prompt = String(ev.prompt ?? '');
        s.status = 'working';
        s.waitingFor = '';
        s.prompt = clip(prompt, 160);
        const skill = /^\/([\w:.-]+)/.exec(prompt.trim());
        if (skill) s.skill = skill[1];
        const key = findTaskKey(prompt);
        if (key) s.task = key;
        post(s, 'info', key || skill ? `Nhận việc${key ? ' ' + key : ''}` : 'Nhận yêu cầu mới', clip(prompt, 160));
        break;
      }

      case 'PreToolUse': {
        s.status = 'working';
        s.waitingFor = '';
        s.lastAction = describeTool(ev.tool_name, ev.tool_input);
        if (!s.task && String(ev.tool_name).includes('BOSS')) s.task = findTaskKey(ev.tool_input);
        if (ev.tool_name === 'Skill' && ev.tool_input?.skill) s.skill = ev.tool_input.skill;
        if (ev.tool_name === 'Task' || ev.tool_name === 'Agent') {
          s.subagents += 1;
          post(s, 'info', s.lastAction);
        }
        break;
      }

      case 'PostToolUse':
        // Also fires after a permission prompt was approved.
        if (s.status === 'waiting') post(s, 'info', 'Đã được duyệt', s.lastAction);
        s.status = 'working';
        s.waitingFor = '';
        break;

      case 'Notification': {
        const msg = String(ev.message ?? '');
        const isPermission = ev.notification_type === 'permission_prompt' || /permission/i.test(msg);
        if (isPermission) {
          s.status = 'waiting';
          s.waitingFor = s.lastAction || msg;
          post(s, 'attention', 'Chờ bạn duyệt', s.waitingFor);
        } else {
          s.status = 'idle';
          s.waitingFor = '';
          post(s, 'attention', 'Đang chờ bạn trả lời', clip(msg, 120));
        }
        break;
      }

      case 'Stop':
        s.status = 'idle';
        s.waitingFor = '';
        s.subagents = 0;
        post(s, 'info', 'Xong lượt, chờ bạn', s.lastAction);
        break;

      case 'SubagentStop':
        s.subagents = Math.max(0, s.subagents - 1);
        break;

      case 'SessionEnd':
        s.status = 'ended';
        s.waitingFor = '';
        post(s, 'info', 'Đóng phiên', ev.reason ? `(${ev.reason})` : '');
        break;

      default:
        return null;
    }
    onChange?.(s);
    return s;
  }

  // Drop ended sessions after a while, and sessions that went silent (closed without SessionEnd).
  function prune(now = Date.now()) {
    for (const [id, s] of sessions) {
      const age = now - Date.parse(s.updatedAt);
      if ((s.status === 'ended' && age > ENDED_TTL) || age > STALE_TTL) {
        sessions.delete(id);
        onChange?.({ ...s, removed: true });
      }
    }
  }

  return { handle, prune, list: () => [...sessions.values()] };
}
