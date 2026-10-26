// Tiny stand-in for the Anthropic Messages API, for tests and screenshots without a real key.
// Usage: AI_STUB_PORT=8193 node server/test/ai-stub.mjs
//   POST /v1/messages      streaming (SSE) or plain JSON; key 'sk-ant-bad-key-0000' gets a 401
//   GET  /_requests        every request body received so far (and the key it carried: x-api-key or Bearer)
//   POST /_reset           forgets them
import http from 'node:http';

const PORT = Number(process.env.AI_STUB_PORT ?? 8193);
let requests = [];

const ANSWER = [
  '```sql\n',
  'select date_trunc(\'month\', o.created_at) as month,\n',
  '       count(*) as orders\n',
  'from public.orders o\n',
  'group by 1\n',
  'order by 1\n',
  'limit 100;\n',
  '```\n\n',
  'Counts orders per calendar month from orders.created_at. ',
  'I assumed every order counts, including refunded ones — say the word and I will filter on status.',
];

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    if (req.method === 'GET' && req.url === '/_requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(requests));
    }
    if (req.method === 'POST' && req.url === '/_reset') {
      requests = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
    }
    const body = JSON.parse(raw || '{}');
    const key = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ key, body });
    if (key === 'sk-ant-bad-key-0000') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    const id = 'msg_stub_' + requests.length;
    const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_stub' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { ...usage, output_tokens: 1 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_stub' });
    sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const delay = Number(process.env.AI_STUB_DELAY_MS ?? 15);
    for (const piece of ANSWER) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      await new Promise((r) => setTimeout(r, delay));
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 64 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log('ai stub on ' + PORT));
