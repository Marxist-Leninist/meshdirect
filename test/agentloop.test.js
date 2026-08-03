'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTextToolCalls, normalizeNativeCalls, createStreamingGuard } = require('../server/agentloop');

 test('parses and removes textual tool-call XML fallback', () => {
  const source = 'Checking now.\n<tool_call>\n{"name":"exec","arguments":{"command":"printf ok"}}\n</tool_call>';
  const parsed = parseTextToolCalls(source);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].function.name, 'exec');
  assert.deepEqual(JSON.parse(parsed.calls[0].function.arguments), { command: 'printf ok' });
  assert.equal(parsed.visible, 'Checking now.');
});

test('normalizes native OpenAI-compatible function calls', () => {
  const calls = normalizeNativeCalls([{ id: 'abc', type: 'function', function: { name: 'sg_mcp', arguments: '{"action":"health"}' } }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'abc');
  assert.equal(calls[0].function.name, 'sg_mcp');
});

test('stream guard never emits literal tool XML', () => {
  let shown = '';
  const guard = createStreamingGuard((text) => { shown += text; });
  for (const part of ['I will check. <to', 'ol_call>{"name":"exec",', '"arguments":{}}</tool_call>']) guard.push(part);
  const parsed = parseTextToolCalls(guard.raw());
  guard.finish(parsed.visible, true);
  assert.equal(shown, 'I will check.');
  assert.ok(!shown.includes('tool_call'));
});
