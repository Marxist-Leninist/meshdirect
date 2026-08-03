'use strict';

// Focused tests for the live-streaming bridge: ToolCallTextFilter must pass
// visible text through incrementally, hold back <tool_call> markup at ANY chunk
// boundary, and drop unterminated markup tails at flush; AgentLoop must forward
// an onDelta callback to the model client so text can stream between rounds.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolCallTextFilter } = require('../server/modelclient');
const { AgentLoop } = require('../server/agentloop');

function collect(filter, chunks) {
  let visible = '';
  for (const chunk of chunks) visible += filter.push(chunk);
  visible += filter.flush();
  return visible;
}

test('filter passes plain text through untouched', () => {
  assert.equal(collect(new ToolCallTextFilter(), ['hello ', 'world', '']), 'hello world');
});

test('filter hides a complete tool_call block at every split point', () => {
  const full = 'pre <tool_call>{"name":"sg1","arguments":{"action":"call"}}</tool_call> post';
  for (let cut = 0; cut <= full.length; cut++) {
    const visible = collect(new ToolCallTextFilter(), [full.slice(0, cut), full.slice(cut)]);
    assert.equal(visible, 'pre  post', `split at ${cut}`);
  }
});

test('filter hides multiple blocks and unclosed tails', () => {
  const f = new ToolCallTextFilter();
  const visible = collect(f, [
    'a<tool_call>{"name":"sg1"}</tool_call>b<tool_call>{"name":"sg2"',
  ]);
  assert.equal(visible, 'ab');
});

test('flush drops unterminated markup instead of leaking it', () => {
  const f = new ToolCallTextFilter();
  assert.equal(f.push('answer <tool_call>{"name":"sg1","arguments":{"act'), 'answer ');
  assert.equal(f.flush(), '');
});

test('flush releases held plain suffix that was not a tag', () => {
  const f = new ToolCallTextFilter();
  assert.equal(f.push('value <tool'), 'value ');
  assert.equal(f.flush(), '<tool');
});

test('AgentLoop forwards onDelta to the model client', async () => {
  const seen = [];
  const config = {
    maxAgentRounds: 4,
    maxToolCalls: 8,
    maxToolResultChars: 1000,
    lanes: { stable: { modelId: 'm' } },
  };
  const loop = new AgentLoop(config, () => {}, {
    modelclient: {
      async runChat(_config, _model, _messages, opts) {
        assert.equal(typeof opts.onDelta, 'function', 'runChat must receive onDelta');
        opts.onDelta('chunk-1');
        opts.onDelta('chunk-2');
        return { reply: 'chunk-1chunk-2', usage: null, toolCalls: [], finishReason: 'stop' };
      },
    },
    gateway: { async execute() { throw new Error('no tools expected'); } },
  });
  const result = await loop.run({
    modelId: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (text) => seen.push(text),
  });
  assert.deepEqual(seen, ['chunk-1', 'chunk-2']);
  assert.equal(result.reply, 'chunk-1chunk-2');
});
