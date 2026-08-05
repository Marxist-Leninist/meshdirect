'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'application/json' : null; } },
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message || 'Timed out waiting for condition');
}

test('tool chips expose real status and the context gauge is not cumulative session usage', async (t) => {
  const dom = new JSDOM('<!doctype html><main id="app"></main>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://zqx.lat/qwen38/',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.AbortController = globalThis.AbortController;
  window.ReadableStream = globalThis.ReadableStream;
  window.TextDecoder = globalThis.TextDecoder;
  window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });

  window.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/api/session')) {
      return jsonResponse({
        authenticated: true,
        username: 'owner',
        csrfToken: 'csrf-test',
        model: 'Qwen 3.8 Mesh',
        plan: 'test',
        workspace: 'test',
        defaultModel: 'preview',
        models: [
          { id: 'preview', label: 'Qwen 3.8 Preview', detail: 'Preview lane' },
          { id: 'stable', label: 'Qwen 3.8', detail: 'Stable lane' },
        ],
      });
    }
    if (target.includes('/api/history?')) {
      const isPreview = target.includes('model=preview');
      return jsonResponse({ messages: isPreview ? [{
        id: 'assistant-one',
        role: 'assistant',
        content: 'Scheduler is healthy.',
        timestamp: Date.now(),
        tools: [
          { label: 'SCHEDULE · invalid request', status: 'complete' },
          { label: 'SG1 · remote_exec', status: 'error' },
        ],
      }] : [] });
    }
    if (target.endsWith('/api/state')) {
      return jsonResponse({
        models: [{
          model: 'preview',
          label: 'Qwen 3.8 Preview',
          busy: false,
          stats: {
            contextTokens: 983616,
            totalTokens: 6200000,
            lastPromptTokens: 64000,
            lastCompletionTokens: 800,
            lastTurnTokens: 64800,
          },
          sessions: [{ sessionId: 'main', totalTokens: 6200000 }],
        }],
        lanes: {
          preview: { running: null, queued: 0 },
          stable: { running: null, queued: 0 },
        },
      });
    }
    throw new Error('Unexpected fetch: ' + target);
  };

  window.eval(fs.readFileSync(path.join(root, 'dist/assets/app.js'), 'utf8'));
  await waitFor(() => window.document.querySelectorAll('.message-tools .tool-chip').length === 2,
    'tool chips did not render');
  await waitFor(() => /Context/.test(window.document.querySelector('#status-strip-inner').textContent),
    'context gauge did not render');

  const chips = Array.from(window.document.querySelectorAll('.message-tools .tool-chip'));
  assert.equal(chips[0].textContent, '✓ SCHEDULE · completed');
  assert.ok(chips[0].classList.contains('complete'));
  assert.ok(chips[0].classList.contains('recovered'));
  assert.match(chips[0].title, /older harness version/);
  assert.equal(chips[1].textContent, '! SG1 · remote_exec');
  assert.ok(chips[1].classList.contains('error'));

  const gauge = window.document.querySelector('.token-gauge');
  assert.match(gauge.textContent, /Context/);
  assert.match(gauge.textContent, /64\.0k \/ 983\.6k/);
  assert.doesNotMatch(gauge.textContent, /6\.2M/);
  assert.match(gauge.title, /Cumulative session usage: 6,200,000 tokens/);
});
