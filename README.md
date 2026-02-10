# Zabbix Real-time Export → SSE/JSON (Node.js + TypeScript)

すべての機能を `/v1/events/zabbix/` に集約し、以下を提供します：

- `Accept: text/event-stream` → **SSE ストリーム**（EventSource）
- `Accept: application/json` → **リングバッファ内の最新イベント**（`?family=&limit=&sinceId=`）
- `Accept: text/html` または `*/*` → **デモ HTML**
- **OpenAPI** → `/v1/events/zabbix/openapi.json`

Zabbix のリアルタイムエクスポート（NDJSON）ディレクトリを監視し、複数ファイルを tail して配信します。

## 要件
- Node.js 18+

## 使い方
```bash
npm i
npm run build

# 実行前に環境変数を設定
export ZBX_RTX_DIR=/var/lib/zabbix/rt-export
export PORT=3000
export RB_CAPACITY=50000 HEARTBEAT_MS=20000 POLL_INTERVAL_MS=250 MAX_BACKOFF_MS=2000

npm start
```

- ブラウザ: `http://<host>:3000/v1/events/zabbix/` → デモ HTML（SSE が流れてくる）
- SSE クライアント: `new EventSource('/v1/events/zabbix/')`
- JSON スナップショット:
  ```bash
  curl -H 'Accept: application/json'     'http://<host>:3000/v1/events/zabbix/?family=problems&limit=200&sinceId=12345'
  ```
- OpenAPI: `http://<host>:3000/v1/events/zabbix/openapi.json`

## 設計メモ
- **ポーリング（fs.stat）を真実**に、`fs.watch` は **起床トリガ**。
- **開きっぱなし + 必要時のみ reopen**（inode 変化, size 縮小）。
- **リングバッファ**でベストエフォート再送（`sinceId`）。
- **SSE 心拍**: 20s コメント行。

## 注意
- `.ndjson.old` は無視対象。
- 本実装は依存パッケージなし（実行時）。
