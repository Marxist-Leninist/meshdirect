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
