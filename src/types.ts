export type Family =
  | 'problems'
  | 'history'
  | 'main-process'
  | 'task-manager'
  | 'other';

export interface ZabbixRtxEnvelope {
  id: number;     // サーバ採番（SSE id と一致）
  time: number;   // enqueue 時刻 (ms)
  source: { file: string; family: Family };
  record: unknown; // NDJSON 1 行分
}
