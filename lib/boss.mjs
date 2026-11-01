// Minimal MCP client (Streamable HTTP) for the BOSS server: initialize once, then tools/call.

const PROTOCOL_VERSION = '2025-06-18';

export class BossError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BossError';
    this.status = status;
  }
}

// A response may be plain JSON or an SSE stream carrying JSON-RPC messages.
export function parseSseMessages(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // ignore keep-alives and partial frames
    }
  }
  return messages;
}

// tools/call result → the JSON payload the BOSS tools return as text.
export function toolPayload(result) {
  const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (result?.isError) throw new BossError(text || 'Tool returned an error');
  if (result?.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    throw new BossError(`Unexpected tool answer: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Rate limit exceeded … Retry after 1s." → ms to wait, or null when it is another error.
export function rateLimitDelay(err) {
  const msg = String(err?.message ?? '');
  if (err?.status !== 429 && !/rate limit/i.test(msg)) return null;
  const m = /retry after (\d+(?:\.\d+)?)\s*s/i.exec(msg);
  return (m ? Number(m[1]) : 2) * 1000 + 300;
}

export function createBossClient({ url, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  let sessionId = null;
  let protocolVersion = PROTOCOL_VERSION;
  let nextId = 1;
  let ready = null;

  async function rpc(method, params, { notify = false } = {}) {
    const id = notify ? undefined : nextId++;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': protocolVersion,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j.error_description || j.error?.message || j.error || detail;
      } catch {
        // keep raw text
      }
      throw new BossError(`BOSS ${method} → HTTP ${res.status}: ${detail}`, res.status);
    }
    if (notify) return null;

    const type = res.headers.get('content-type') || '';
    const msg = type.includes('text/event-stream')
      ? parseSseMessages(await res.text()).find((m) => m.id === id)
      : await res.json();
    if (!msg) throw new BossError(`BOSS ${method}: no response`);
    if (msg.error) throw new BossError(`BOSS ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async function initialize() {
    sessionId = null;
    const result = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'support-office', version: '0.1.0' },
    });
    if (result?.protocolVersion) protocolVersion = result.protocolVersion;
    await rpc('notifications/initialized', {}, { notify: true });
  }

  async function callTool(name, args, attempt = 0) {
    if (!ready) ready = initialize().catch((err) => {
      ready = null;
      throw err;
    });
    await ready;
    try {
      return toolPayload(await rpc('tools/call', { name, arguments: args }));
    } catch (err) {
      // Session expired on the server: start a new one and try once more.
      if (attempt === 0 && (err.status === 404 || err.status === 400)) {
        ready = null;
        return callTool(name, args, 1);
      }
      // Rate limited: wait as long as the server asks, a few times.
      const wait = rateLimitDelay(err);
      if (wait !== null && attempt < 3) {
        await sleep(wait);
        return callTool(name, args, attempt + 1);
      }
      throw err;
    }
  }

  // Follow nextCursor; BOSS search tools answer {items, nextCursor}.
  async function listAll(name, args, maxPages = 10) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const answer = await callTool(name, cursor ? { ...args, cursor } : args);
      items.push(...(answer.items ?? []));
      cursor = answer.nextCursor;
      if (!cursor) return { items, cut: false };
    }
    return { items, cut: true };
  }

  return { callTool, listAll };
}
