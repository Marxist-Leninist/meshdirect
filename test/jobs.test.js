'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JobManager } = require('../server/jobs');
const sessions = require('../server/sessions');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function config(directory) {
  return {
    sessionsDir: directory,
    jobRetentionMs: 15 * 60 * 1000,
    maxQueuePerLane: 2,
    turnTimeoutMs: 5000,
    systemPrompt: 'test system',
    historyContextMessages: 50,
    historyContextMaxChars: 200000,
    lanes: { preview: { modelId: 'preview-test' }, stable: { modelId: 'stable-test' } },
  };
}

function waitForTerminal(manager, job) {
  if (job.state === 'done' || job.state === 'error') return Promise.resolve(job);
  return new Promise((resolve) => {
    const unsubscribe = manager.subscribe(job, (event) => {
      if (event === 'done' || event === 'error') { unsubscribe(); resolve(job); }
    });
  });
}

test('a prior uploaded image is supplied again for visual follow-up', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-followup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = config(directory);
  const saved = sessions.saveImages(cfg, [{
    fileName: 'screen.png', mimeType: 'image/png', content: PNG.toString('base64'),
  }]);
  sessions.appendMessage(cfg, 'preview', 'main', {
    role: 'user', content: 'Look at this screenshot', attachments: saved,
  });
  sessions.appendMessage(cfg, 'preview', 'main', { role: 'assistant', content: 'I can see it.' });

  let providerMessages;
  const agent = {
    async run(input) {
      providerMessages = input.messages;
      return { reply: 'Follow-up complete', usage: null, tools: [] };
    },
  };
  const manager = new JobManager(cfg, () => {}, { agent });
  const job = manager.enqueue({
    ownerKey: 'owner', model: 'preview', message: 'Look at the image above again', clientTurnId: 'turn_followup_123',
  });
  await waitForTerminal(manager, job);

  const visualMessage = providerMessages.find((m) => Array.isArray(m.content));
  assert.equal(visualMessage.role, 'user');
  assert.equal(visualMessage.content[0].text, 'Look at this screenshot');
  assert.match(visualMessage.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(job.state, 'done');
});

test('queued abort drops image memory and remains recoverable by client turn id', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const agent = {
    async run() { await blocked; return { reply: 'done', usage: null, tools: [] }; },
  };
  const manager = new JobManager(config(directory), () => {}, { agent });
  const first = manager.enqueue({ ownerKey: 'owner', model: 'preview', message: 'first', clientTurnId: 'turn_first_12345' });
  const second = manager.enqueue({
    ownerKey: 'owner', model: 'preview', message: 'second', clientTurnId: 'turn_second_1234',
    attachments: [{ fileName: 'screen.png', mimeType: 'image/png', content: PNG.toString('base64') }],
  });
  assert.equal(second.state, 'queued');
  assert.equal(manager.abortJob(second), true);
  assert.equal(second.attachments.length, 0);
  assert.equal(manager.getByClient('turn_second_1234', 'owner'), second);
  assert.equal(second.state, 'error');
  release();
  await waitForTerminal(manager, first);
});

test('client turn id remains idempotent after a manager restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-durable-turn-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = config(directory);
  let calls = 0;
  const firstManager = new JobManager(cfg, () => {}, {
    agent: { async run() { calls += 1; return { reply: 'durable reply', usage: null, tools: [] }; } },
  });
  const first = firstManager.enqueue({
    ownerKey: 'user', model: 'stable', message: 'do this once', clientTurnId: 'turn_durable_1234',
  });
  await waitForTerminal(firstManager, first);
  assert.equal(calls, 1);

  const restarted = new JobManager(cfg, () => {}, {
    agent: { async run() { calls += 1; throw new Error('must not replay'); } },
  });
  const recovered = restarted.enqueue({
    ownerKey: 'user', model: 'stable', message: 'do this once', clientTurnId: 'turn_durable_1234',
  });
  assert.equal(recovered.state, 'done');
  assert.equal(recovered.reply, 'durable reply');
  assert.equal(restarted.getByClient('turn_durable_1234', 'user').reply, 'durable reply');
  assert.equal(calls, 1);
});
