export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Zabbix Real-time Export → SSE/JSON',
    version: '0.1.0',
    description:
      'Zabbix NDJSON (real-time export) multi-tail → /v1/events/zabbix/ で SSE / JSON を返す'
  },
  paths: {
    '/v1/events/zabbix/': {
      get: {
        summary: 'SSE または JSON（コンテンツネゴシエーション）',
        description:
          'Accept により応答を切替。text/event-stream=リアルタイムSSE、application/json=リングバッファのスナップショット、text/htmlまたは */*=デモHTML。',
        parameters: [
          { name: 'family', in: 'query', schema: { type: 'string', enum: ['problems','history','main-process','task-manager','other'] }, description: 'application/json のみ有効。特定ファミリに絞り込み。' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 100 }, description: 'application/json のみ有効。返却件数。' },
          { name: 'sinceId', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'application/json のみ有効。このIDより新しいイベントを返す（ベストエフォート）。' }
        ],
        responses: {
          '200': { description: 'OK', content: {
            'text/event-stream': { schema: { type: 'string', example: `id: 123
event: zabbix.problems
data: {\"source\":{\"file\":\"problems-history-syncer-1.ndjson\",\"family\":\"problems\"},\"record\":{}}

` } },
            'application/json': { schema: { type: 'object', properties: {
              latestId: { type: 'integer' },
              items: { type: 'array', items: { type: 'object', properties: {
                id: { type: 'integer' }, time: { type: 'integer' },
                source: { type: 'object', properties: { file: { type: 'string' }, family: { type: 'string' } }, required: ['file','family'] },
                record: { type: 'object' }
              }, required: ['id','time','source','record'] } }
            }, required: ['latestId','items'] } },
            'text/html': { schema: { type: 'string' } }
          } }
        }
      }
    },
    '/v1/events/zabbix/openapi.json': { get: { summary: 'OpenAPI JSON', responses: { '200': { description: 'OpenAPI document (JSON)' } } } }
  },
  servers: [{ url: '/' }]
} as const;
