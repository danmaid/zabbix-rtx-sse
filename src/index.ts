import http from 'node:http';
import url from 'node:url';
import path from 'node:path';
import { MultiNdjsonTailer } from './tailer.js';
import { RingBuffer } from './ringbuffer.js';
import { openapi } from './openapi.js';

// ==== 環境変数 ====
const PORT = Number(process.env.PORT || 3000);
const ZBX_RTX_DIR = process.env.ZBX_RTX_DIR || path.resolve('./zbx-rtx');
const RB_CAPACITY = Number(process.env.RB_CAPACITY || 50000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 20000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 250);
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS || 2000);

// ==== SSE Hub ====
class SseHub {
  private clients = new Set<http.ServerResponse>();
  private timer: NodeJS.Timeout | null = null;

  add(res: http.ServerResponse) { this.clients.add(res); }
  delete(res: http.ServerResponse) { this.clients.delete(res); }

  heartbeatStart() {
    this.heartbeatStop();
    this.timer = setInterval(() => {
      for (const res of this.clients) res.write(`: hb ${Date.now()}

`);
    }, HEARTBEAT_MS);
  }
  heartbeatStop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  broadcast(event: string, payload: unknown, id?: number) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const res of this.clients) {
      if (id != null) res.write(`id: ${id}
`);
      if (event) res.write(`event: ${event}
`);
      res.write(`data: ${data}

`);
    }
  }
}

const hub = new SseHub();
const ring = new RingBuffer(RB_CAPACITY);

// ==== Tailer ====
const multi = new MultiNdjsonTailer(ZBX_RTX_DIR, {
  intervalMs: POLL_INTERVAL_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  startAtEnd: true,
});

multi.on('ready', info => console.log('[tailer] ready', info));
multi.on('info', info => console.log('[tailer]', info));
multi.on('warn', info => console.warn('[tailer]', info));
multi.on('parse_error', info => console.warn('[tailer] parse_error', info.err, 'file=', info.file));

multi.on('data', ({ file, family, record }) => {
  const env = ring.push({ source: { file: path.basename(file), family }, record });
  const evt = `zabbix.${family}`;
  const payload = { source: env.source, record: env.record };
  hub.broadcast(evt, payload, env.id);
});

function negotiate(accept: string | undefined): 'sse' | 'json' | 'html' {
  const a = (accept || '').toLowerCase();
  if (a.includes('text/event-stream')) return 'sse';
  if (a.includes('application/json')) return 'json';
  return 'html';
}

function sendJson(res: http.ServerResponse, obj: unknown) {
  const data = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
}

const DEMO_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Zabbix NDJSON → SSE/JSON</title>
<style>
  body { font: 14px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 20px; }
  pre { background: #111; color: #0f0; padding: 12px; border-radius: 8px; height: 50vh; overflow: auto; }
</style>
<h1>Zabbix NDJSON → SSE/JSON</h1>
<p>接続先: <code>/v1/events/zabbix/</code>（SSE）</p>
<p><button id="pause">Pause</button> <button id="resume">Resume</button></p>
<pre id="log"></pre>
<script>
  let paused = false;
  const log = document.getElementById('log');
  function println(s){ log.textContent += s + "
"; log.scrollTop = log.scrollHeight; }
  const es = new EventSource('/v1/events/zabbix/');
  es.addEventListener('zabbix.problems', e => { if (!paused) println("[problems] " + e.data); });
  es.addEventListener('zabbix.history',  e => { if (!paused) println("[history ] " + e.data); });
  es.addEventListener('zabbix.main-process', e => { if (!paused) println("[main   ] " + e.data); });
  es.addEventListener('zabbix.task-manager', e => { if (!paused) println("[task   ] " + e.data); });
  es.addEventListener('zabbix.other', e => { if (!paused) println("[other  ] " + e.data); });
  es.onerror = e => println("[error] " + (e?.message || e));
  document.getElementById('pause').onclick = () => paused = true;
  document.getElementById('resume').onclick = () => paused = false;
</script>`;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '', true);
  const pathname = parsed.pathname || '';

  if (pathname === '/v1/events/zabbix/openapi.json') {
    return sendJson(res, openapi);
  }

  if (pathname === '/v1/events/zabbix/') {
    const mode = negotiate(req.headers['accept']);
    if (mode === 'sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`: connected

`);
      hub.add(res);
      req.on('close', () => { hub.delete(res); try { res.end(); } catch {} });
      return;
    }

    if (mode === 'json') {
      const q = parsed.query || {};
      const family = typeof q.family === 'string' ? q.family : undefined;
      const limit = q.limit != null ? Number(q.limit) : undefined;
      const sinceId = q.sinceId != null ? Number(q.sinceId) : undefined;

      const items = ring.query({ family, limit, sinceId });
      return sendJson(res, { latestId: ring.latestId(), items });
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DEMO_HTML);
    return;
  }

  if (pathname === '/') {
    res.writeHead(302, { Location: '/v1/events/zabbix/' });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, async () => {
  console.log(`[http] http://localhost:${PORT}  (SSE/JSON/HTML: /v1/events/zabbix/, OpenAPI: /v1/events/zabbix/openapi.json)`);
  // 心拍開始
  setInterval(() => {
    for (const res of (hub as any).clients as Set<http.ServerResponse>) {
      try { res.write(`: hb ${Date.now()}

`); } catch {}
    }
  }, HEARTBEAT_MS);
  await multi.start();
});

// Graceful shutdown
const shutdown = async () => {
  console.log('[shutdown]');
  await multi.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
