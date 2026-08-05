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
  await check('5 capability tools exposed', () => {
    const names = CAP_TOOLS.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ['mcp_servers', 'memory', 'schedule', 'skills', 'subagent']);
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

  await check('add probes the server and records its tool count', async () => {
    const out = await caps.execute('mcp_servers', { action: 'add', name: 'testsrv', url: fakeUrl, note: 'unit test' });
    assert.strictEqual(out.added, true);
    assert.strictEqual(out.toolCount, 1);
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
  await check('remove works', async () => {
    await caps.execute('mcp_servers', { action: 'remove', name: 'testsrv' });
    const { servers } = await caps.execute('mcp_servers', { action: 'list' });
    assert.ok(!servers.find((s) => s.name === 'testsrv'));
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

  console.log('== dispatch guards ==');
  await check('handles() only claims the capability tools', () => {
    for (const n of ['memory', 'skills', 'subagent', 'schedule', 'mcp_servers']) assert.ok(caps.handles(n), n);
    for (const n of ['sg1', 'sg2', 'exec', 'shell']) assert.ok(!caps.handles(n), n);
  });
  await check('a missing action is rejected', async () => {
    await assert.rejects(() => caps.execute('memory', {}));
  });
  await check('an unsupported action is rejected', async () => {
    await assert.rejects(() => caps.execute('memory', { action: 'obliterate' }));
  });

  fake.close();
  console.log('\n' + (failed === 0 ? 'ALL AGENTCAPS TESTS PASSED' : failed + ' TEST(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
