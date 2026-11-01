// Activity feed (ring buffer) and SSE fan-out to every open browser tab.

const FEED_SIZE = 300;

export function createBus() {
  const clients = new Set();
  const feed = [];
  let seq = 0;

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  // kind: 'boss' | 'claude'; level: 'info' | 'attention'; type: e.g. 'assigned' for a task newly given to you
  function post({ kind, level = 'info', type = null, title, detail = '', task = null, session = null, app = null }) {
    const item = { id: ++seq, at: new Date().toISOString(), kind, level, type, title, detail, task, session, app };
    feed.push(item);
    if (feed.length > FEED_SIZE) feed.shift();
    broadcast('feed', item);
    return item;
  }

  function attach(req, res, snapshot, extraHeaders = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...extraHeaders,
    });
    res.write('retry: 3000\n\n');
    send(res, 'snapshot', { ...snapshot(), feed });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  return { post, broadcast, attach, feed, clientCount: () => clients.size };
}
