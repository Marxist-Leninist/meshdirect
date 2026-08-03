'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { SGToolGateway } = require('../server/sgtools');

test('SG gateway searches the catalog and calls a selected MCP tool', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'memory_search', description: 'Search memory', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: '{"matches":2}' }], isError: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const cfg = {
    sgServers: { sg1: { url }, sg2: { url } },
    sgCatalogTtlMs: 60_000,
    sgCallTimeoutMs: 5_000,
    maxToolResultChars: 20_000,
  };
  const gateway = new SGToolGateway(cfg);
  const found = await gateway.execute('sg1', { action: 'search', query: 'memory' });
  assert.equal(found.tools[0].name, 'memory_search');
  const called = await gateway.execute('sg2', {
    action: 'call', name: 'memory_search', arguments: { query: 'Qwen' }, timeout: 2,
  });
  assert.equal(called.server, 'sg2');
  assert.equal(called.result, '{"matches":2}');
  assert.deepEqual(requests.map((request) => request.method), ['tools/list', 'tools/call']);
  assert.deepEqual(requests[1].params.arguments, { query: 'Qwen' });
});

test('SG gateway rejects ambiguous or malformed requests before network I/O', async () => {
  const gateway = new SGToolGateway({
    sgServers: {
      sg1: { url: 'http://127.0.0.1:1/mcp' },
      sg2: { url: 'http://127.0.0.1:1/mcp' },
    },
    sgCatalogTtlMs: 60_000,
    sgCallTimeoutMs: 5_000,
    maxToolResultChars: 20_000,
  });

  await assert.rejects(gateway.execute('sg1', {}), /action must be exactly/);
  await assert.rejects(gateway.execute('sg1', { action: 'invalid', name: 'shell' }), /action must be exactly/);
  await assert.rejects(gateway.execute('sg1', '{bad json'), /must be a valid JSON object/);
  await assert.rejects(gateway.execute('sg1', []), /must be a valid JSON object/);
  await assert.rejects(gateway.execute('sg1', {
    action: 'call', name: 'shell', arguments: '{bad json',
  }), /tool arguments must be a valid JSON object/);
  await assert.rejects(gateway.execute('other', { action: 'search' }), /Unknown SG server/);
});
