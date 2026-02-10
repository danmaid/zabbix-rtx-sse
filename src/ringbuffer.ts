import { ZabbixRtxEnvelope } from './types.js';

export class RingBuffer {
  private buf: (ZabbixRtxEnvelope | undefined)[];
  private cap: number;
  private head = 0; // 次に書く位置
  private count = 0;
  private nextId = 1;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    this.cap = capacity;
    this.buf = new Array(capacity);
  }

  push(item: Omit<ZabbixRtxEnvelope, 'id' | 'time'>): ZabbixRtxEnvelope {
    const env: ZabbixRtxEnvelope = {
      id: this.nextId++,
      time: Date.now(),
      ...item
    };
    this.buf[this.head] = env;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    return env;
  }

  latestId(): number {
    return this.nextId - 1;
  }

  query(opts: { family?: string; limit?: number; sinceId?: number; }): ZabbixRtxEnvelope[] {
    const limit = Math.max(1, Math.min(10000, opts.limit ?? 100));
    const sinceId = opts.sinceId ?? 0;
    const fam = opts.family;

    const out: ZabbixRtxEnvelope[] = [];
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.cap) % this.cap;
      const v = this.buf[idx];
      if (!v) continue;
      if (v.id <= sinceId) continue;
      if (fam && v.source.family !== fam) continue;
      out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }
}
