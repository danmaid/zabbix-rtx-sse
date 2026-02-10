import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Family } from './types.js';

class NdjsonTailer extends EventEmitter {
  private filePath: string;
  private dir: string;
  private base: string;

  private intervalMs: number;
  private maxBackoffMs: number;
  private startAtEnd: boolean;

  private fd: fs.promises.FileHandle | null = null;
  private offset = 0;
  private inode: number | null = null;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private looping = false;

  private watcher: fs.FSWatcher | null = null;
  private idleBackoffMs: number;

  constructor(filePath: string, opts: { intervalMs: number; maxBackoffMs: number; startAtEnd: boolean }) {
    super();
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
    this.base = path.basename(filePath);

    this.intervalMs = opts.intervalMs;
    this.maxBackoffMs = opts.maxBackoffMs;
    this.startAtEnd = opts.startAtEnd;

    this.idleBackoffMs = this.intervalMs;
  }

  // 型付き on オーバーロード
  override on(event: 'ready', listener: (info: { file: string; size: number; inode: number }) => void): this;
  override on(event: 'info', listener: (info: Record<string, unknown>) => void): this;
  override on(event: 'warn', listener: (info: Record<string, unknown>) => void): this;
  override on(event: 'parse_error', listener: (info: { file: string; line: string; err: unknown }) => void): this;
  override on(event: 'data', listener: (info: { file: string; record: unknown }) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener); }

  async start() {
    this.stopped = false;
    await this.openFile();
    this.startWatcher();
    this.loop();
  }

  async stop() {
    console.log('[tailer.stop] start', this.filePath);
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopWatcher();
    await this.closeFile();
    console.log('[tailer.stop] complete', this.filePath);
  }

  private startWatcher() {
    try {
      this.watcher = fs.watch(this.dir, (_eventType, filename) => {
        if (filename && filename !== this.base) return;
        this.poke();
      });
      this.watcher.on('error', (err) => {
        this.emit('warn', { msg: 'fs.watch error', err, file: this.filePath });
        this.poke(true);
      });
    } catch (err) {
      this.emit('warn', { msg: 'startWatcher failed', err, file: this.filePath });
    }
  }

  private stopWatcher() {
    try { this.watcher?.close(); } catch { }
    this.watcher = null;
  }

  private poke(forceResync = false) {
    if (forceResync) {
      this.closeFile().then(() => this.openFile());
    }
    this.idleBackoffMs = this.intervalMs;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loop();
  }

  private async openFile() {
    try {
      const stats = await fs.promises.stat(this.filePath);
      this.inode = stats.ino;
      this.fd = await fs.promises.open(this.filePath, 'r');
      this.offset = this.startAtEnd ? stats.size : 0;
      this.emit('ready', { file: this.filePath, size: stats.size, inode: stats.ino });
    } catch (err) {
      this.emit('warn', { msg: 'openFile failed', err, file: this.filePath });
    }
  }

  private async closeFile() {
    if (this.fd) {
      try { await this.fd.close(); } catch { }
      this.fd = null;
    }
  }

  private async loop() {
    if (this.stopped) return;
    if (this.looping) return;
    this.looping = true;

    let progressed = false;
    try {
      const stats = await fs.promises.stat(this.filePath);

      if (this.inode != null && stats.ino !== this.inode) {
        this.emit('info', { msg: 'inode changed -> reopen', file: this.filePath, old: this.inode, new: stats.ino });
        await this.closeFile();
        this.inode = stats.ino;
        await this.openFile();
      }

      if (!this.fd) {
        // 未オープン（次回へ）
      } else if (stats.size < this.offset) {
        this.emit('info', { msg: 'size shrank -> reset offset', file: this.filePath, from: this.offset, to: 0 });
        this.offset = 0;
        this.buffer = '';
      } else if (stats.size > this.offset) {
        const toRead = stats.size - this.offset;
        const chunk = Buffer.allocUnsafe(Math.min(toRead, 64 * 1024));
        let readTotal = 0;

        while (readTotal < toRead) {
          const len = Math.min(chunk.length, toRead - readTotal);
          const { bytesRead } = await this.fd.read(chunk, 0, len, this.offset + readTotal);
          if (bytesRead === 0) break;
          readTotal += bytesRead;
          this.onBytes(chunk.subarray(0, bytesRead));
        }

        this.offset += readTotal;
        progressed = readTotal > 0;
      }
    } catch (err) {
      this.emit('warn', { msg: 'poll error', err, file: this.filePath });
      await this.closeFile();
      await this.openFile();
    } finally {
      this.looping = false;
      if (!this.stopped) {
        this.idleBackoffMs = progressed ? this.intervalMs : Math.min(this.idleBackoffMs * 2, this.maxBackoffMs);
        this.timer = setTimeout(() => this.loop(), this.idleBackoffMs);
      }
    }
  }

  private onBytes(bytes: Buffer) {
    let newLines = 0;
    this.buffer += bytes.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.emit('data', { file: this.filePath, record: line });
      newLines++;
    }
    if (newLines > 0) {
      this.emit('info', { msg: `emitted ${newLines} events from bytes`, file: this.filePath });
    }
  }

}

export class MultiNdjsonTailer extends EventEmitter {
  private dir: string;
  private patterns: RegExp[];
  private ignore: RegExp[];
  private tailOpts: { intervalMs: number; maxBackoffMs: number; startAtEnd: boolean };
  private tailers = new Map<string, NdjsonTailer>();
  private watcher: fs.FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private stopped = false;

  constructor(dirPath: string, opts: {
    patterns?: RegExp[];
    ignorePatterns?: RegExp[];
    intervalMs?: number;
    maxBackoffMs?: number;
    startAtEnd?: boolean;
  }) {
    super();
    this.dir = dirPath;
    this.patterns = opts.patterns ?? [
      /^(problems|history)-.*\.ndjson$/,
      /^problems-.*-(main-process|task-manager)-\d+\.ndjson$/,
      /^history-.*-(main-process|task-manager)-\d+\.ndjson$/
    ];
    this.ignore = opts.ignorePatterns ?? [/\.old$/];
    this.tailOpts = {
      intervalMs: opts.intervalMs ?? 250,
      maxBackoffMs: opts.maxBackoffMs ?? 2000,
      startAtEnd: opts.startAtEnd ?? true
    };
  }

  // 型付き on オーバーロード
  override on(event: 'ready', listener: (info: { file: string; size: number; inode: number }) => void): this;
  override on(event: 'info', listener: (info: Record<string, unknown>) => void): this;
  override on(event: 'warn', listener: (info: Record<string, unknown>) => void): this;
  override on(event: 'parse_error', listener: (info: { file: string; line: string; err: unknown }) => void): this;
  override on(event: 'data', listener: (info: { file: string; family: Family; record: unknown }) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener); }

  async start() {
    this.stopped = false;
    await this.scanNow();
    this.startWatcher();
  }

  async stop() {
    this.stopped = true;
    this.stopWatcher();
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }

    // Stop child tailers in parallel with per-tailer timeout to avoid long sequential shutdowns
    const stopPromises: Promise<void>[] = [];
    for (const [file, t] of this.tailers) {
      const p = (async () => {
        try {
          await Promise.race([
            t.stop(),
            new Promise<void>((_, rej) => setTimeout(() => rej(new Error('tailer.stop timeout')), 2000))
          ]);
        } catch (err) {
          this.emit('warn', { msg: 'tailer stop failed or timed out', file, err });
        }
      })();
      stopPromises.push(p);
    }
    await Promise.allSettled(stopPromises);
    this.tailers.clear();
  }

  private startWatcher() {
    try {
      this.watcher = fs.watch(this.dir, () => this.debouncedScan());
      this.watcher.on('error', (err) => {
        this.emit('warn', { msg: 'dir fs.watch error', err, dir: this.dir });
        this.debouncedScan();
      });
    } catch (err) {
      this.emit('warn', { msg: 'dir watch start failed', err, dir: this.dir });
    }
  }

  private stopWatcher() {
    try { this.watcher?.close(); } catch { }
    this.watcher = null;
  }

  private debouncedScan(delay = 150) {
    if (this.stopped) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => { if (!this.stopped) this.scanNow(); }, delay);
  }

  private async scanNow() {
    if (this.stopped) {
      this.emit('info', { msg: 'scanNow skipped - stopped', dir: this.dir });
      return;
    }
    if (this.scanning) {
      this.emit('info', { msg: 'scanNow skipped - already scanning', dir: this.dir });
      return;
    }
    this.scanning = true;
    try {
      const entries = await fs.promises.readdir(this.dir);
      const want = new Set(
        entries
          .filter(n => this.patterns.some(p => p.test(n)))
          .filter(n => !this.ignore.some(p => p.test(n)))
          .map(n => path.join(this.dir, n))
      );

      for (const abs of want) {
        if (this.stopped) break;
        if (this.tailers.has(abs)) continue;
        const t = new NdjsonTailer(abs, this.tailOpts);
        this.tailers.set(abs, t);

        if (this.stopped) {
          // If stop() was called concurrently, ensure we don't leave a running tailer
          try { await t.stop(); } catch { }
          this.tailers.delete(abs);
          continue;
        }

        t.on('ready', info => this.emit('ready', info));
        t.on('info', info => this.emit('info', info));
        t.on('warn', info => this.emit('warn', info));
        t.on('parse_error', info => this.emit('parse_error', info));
        t.on('data', ({ file, record }) => {
          const base = path.basename(file);
          const family: Family =
            base.startsWith('problems-') ? 'problems' :
              base.startsWith('history-') ? 'history' :
                base.includes('main-process') ? 'main-process' :
                  base.includes('task-manager') ? 'task-manager' :
                    'other';
          this.emit('data', { file, family, record });
        });

        t.start().catch(err => this.emit('warn', { msg: 'tailer start error', err, file: abs }));
      }

      for (const [abs, t] of this.tailers) {
        if (!want.has(abs)) {
          await t.stop();
          this.tailers.delete(abs);
          this.emit('info', { msg: 'tailer stopped', file: abs });
        }
      }
    } catch (err) {
      this.emit('warn', { msg: 'scan error', err, dir: this.dir });
    }
    finally {
      this.scanning = false;
    }
  }
}
