'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeImages, sniffMime } = require('../server/images');
const sessions = require('../server/sessions');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('valid image data is normalized and its MIME is sniffed', () => {
  assert.equal(sniffMime(PNG), 'image/png');
  const images = normalizeImages([{
    fileName: 'screen shot.png',
    mimeType: 'image/png',
    content: `data:image/png;base64,${PNG.toString('base64')}`,
  }]);
  assert.deepEqual(images, [{
    fileName: 'screen shot.png', mimeType: 'image/png', content: PNG.toString('base64'),
  }]);
});

test('mismatched and excessive image attachments are rejected', () => {
  assert.throws(() => normalizeImages([{ fileName: 'x.jpg', mimeType: 'image/jpeg', content: PNG.toString('base64') }]), /does not match/);
  assert.throws(() => normalizeImages(new Array(5).fill({ fileName: 'x.png', mimeType: 'image/png', content: PNG.toString('base64') })), /no more than 4/);
});

test('accepted images persist as private authenticated-history media', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-images-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { sessionsDir: directory };
  const normalized = normalizeImages([{
    fileName: 'reference.png', mimeType: 'image/png', content: PNG.toString('base64'),
  }]);
  const saved = sessions.saveImages(config, normalized);
  assert.equal(saved.length, 1);
  const row = sessions.appendMessage(config, 'preview', 'main', {
    role: 'user', content: 'Inspect this', attachments: saved,
  });
  const messages = sessions.readMessages(config, 'preview', 'main', 10);
  assert.equal(messages[0].id, row.id);
  assert.equal(messages[0].attachments[0].fileName, 'reference.png');
  const image = sessions.imageInfo(config, saved[0].id);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(fs.readFileSync(image.file).toString('hex'), PNG.toString('hex'));
  assert.equal(fs.statSync(image.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, 'preview-main.jsonl')).mode & 0o777, 0o600);
});

test('restart reconciliation never replays an accepted pending turn', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-pending-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { sessionsDir: directory };

  const unfinished = sessions.appendMessage(config, 'preview', 'main', {
    role: 'user', content: 'perform a side effect', pending: true,
  });
  const completed = sessions.appendMessage(config, 'stable', 'main', {
    role: 'user', content: 'inspect a thing', pending: true,
  });
  sessions.appendMessage(config, 'stable', 'main', {
    role: 'assistant', content: 'inspection complete', turnId: completed.id,
  });

  assert.deepEqual(sessions.failPending(config), { recovered: 1, failed: 1 });
  const preview = sessions.readMessages(config, 'preview', 'main', 0);
  const stable = sessions.readMessages(config, 'stable', 'main', 0);
  assert.equal(preview.find((m) => m.id === unfinished.id).failed, true);
  assert.equal(preview.find((m) => m.id === unfinished.id).pending, undefined);
  assert.equal(stable.find((m) => m.id === completed.id).failed, undefined);
  assert.equal(stable.find((m) => m.id === completed.id).pending, undefined);
});


test('session stats distinguish cumulative usage from the latest prompt context', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meshdirect-token-stats-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { sessionsDir: directory };
  sessions.appendMessage(config, 'preview', 'main', {
    role: 'assistant', content: 'first',
    usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
  });
  sessions.appendMessage(config, 'preview', 'main', {
    role: 'assistant', content: 'second',
    usage: { prompt_tokens: 64000, completion_tokens: 800, total_tokens: 64800 },
  });
  const stats = sessions.statsFor(config, 'preview', 'main');
  assert.equal(stats.totalTokens, 65800);
  assert.equal(stats.inputTokens, 64900);
  assert.equal(stats.outputTokens, 900);
  assert.equal(stats.lastPromptTokens, 64000);
  assert.equal(stats.lastCompletionTokens, 800);
  assert.equal(stats.lastTurnTokens, 64800);
});
