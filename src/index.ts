import http from 'node:http';
import net from 'node:net';
import url from 'node:url';
import path from 'node:path';
import { MultiNdjsonTailer } from './tailer.js';
import { RingBuffer } from './ringbuffer.js';
import { openapi } from './openapi.js';

// ==== 環境変数 ====
const PORT = Number(process.env.PORT || 3000);
const ZBX_RTX_DIR = process.env.ZBX_RTX_DIR || path.resolve('./zbx-rtx');
const RB_CAPACITY = Number(process.env.RB_CAPACITY || 1000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 20000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 250);
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS || 2000);

// ==== SSE Hub ====
class SseHub {
  private clients = new Set<http.ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private dropThreshold: number;

  constructor(dropThreshold = Number(process.env.SSE_DROP_THRESHOLD || 64 * 1024)) {
    this.dropThreshold = dropThreshold;
  }

  add(res: http.ServerResponse) { this.clients.add(res); }
  delete(res: http.ServerResponse) { this.clients.delete(res); }

  heartbeatStart() {
    this.heartbeatStop();
    this.timer = setInterval(() => {
      const pkt = `: hb ${Date.now()}\n\n`;
      for (const res of this.clients) this.safeWrite(res, pkt);
    }, HEARTBEAT_MS);
  }
  heartbeatStop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Close all clients and stop heartbeat
  close() {
    this.heartbeatStop();
    for (const res of this.clients) {
      try { res.end(); } catch { }
    }
    this.clients.clear();
  }

  private safeWrite(res: http.ServerResponse, pkt: string) {
    try {
      const w = res as any;
      if (w.writableEnded || w.destroyed || w.writable === false) { this.delete(res); return; }
      const pending = typeof w.writableLength === 'number' ? w.writableLength : 0;
      if (pending >= this.dropThreshold) return; // drop this message for this client
      res.write(pkt);
    } catch {
      try { res.end(); } catch { }
      this.delete(res);
    }
  }

  broadcast(event: string, payload: unknown, id?: number) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const lines: string[] = [];
    if (id != null) lines.push(`id: ${id}\n`);
    if (event) lines.push(`event: ${event}\n`);
    lines.push(`data: ${data}\n\n`);
    const pkt = lines.join('');
    for (const res of this.clients) this.safeWrite(res, pkt);
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
  hub.broadcast(evt, env.record, env.id);
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
<title>Zabbix NDJSON → SSE/JSON (Counts)</title>
<style>
  body { font: 14px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 20px; }
  pre { background: #111; color: #0f0; padding: 12px; border-radius: 8px; height: 50vh; overflow: auto; }
</style>
<h1>Zabbix NDJSON → SSE/JSON</h1>
<p>接続先: <code>/v1/events/zabbix/</code>（SSE）</p>
<p><button id="pause">Pause</button> <button id="resume">Resume</button></p>
<pre id="log"></pre>
<script>
  (async function(){
    let paused = false;
    const log = document.getElementById('log');

    const counts = { total: 0, problems: 0, history: 0, 'main-process': 0, 'task-manager': 0, other: 0 };

    function render(){
      const lines = [
        'total: ' + counts.total,
        'problems: ' + counts.problems,
        'history: ' + counts.history,
        'main-process: ' + counts['main-process'],
        'task-manager: ' + counts['task-manager'],
        'other: ' + counts.other,
      ];
      log.textContent = lines.join('\\n');
      log.scrollTop = log.scrollHeight;
    }

    function incType(t){
      counts.total++;
      if (t && counts[t] != null) counts[t]++;
      else counts.other++;
      render();
    }

    // Fetch recent items via JSON API for initial view (count only)
    try {
      const resp = await fetch('/v1/events/zabbix/?limit=100', { headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const j = await resp.json();
        if (j.items && Array.isArray(j.items)) {
          for (const it of j.items) {
            const fam = (it && it.source && it.source.family) ? it.source.family : 'other';
            if (!paused) incType(fam);
          }
        }
      } else {
        log.textContent = '[fetch] HTTP ' + resp.status;
      }
    } catch (err) { log.textContent = '[fetch] ' + err; }

    const es = new EventSource('/v1/events/zabbix/');
    es.onopen = () => { /* connected */ };
    es.addEventListener('zabbix.problems', e => { if (!paused) incType('problems'); });
    es.addEventListener('zabbix.history',  e => { if (!paused) incType('history'); });
    es.addEventListener('zabbix.main-process', e => { if (!paused) incType('main-process'); });
    es.addEventListener('zabbix.task-manager', e => { if (!paused) incType('task-manager'); });
    es.addEventListener('zabbix.other', e => { if (!paused) incType('other'); });
    es.onerror = e => { /* ignore errors for demo */ };

    document.getElementById('pause').onclick = () => paused = true;
    document.getElementById('resume').onclick = () => paused = false;

    render();
  })();
</script>

`;

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
      req.on('close', () => { hub.delete(res); try { res.end(); } catch { } });
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

// Track open sockets so we can forcefully destroy them on shutdown
const sockets = new Set<net.Socket>();
server.on('connection', (sock) => {
  sockets.add(sock);
  sock.on('close', () => sockets.delete(sock));
});

server.listen(PORT, async () => {
  console.log(`[http] http://localhost:${PORT}  (SSE/JSON/HTML: /v1/events/zabbix/, OpenAPI: /v1/events/zabbix/openapi.json)`);
  // 心拍開始
  hub.heartbeatStart();
  await multi.start();
});

// Graceful shutdown
const shutdown = async () => {
  if ((process as any).__shuttingDown) return;
  (process as any).__shuttingDown = true;
  console.log('[shutdown]');
  try { hub.close(); } catch (err) { console.error('[shutdown] hub.close error', err); }

  // Give tailer a chance to stop
  try { await multi.stop(); } catch (err) { console.error('[shutdown] multi.stop error', err); }

  // Close server and wait; force exit after timeout
  const force = setTimeout(() => {
    console.error('[shutdown] force exit');
    process.exit(1);
  }, 5000);

  // Destroy any remaining sockets to accelerate close
  try {
    for (const s of sockets) {
      try { s.destroy(); } catch { }
    }
  } catch (err) { console.error('[shutdown] destroy sockets error', err); }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
