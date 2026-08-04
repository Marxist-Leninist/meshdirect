'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');

function appConfig(directory) {
  return {
    basePath: '/qwen38', cookieSecure: false, cookiePath: '/', cookieName: 'test_session',
    originAllow: ['http://127.0.0.1'], sessionTtlMs: 60000,
    username: 'tester', passwordHash: bcrypt.hashSync('correct-password', 4),
    modelLabel: 'Qwen', planLabel: 'Preview', workspaceLabel: 'Stable',
    lanes: {
      preview: { label: 'Preview', detail: '', agent: 'preview', modelId: 'preview-test' },
      stable: { label: 'Stable', detail: '', agent: 'stable', modelId: 'stable-test' },
    },
    sessionsDir: directory, distDir: path.join(directory, 'dist'),
    jobRetentionMs: 1000, maxQueuePerLane: 2, ssePingMs: 15000,
    turnTimeoutMs: 5000, historyContextMessages: 10, historyContextMaxChars: 10000,
    systemPrompt: 'test', contextTokens: 1000,
    sgServers: {}, sgCatalogTtlMs: 1000, sgCallTimeoutMs: 1000,
    maxToolResultChars: 1000, maxAgentRounds: 2, maxToolCalls: 2,
  };
}

test('parallel login attempts cannot bypass the eight-attempt reservation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-app-'));
  fs.mkdirSync(path.join(directory, 'dist'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { app } = createApp(appConfig(directory), () => {});
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/qwen38/api/login`;
  const responses = await Promise.all(new Array(20).fill(null).map(() => fetch(url, {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'wrong-password' }),
  })));
  const statuses = responses.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 401).length, 8);
  assert.equal(statuses.filter((status) => status === 429).length, 12);
});


test('legacy open tabs without a client turn id remain accepted', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-legacy-chat-'));
  fs.mkdirSync(path.join(directory, 'dist'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeModelclient = {
    async runChat() {
      return {
        reply: 'accepted', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        toolCalls: [], finishReason: 'stop', provider: 'test',
      };
    },
  };
  const { app } = createApp(appConfig(directory), () => {}, { modelclient: fakeModelclient });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/qwen38/api`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'correct-password' }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.ok(cookie);
  assert.ok(session.csrfToken);

  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      Cookie: cookie,
    },
    body: JSON.stringify({ message: 'What happened so far', model: 'preview', sessionId: 'main' }),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.match(job.clientTurnId, /^legacy_[A-Za-z0-9_-]{24}$/);
});


test('authenticated clients can steer idempotently through the by-client route', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-app-steer-'));
  fs.mkdirSync(path.join(directory, 'dist'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let interruptions = 0;
  const agent = {
    async run(input) {
      input.setSteeringInterrupt(() => { interruptions += 1; return true; });
      entered();
      await wait;
      input.setSteeringInterrupt(null);
      const steering = input.takeSteering({ round: 2, resetOutput: true });
      return { reply: steering.map((item) => item.message).join(' | '), usage: null, tools: [] };
    },
  };
  const { app } = createApp(appConfig(directory), () => {}, { agent });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/qwen38/api`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'correct-password' }),
  });
  const session = await login.json();
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  const headers = {
    Origin: 'http://127.0.0.1',
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    Cookie: cookie,
  };
  const clientTurnId = 'turn_app_steer_1234';
  const create = await fetch(`${base}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Repair access', model: 'preview', sessionId: 'main', clientTurnId }),
  });
  assert.equal(create.status, 202);
  const job = await create.json();
  await running;

  const invalid = await fetch(`${base}/chat/by-client/${clientTurnId}/steer`, {
    method: 'POST', headers, body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(invalid.status, 400);

  const clientSteeringId = 'steer_app_12345678';
  const payload = { message: 'Use the relay.', clientSteeringId };
  const steer = await fetch(`${base}/chat/by-client/${clientTurnId}/steer`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  assert.equal(steer.status, 202);
  const accepted = await steer.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.instruction.state, 'pending');
  assert.equal(accepted.instruction.clientSteeringId, clientSteeringId);
  assert.equal(accepted.instruction.interrupted, true);
  assert.equal(interruptions, 1);
  assert.equal(accepted.steering.pending, 1);

  const retry = await fetch(`${base}/chat/${encodeURIComponent(job.jobId)}/steer`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  assert.equal(retry.status, 200);
  const duplicate = await retry.json();
  assert.equal(duplicate.instruction.id, accepted.instruction.id);
  assert.equal(duplicate.instruction.duplicate, true);

  release();
  let terminal;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const poll = await fetch(`${base}/chat/${encodeURIComponent(job.jobId)}`, { headers: { Cookie: cookie } });
    terminal = await poll.json();
    if (terminal.state === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(terminal.state, 'done');
  assert.equal(terminal.reply, 'Use the relay.');

  const terminalRetry = await fetch(`${base}/chat/${encodeURIComponent(job.jobId)}/steer`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  assert.equal(terminalRetry.status, 200);
  const terminalDuplicate = await terminalRetry.json();
  assert.equal(terminalDuplicate.instruction.duplicate, true);

  const tooLate = await fetch(`${base}/chat/${encodeURIComponent(job.jobId)}/steer`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'New work', clientSteerId: 'steer_app_new_1234' }),
  });
  assert.equal(tooLate.status, 409);
});
