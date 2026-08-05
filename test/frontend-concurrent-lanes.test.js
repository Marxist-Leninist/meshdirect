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

function type(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('Preview and Stable keep independent submissions, streams, and composer drafts', async (t) => {
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

  const chatPosts = [];
  const streamSignals = new Map();
  let resolveStableCreate = null;

  window.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
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
    if (target.includes('/api/history?')) return jsonResponse({ messages: [] });
    if (target.endsWith('/api/state')) {
      return jsonResponse({
        models: [],
        lanes: {
          preview: { running: null, queued: 0 },
          stable: { running: null, queued: 0 },
        },
      });
    }
    if (target.endsWith('/api/chat') && method === 'POST') {
      const body = JSON.parse(options.body);
      chatPosts.push(body);
      const created = jsonResponse({
        jobId: `job-${body.model}`,
        clientTurnId: body.clientTurnId,
        userMessageId: `user-${body.model}`,
        model: body.model,
        state: 'running',
        createdAt: Date.now(),
        activity: 'Running',
        steering: { pending: 0, applied: 0, notApplied: 0, items: [] },
      }, 202);
      if (body.model === 'stable') {
        return new Promise((resolve) => { resolveStableCreate = () => resolve(created); });
      }
      return created;
    }
    const streamMatch = target.match(/\/api\/chat\/job-(preview|stable)\/stream$/);
    if (streamMatch) {
      const model = streamMatch[1];
      streamSignals.set(model, options.signal);
      const body = new window.ReadableStream({ start() {} });
      return {
        ok: true,
        status: 200,
        headers: { get() { return 'text/event-stream'; } },
        body,
      };
    }
    throw new Error(`Unexpected fetch: ${method} ${target}`);
  };

  window.eval(fs.readFileSync(path.join(root, 'dist/assets/app.js'), 'utf8'));
  await waitFor(() => window.document.querySelector('#composer-input'), 'app did not boot');

  const modelButton = (id) => window.document.querySelector(`#model-bar [data-model="${id}"]`);
  const input = () => window.document.querySelector('#composer-input');
  const form = () => window.document.querySelector('#composer-form');

  modelButton('stable').click();
  type(window, input(), 'long stable repair');
  form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => typeof resolveStableCreate === 'function', 'stable submission was not started');

  // Switch before Stable's POST is acknowledged. Preview must have its own
  // blank draft and must not inherit the Stable text still awaiting acceptance.
  modelButton('preview').click();
  assert.equal(input().value, '');
  type(window, input(), 'independent preview research');
  form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => streamSignals.has('preview'), 'preview stream did not open');

  // Keep a new Preview draft while Stable finishes accepting in the background.
  type(window, input(), 'preview follow-up draft');
  resolveStableCreate();
  await waitFor(() => streamSignals.has('stable'), 'stable stream did not open');

  assert.deepEqual(chatPosts.map((body) => body.model), ['stable', 'preview']);
  assert.equal(streamSignals.get('stable').aborted, false, 'Preview must not abort Stable SSE');
  assert.equal(streamSignals.get('preview').aborted, false, 'Stable must not abort Preview SSE');
  assert.equal(input().value, 'preview follow-up draft', 'background Stable acceptance must not clear Preview draft');

  modelButton('stable').click();
  assert.equal(input().value, '', 'accepted Stable draft should be cleared only in Stable');
  modelButton('preview').click();
  assert.equal(input().value, 'preview follow-up draft', 'Preview draft should survive model switching');
});
