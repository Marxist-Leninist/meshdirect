// Exercises the five agent capabilities against a temp state dir, with no
// provider calls and no live service involvement.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcaps-'));
const config = {
  stateDir: dir,
  sessionsDir: path.join(dir, 'sessions'),
  username: 'testowner',
  lanes: { preview: { modelId: 'qwen3.8-max-preview' }, stable: { modelId: 'qwen3.8-max' } },
  sgServers: { sg1: { url: 'http://127.0.0.1:1/mcp' }, sg2: { url: 'http://127.0.0.1:1/mcp' } },
  sgCallTimeoutMs: 5000,
  sgCatalogTtlMs: 60000,
  maxToolResultChars: 60000,
  systemPrompt: 'test',
  maxQueuePerLane: 2,
};

const { CapabilityGateway, CAP_TOOLS } = require('/opt/meshdirect/server/agentcaps');
const caps = new CapabilityGateway(config, () => {});

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + (e && e.message)); failed++; }
}

(async () => {
  console.log('== tool specs ==');
  await check('6 capability tools exposed', () => {
    const names = CAP_TOOLS.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ['goals', 'mcp_servers', 'memory', 'schedule', 'skills', 'subagent']);
  });
  await check('every tool has a valid JSON schema', () => {
    for (const t of CAP_TOOLS) {
      assert.strictEqual(t.type, 'function');
      assert.ok(t.function.description.length > 40, `${t.function.name} description too thin`);
      assert.strictEqual(t.function.parameters.type, 'object');
      assert.ok(Array.isArray(t.function.parameters.required));
    }
  });

  console.log('== memory ==');
  await check('remember + recall round-trips', async () => {
    await caps.execute('memory', { action: 'remember', key: 'geth-nginx', text: 'GETH nginx runs as agillm43-infer-edge.service, not nginx.service', tags: ['infra'] });
    const got = await caps.execute('memory', { action: 'recall', key: 'geth-nginx' });
    assert.match(got.memory.text, /agillm43-infer-edge/);
  });
  await check('same key updates instead of duplicating', async () => {
    await caps.execute('memory', { action: 'remember', key: 'geth-nginx', text: 'updated fact' });
    const list = await caps.execute('memory', { action: 'list', limit: 50 });
    assert.strictEqual(list.memories.filter((m) => m.key === 'geth-nginx').length, 1);
    const got = await caps.execute('memory', { action: 'recall', key: 'geth-nginx' });
    assert.strictEqual(got.memory.text, 'updated fact');
  });
  await check('search finds by text and by tag', async () => {
    await caps.execute('memory', { action: 'remember', key: 'ports', text: 'PRIME listens on 8095 not 8080', tags: ['infra', 'ports'] });
    assert.ok((await caps.execute('memory', { action: 'search', query: '8095' })).matched >= 1);
    assert.ok((await caps.execute('memory', { action: 'search', tags: ['ports'] })).matched >= 1);
  });
  await check('survives a restart (new gateway, same dir)', async () => {
    const fresh = new CapabilityGateway(config, () => {});
    const got = await fresh.execute('memory', { action: 'recall', key: 'ports' });
    assert.match(got.memory.text, /8095/);
  });
  await check('forget removes it', async () => {
    await caps.execute('memory', { action: 'remember', key: 'temp', text: 'delete me' });
    await caps.execute('memory', { action: 'forget', key: 'temp' });
    await assert.rejects(() => caps.execute('memory', { action: 'recall', key: 'temp' }));
  });
  await check('remember with no text is rejected', async () => {
    await assert.rejects(() => caps.execute('memory', { action: 'remember', key: 'x' }));
  });

  console.log('== skills ==');
  await check('save + read round-trips', async () => {
    await caps.execute('skills', { action: 'save', name: 'promote-checkpoint', content: '# Promote\nRun the transactional promoter, never hand-pin bridge.env.' });
    const got = await caps.execute('skills', { action: 'read', name: 'promote-checkpoint' });
    assert.match(got.content, /transactional promoter/);
  });
  await check('list derives a description from the body', async () => {
    const { skills } = await caps.execute('skills', { action: 'list' });
    const s = skills.find((x) => x.name === 'promote-checkpoint');
    assert.match(s.description, /transactional promoter/);
  });
  await check('path traversal in the name is rejected', async () => {
    await assert.rejects(() => caps.execute('skills', { action: 'save', name: '../../etc/passwd', content: 'x' }));
    await assert.rejects(() => caps.execute('skills', { action: 'read', name: '../config' }));
  });
  await check('delete works and read then fails', async () => {
    await caps.execute('skills', { action: 'save', name: 'tmp-skill', content: '# t\nbody' });
    await caps.execute('skills', { action: 'delete', name: 'tmp-skill' });
    await assert.rejects(() => caps.execute('skills', { action: 'read', name: 'tmp-skill' }));
  });

  console.log('== prompt context ==');
  await check('skill index and memories reach the system prompt', () => {
    const ctx = caps.promptContext();
    assert.match(ctx, /promote-checkpoint/);
    assert.match(ctx, /8095/);
  });

  console.log('== mcp_servers ==');
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      const payload = rpc.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'echo something back', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: `echoed:${JSON.stringify(rpc.params.arguments)}` }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: payload }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}/mcp`;

  await check('add probes a legacy server and records stateless fallback', async () => {
    const out = await caps.execute('mcp_servers', { action: 'add', name: 'testsrv', url: fakeUrl, note: 'unit test', transport: 'stateless' });
    assert.strictEqual(out.added, true);
    assert.strictEqual(out.toolCount, 1);
    assert.strictEqual(out.negotiatedTransport, 'stateless');
  });
  await check('an unreachable server is refused, not silently stored', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', { action: 'add', name: 'deadsrv', url: 'http://127.0.0.1:1/mcp', timeout: 2 }));
    const { servers } = await caps.execute('mcp_servers', { action: 'list' });
    assert.ok(!servers.find((s) => s.name === 'deadsrv'));
  });
  await check('shadowing a built-in name is refused', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', { action: 'add', name: 'sg1', url: fakeUrl }));
  });
  await check('a non-http url is refused', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', { action: 'add', name: 'bad', url: 'file:///etc/passwd' }));
  });
  await check('search and call work against the registered server', async () => {
    const found = await caps.execute('mcp_servers', { action: 'search', name: 'testsrv', query: 'echo' });
    assert.strictEqual(found.matched, 1);
    const called = await caps.execute('mcp_servers', { action: 'call', name: 'testsrv', tool: 'echo', arguments: { a: 1 } });
    assert.match(called.result, /echoed:\{"a":1\}/);
  });
  await check('registration persists across a restart', async () => {
    const fresh = new CapabilityGateway(config, () => {});
    const { servers } = await fresh.execute('mcp_servers', { action: 'list' });
    assert.ok(servers.find((s) => s.name === 'testsrv'));
  });


  const currentRequests = [];
  let headerMismatchOnce = false;
  process.env.TEST_MCP_BEARER = 'current-secret-token';
  const current = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      currentRequests.push({ method: rpc.method, headers: { ...req.headers }, params: rpc.params });
      if (req.headers.authorization !== `Bearer ${process.env.TEST_MCP_BEARER}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'auth required' } }));
        return;
      }
      if (req.headers['mcp-protocol-version'] !== '2026-07-28') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          error: {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: ['2026-07-28'], requested: req.headers['mcp-protocol-version'] },
          },
        }));
        return;
      }
      assert.strictEqual(req.headers['mcp-method'], rpc.method);
      assert.strictEqual(rpc.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
      assert.strictEqual(rpc.params._meta['io.modelcontextprotocol/clientInfo'].name, 'MeshDirect');
      assert.deepStrictEqual(rpc.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
      if (rpc.method === 'server/discover') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        }));
        return;
      }
      const currentTool = {
        name: 'current_echo', description: 'current echo',
        inputSchema: {
          type: 'object',
          properties: {
            region: { type: 'string', 'x-mcp-header': 'Region' },
            count: { type: 'integer', 'x-mcp-header': 'Count' },
            nested: {
              type: 'object',
              properties: { flag: { type: 'boolean', 'x-mcp-header': 'Flag' } },
            },
          },
        },
      };
      if (rpc.method === 'tools/call' && headerMismatchOnce) {
        headerMismatchOnce = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          error: { code: -32020, message: 'Mirrored header schema changed' },
        }));
        return;
      }
      let payload;
      if (rpc.method === 'tools/list') {
        if (Object.prototype.hasOwnProperty.call(rpc.params, 'cursor')) {
          assert.strictEqual(rpc.params.cursor, '', 'empty-string cursors are opaque and must be followed');
          payload = { tools: [currentTool] };
        } else {
          payload = {
            tools: [
              currentTool,
              {
                name: 'invalid_header_tool', description: 'must be filtered',
                inputSchema: {
                  type: 'object',
                  properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } },
                },
              },
            ],
            nextCursor: '',
          };
        }
      } else {
        payload = { content: [{ type: 'text', text: `current:${JSON.stringify(rpc.params.arguments)}` }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: payload }));
    });
  });
  await new Promise((resolve) => current.listen(0, '127.0.0.1', resolve));
  const currentUrl = `http://127.0.0.1:${current.address().port}/mcp`;

  await check('current stateless HTTP sends standard headers and resolves bearer auth without persisting it', async () => {
    const added = await caps.execute('mcp_servers', {
      action: 'add',
      name: 'current',
      url: currentUrl,
      transport: 'current-http',
      bearer_token_env: 'TEST_MCP_BEARER',
    });
    assert.strictEqual(added.negotiatedTransport, 'current-http');
    assert.strictEqual(added.protocolVersion, '2026-07-28');
    assert.strictEqual(added.toolCount, 1, 'invalid x-mcp-header tools must be excluded');
    assert.ok(currentRequests.some((request) => (
      request.method === 'tools/list'
      && Object.prototype.hasOwnProperty.call(request.params, 'cursor')
      && request.params.cursor === ''
    )), 'empty-string pagination cursor was not followed');
    const called = await caps.execute('mcp_servers', {
      action: 'call', name: 'current', tool: 'current_echo',
      arguments: { modern: true, region: 'Hello, 世界', count: 42, nested: { flag: false } },
    });
    assert.match(called.result, /"modern":true/);
    const callRequest = currentRequests.find((request) => request.method === 'tools/call');
    assert.strictEqual(callRequest.headers['mcp-name'], 'current_echo');
    assert.strictEqual(
      callRequest.headers['mcp-param-region'],
      `=?base64?${Buffer.from('Hello, 世界', 'utf8').toString('base64')}?=`,
    );
    assert.strictEqual(callRequest.headers['mcp-param-count'], '42');
    assert.strictEqual(callRequest.headers['mcp-param-flag'], 'false');
    const invalidSearch = await caps.execute('mcp_servers', {
      action: 'search', name: 'current', query: 'invalid_header_tool',
    });
    assert.strictEqual(invalidSearch.matched, 0);

    const listCallsBeforeMismatch = currentRequests.filter((request) => request.method === 'tools/list').length;
    const toolCallsBeforeMismatch = currentRequests.filter((request) => request.method === 'tools/call').length;
    headerMismatchOnce = true;
    const recovered = await caps.execute('mcp_servers', {
      action: 'call', name: 'current', tool: 'current_echo', arguments: { region: 'refreshed' },
    });
    assert.match(recovered.result, /refreshed/);
    assert.ok(
      currentRequests.filter((request) => request.method === 'tools/list').length > listCallsBeforeMismatch,
      'HeaderMismatch must refresh the tool schema',
    );
    assert.strictEqual(
      currentRequests.filter((request) => request.method === 'tools/call').length,
      toolCallsBeforeMismatch + 2,
      'HeaderMismatch must retry the call exactly once',
    );

    const listed = await caps.execute('mcp_servers', { action: 'list' });
    const row = listed.servers.find((server) => server.name === 'current');
    assert.strictEqual(row.auth.bearer, 'environment');
    assert.ok(!JSON.stringify(row).includes('current-secret-token'));
    assert.ok(!fs.readFileSync(path.join(dir, 'mcpservers.json'), 'utf8').includes('current-secret-token'));
  });

  await check('modern protocol-version errors retry a mutually supported version without legacy fallback', async () => {
    const added = await caps.execute('mcp_servers', {
      action: 'add',
      name: 'current-negotiated',
      url: currentUrl,
      transport: 'current-http',
      protocol_version: '1900-01-01',
      bearer_token_env: 'TEST_MCP_BEARER',
    });
    assert.strictEqual(added.negotiatedTransport, 'current-http');
    assert.strictEqual(added.protocolVersion, '2026-07-28');
    assert.strictEqual(added.sessionful, false);
  });

  const wrongId = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'somebody-elses-request', result: { tools: [] } }));
    });
  });
  await new Promise((resolve) => wrongId.listen(0, '127.0.0.1', resolve));
  const wrongIdUrl = `http://127.0.0.1:${wrongId.address().port}/mcp`;
  await check('a response for another JSON-RPC id is never accepted', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'add', name: 'wrongid', url: wrongIdUrl, transport: 'stateless',
    }), /matching request id/);
    const listed = await caps.execute('mcp_servers', { action: 'list' });
    assert.ok(!listed.servers.find((server) => server.name === 'wrongid'));
  });

  let modernFailureRequests = 0;
  const modernFailure = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      modernFailureRequests += 1;
      const rpc = JSON.parse(body || '{}');
      if (req.headers['mcp-method']) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          error: { code: -32602, message: 'Malformed current request' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'should_not_fallback' }] } }));
    });
  });
  await new Promise((resolve) => modernFailure.listen(0, '127.0.0.1', resolve));
  const modernFailureUrl = `http://127.0.0.1:${modernFailure.address().port}/mcp`;
  await check('a recognised modern protocol error is surfaced, never misclassified as legacy', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'add', name: 'modernfail', url: modernFailureUrl, transport: 'auto',
    }), /Malformed current request/);
    assert.strictEqual(modernFailureRequests, 1, 'client wrongly fell through to a legacy transport');
  });

  let statefulInitializes = 0;
  let statefulSession = '';
  let expireNextStatefulRequest = false;
  let badRequestNextStatefulRequest = false;
  process.env.TEST_MCP_AUTH_HEADER = 'Bearer test-secret';
  const stateful = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      if (req.headers.authorization !== process.env.TEST_MCP_AUTH_HEADER) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'auth required' } }));
        return;
      }
      if (rpc.method === 'initialize') {
        assert.strictEqual(rpc.params.protocolVersion, '2025-11-25');
        statefulInitializes += 1;
        statefulSession = `stateful-session-${statefulInitializes}`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': statefulSession,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'stateful-test', version: '1.0.0' },
          },
        }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(rpc, 'id'), false, 'initialized must be a notification');
        assert.strictEqual(req.headers['mcp-session-id'], statefulSession);
        assert.strictEqual(req.headers['mcp-protocol-version'], '2025-11-25');
        res.writeHead(204);
        res.end();
        return;
      }
      if (badRequestNextStatefulRequest) {
        badRequestNextStatefulRequest = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          error: { code: -32602, message: 'bad tool arguments' },
        }));
        return;
      }
      if (expireNextStatefulRequest) {
        expireNextStatefulRequest = false;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session expired' }));
        return;
      }
      if (req.headers['mcp-session-id'] !== statefulSession) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing session' }));
        return;
      }
      assert.strictEqual(req.headers['mcp-protocol-version'], '2025-11-25');
      const payload = rpc.method === 'tools/list'
        ? { tools: [{ name: 'stateful_echo', description: 'stateful echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: `stateful:${JSON.stringify(rpc.params.arguments)}` }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: payload }));
    });
  });
  await new Promise((r) => stateful.listen(0, '127.0.0.1', r));
  const statefulUrl = `http://127.0.0.1:${stateful.address().port}/mcp`;

  await check('Streamable HTTP initialize, sessions, env-backed auth and expiry recovery work', async () => {
    const added = await caps.execute('mcp_servers', {
      action: 'add',
      name: 'stateful',
      url: statefulUrl,
      transport: 'streamable-http',
      header_env: { Authorization: 'TEST_MCP_AUTH_HEADER' },
    });
    assert.strictEqual(added.negotiatedTransport, 'streamable-http');
    assert.strictEqual(added.protocolVersion, '2025-11-25');
    assert.strictEqual(added.sessionful, true);
    assert.strictEqual(added.serverInfo.name, 'stateful-test');
    const beforeExpiry = statefulInitializes;
    expireNextStatefulRequest = true;
    const called = await caps.execute('mcp_servers', {
      action: 'call', name: 'stateful', tool: 'stateful_echo', arguments: { recovered: true },
    });
    assert.match(called.result, /stateful:\{"recovered":true\}/);
    assert.strictEqual(statefulInitializes, beforeExpiry + 1, 'expired session should initialize exactly once');

    const beforeBadRequest = statefulInitializes;
    badRequestNextStatefulRequest = true;
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'call', name: 'stateful', tool: 'stateful_echo', arguments: { invalid: true },
    }), /bad tool arguments/);
    assert.strictEqual(statefulInitializes, beforeBadRequest, 'HTTP 400 is not session expiry and must not reinitialize');

    const listed = await caps.execute('mcp_servers', { action: 'list' });
    const row = listed.servers.find((server) => server.name === 'stateful');
    assert.strictEqual(row.negotiatedTransport, 'streamable-http');
    assert.strictEqual(row.serverInfo.name, 'stateful-test');
    assert.deepStrictEqual(row.headerEnv, { authorization: 'TEST_MCP_AUTH_HEADER' });
    assert.ok(!JSON.stringify(row).includes('test-secret'), 'registry output must not reveal auth values');
  });

  await check('secret headers cannot be persisted literally or escape dedicated secret roots', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'add', name: 'literal-secret', url: currentUrl, transport: 'current-http',
      headers: { Authorization: 'Bearer must-not-be-stored' },
    }), /header_env or header_files/);
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'add', name: 'path-escape', url: currentUrl, transport: 'current-http',
      header_files: { Authorization: '/run/secrets/../etc/shadow' },
    }), /must live under/);
    const rawRegistry = fs.readFileSync(path.join(dir, 'mcpservers.json'), 'utf8');
    assert.ok(!rawRegistry.includes('must-not-be-stored'));
    assert.ok(!rawRegistry.includes('/etc/shadow'));
  });

  await check('missing auth environment variables fail without persisting a server', async () => {
    await assert.rejects(() => caps.execute('mcp_servers', {
      action: 'add', name: 'missingauth', url: statefulUrl,
      transport: 'streamable-http', header_env: { Authorization: 'DOES_NOT_EXIST_MCP_TOKEN' },
    }), /environment variable .* unset/i);
    const listed = await caps.execute('mcp_servers', { action: 'list' });
    assert.ok(!listed.servers.find((server) => server.name === 'missingauth'));
  });
  await check('remove works', async () => {
    await caps.execute('mcp_servers', { action: 'remove', name: 'testsrv' });
    await caps.execute('mcp_servers', { action: 'remove', name: 'current' });
    await caps.execute('mcp_servers', { action: 'remove', name: 'current-negotiated' });
    await caps.execute('mcp_servers', { action: 'remove', name: 'stateful' });
    const { servers } = await caps.execute('mcp_servers', { action: 'list' });
    assert.ok(!servers.find((s) => s.name === 'testsrv'));
    assert.ok(!servers.find((s) => s.name === 'current'));
    assert.ok(!servers.find((s) => s.name === 'current-negotiated'));
    assert.ok(!servers.find((s) => s.name === 'stateful'));
  });

  console.log('== schedule (self-cron) ==');
  const enqueued = [];
  caps.scheduler.attach({ enqueue: (job) => { enqueued.push(job); return { jobId: `job-${enqueued.length}` }; } });

  await check('create returns a future wake time', async () => {
    const out = await caps.execute('schedule', { action: 'create', prompt: 'check the PR again', delay_seconds: 600, note: 'pr watch' });
    assert.strictEqual(out.created, true);
    assert.ok(Date.parse(out.nextRunAt) > Date.now());
  });
  await check('run_now actually enqueues a real turn', async () => {
    const { schedules } = await caps.execute('schedule', { action: 'list' });
    const out = await caps.execute('schedule', { action: 'run_now', id: schedules[0].id });
    assert.strictEqual(out.fired, true);
    assert.strictEqual(enqueued.length, 1);
    assert.strictEqual(enqueued[0].message, 'check the PR again');
    assert.strictEqual(enqueued[0].ownerKey, 'testowner');
    assert.strictEqual(enqueued[0].model, 'preview');
  });
  await check('a due schedule fires on tick and one-shots disable', async () => {
    const before = enqueued.length;
    const out = await caps.execute('schedule', { action: 'create', prompt: 'wake now', delay_seconds: 30 });
    const item = caps.scheduler.items.find((s) => s.id === out.id);
    item.nextRunAt = Date.now() - 1000;            // make it due
    caps.scheduler._tick();
    assert.strictEqual(enqueued.length, before + 1);
    assert.strictEqual(caps.scheduler.items.find((s) => s.id === out.id).enabled, false);
  });
  await check('a repeating schedule re-arms itself', async () => {
    const out = await caps.execute('schedule', { action: 'create', prompt: 'hourly', every_seconds: 3600 });
    const item = caps.scheduler.items.find((s) => s.id === out.id);
    item.nextRunAt = Date.now() - 1000;
    caps.scheduler._tick();
    const after = caps.scheduler.items.find((s) => s.id === out.id);
    assert.strictEqual(after.enabled, true);
    assert.ok(after.nextRunAt > Date.now());
  });
  await check('schedules survive a restart', async () => {
    const fresh = new CapabilityGateway(config, () => {});
    const { total } = await fresh.execute('schedule', { action: 'list' });
    assert.ok(total >= 1);
  });
  await check('a past timestamp is rejected', async () => {
    await assert.rejects(() => caps.execute('schedule', { action: 'create', prompt: 'x', at: '2020-01-01T00:00:00Z' }));
  });

  await check('long-range one-shot and recurring schedules are not clamped to 30 days', async () => {
    const fiveYears = 5 * 365 * 24 * 60 * 60;
    const oneShot = await caps.execute('schedule', { action: 'create', prompt: 'wake in five years', delay_seconds: fiveYears });
    const oneShotMs = Date.parse(oneShot.nextRunAt) - Date.now();
    assert.ok(oneShotMs > 4.9 * 365 * 24 * 60 * 60 * 1000, 'one-shot was silently shortened');
    const twoYears = 2 * 365 * 24 * 60 * 60;
    const repeating = await caps.execute('schedule', { action: 'create', prompt: 'biennial', every_seconds: twoYears });
    assert.strictEqual(repeating.everySeconds, twoYears);
    await caps.execute('schedule', { action: 'cancel', id: oneShot.id });
    await caps.execute('schedule', { action: 'cancel', id: repeating.id });
  });
  await check('invalid schedule ranges reject instead of silently coercing', async () => {
    await assert.rejects(() => caps.execute('schedule', { action: 'create', prompt: 'too soon', delay_seconds: 1 }), /at least 30/);
    await assert.rejects(() => caps.execute('schedule', { action: 'create', prompt: 'beyond date', delay_seconds: Number.MAX_SAFE_INTEGER }), /calendar range/);
  });
  await check('cancel works', async () => {
    const out = await caps.execute('schedule', { action: 'create', prompt: 'cancel me', delay_seconds: 900 });
    await caps.execute('schedule', { action: 'cancel', id: out.id });
    await assert.rejects(() => caps.execute('schedule', { action: 'cancel', id: out.id }));
  });

  console.log('== subagent ==');
  await check('depth limit blocks runaway nesting', async () => {
    await assert.rejects(() => caps.execute('subagent', { action: 'spawn', task: 'nested' }, { depth: 2 }), /depth limit/);
  });
  await check('spawn with no task is rejected', async () => {
    await assert.rejects(() => caps.execute('subagent', { action: 'spawn', task: '   ' }));
  });
  await check('spawn shares capabilities and enforces inherited nesting depth', async () => {
    const agentloopModule = require('/opt/meshdirect/server/agentloop');
    const OriginalAgentLoop = agentloopModule.AgentLoop;
    let childDependencies = null;
    agentloopModule.AgentLoop = class FakeNestedAgentLoop {
      constructor(_config, _log, dependencies) { childDependencies = dependencies; }
      async run() { return { reply: 'nested result', usage: {}, tools: [] }; }
    };
    try {
      const out = await caps.execute(
        'subagent',
        { action: 'spawn', task: 'summarise the disk layout', label: 'disk' },
        { depth: 1 },
      );
      assert.strictEqual(out.spawned, true);
      assert.strictEqual(childDependencies.caps, caps, 'child must share the parent capability gateway');
      assert.strictEqual(childDependencies.depth, 2, 'child AgentLoop must inherit the incremented depth');
      const result = await caps.execute('subagent', { action: 'result', id: out.id, wait: 2 });
      assert.strictEqual(result.state, 'done');
      assert.strictEqual(result.result, 'nested result');
      const listed = await caps.execute('subagent', { action: 'list' });
      assert.ok(listed.subagents.find((s) => s.id === out.id));
    } finally {
      agentloopModule.AgentLoop = OriginalAgentLoop;
    }
  });
  await check('result on an unknown id is rejected', async () => {
    await assert.rejects(() => caps.execute('subagent', { action: 'result', id: 'sub-doesnotexist' }));
  });

  await check('running subagents from an older process are marked interrupted on restart', async () => {
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcaps-stale-'));
    const subDir = path.join(staleDir, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'sub-stale.json'), JSON.stringify({
      id: 'sub-stale', label: 'stale work', task: 'old', model: 'preview', modelId: 'qwen3.8-max-preview',
      depth: 1, state: 'running', createdAt: Date.now() - 5000, finishedAt: null,
      runnerInstanceId: 'older-process', result: '', error: null, usage: null, toolCalls: 0,
    }));
    const restarted = new CapabilityGateway({
      ...config,
      stateDir: staleDir,
      sessionsDir: path.join(staleDir, 'sessions'),
    }, () => {});
    const status = await restarted.execute('subagent', { action: 'status', id: 'sub-stale' });
    assert.strictEqual(status.state, 'interrupted');
    assert.match(status.error, /restarted before.*completed/i);
    assert.ok(status.finishedAt);
  });

  console.log('== dispatch guards ==');
  await check('handles() only claims the capability tools', () => {
    for (const n of ['memory', 'skills', 'subagent', 'schedule', 'mcp_servers', 'goals']) assert.ok(caps.handles(n), n);
    for (const n of ['sg1', 'sg2', 'exec', 'shell']) assert.ok(!caps.handles(n), n);
  });
  await check('a missing action is rejected', async () => {
    await assert.rejects(() => caps.execute('memory', {}));
  });
  await check('an unsupported action is rejected', async () => {
    await assert.rejects(() => caps.execute('memory', { action: 'obliterate' }));
  });

  fake.close();
  current.close();
  wrongId.close();
  modernFailure.close();
  stateful.close();
  delete process.env.TEST_MCP_BEARER;
  delete process.env.TEST_MCP_AUTH_HEADER;
  console.log('\n' + (failed === 0 ? 'ALL AGENTCAPS TESTS PASSED' : failed + ' TEST(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
