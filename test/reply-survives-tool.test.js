// Regression: an answer written before a tool call must not vanish.
//
// Reported 2026-08-05: "it wrote a reply to this then disappeared". The model
// answers, calls memory.remember in the same round, and then the closing round
// returns nothing because it has already said its piece. The turn ended with an
// empty reply and onFinalDelta blanked the text the user had watched stream in.
//
// The harness deliberately drops pre-tool narration ("let me check...") when a
// real closing answer exists — see agentloop.test.js "only emits the final
// answer". So the fallback here is deliberately narrow: it applies ONLY when
// the closing round is empty.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { AgentLoop } = require('../server/agentloop');

const config = {
  systemPrompt: 'test',
  maxAgentRounds: 0,
  maxToolCalls: 0,
  maxToolResultChars: 60000,
  lanes: { preview: { modelId: 'm' }, stable: { modelId: 'm' } },
  sgServers: {},
};

const memoryCaps = {
  handles: (n) => n === 'memory',
  execute: async () => ({ created: true, memory: { id: 'mem-1', key: 'k' } }),
};

function memoryCall(id, action = 'remember') {
  return { id, function: { name: 'memory', arguments: JSON.stringify({ action, key: 'k', text: 't' }) } };
}

function runLoop(rounds, caps = memoryCaps) {
  const queue = rounds.slice();
  const modelclient = {
    async runChat() {
      const next = queue.shift();
      if (!next) throw new Error('model called more times than the test scripted');
      return next;
    },
  };
  const loop = new AgentLoop(config, () => {}, {
    modelclient, caps, gateway: { execute: async () => ({ ok: true }) },
  });
  let finalDelta = null;
  return loop.run({
    modelId: 'm',
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }],
    onActivity: () => {},
    onProviderError: () => {},
    onDelta: () => {},
    onFinalDelta: (t) => { finalDelta = t; },
    takeSteering: () => [],
    setSteeringInterrupt: () => {},
  }).then((out) => ({ out, finalDelta }));
}

test('an answer given before a memory call survives an empty closing round', async () => {
  const answer = 'Saved. The principle now travels with its best counterexample.';
  const { out, finalDelta } = await runLoop([
    { reply: answer, toolCalls: [memoryCall('c1')], usage: {}, finishReason: 'tool_calls' },
    { reply: '', toolCalls: [], usage: {}, finishReason: 'stop' },
  ]);
  assert.strictEqual(out.reply, answer);
  assert.strictEqual(finalDelta, answer, 'onFinalDelta must not blank the visible answer');
});

test('a whitespace-only closing round counts as empty', async () => {
  const answer = 'Recorded that for next time.';
  const { out } = await runLoop([
    { reply: answer, toolCalls: [memoryCall('c1')], usage: {}, finishReason: 'tool_calls' },
    { reply: '   \n  ', toolCalls: [], usage: {}, finishReason: 'stop' },
  ]);
  assert.strictEqual(out.reply, answer);
});

test('a real closing answer still wins over pre-tool narration', async () => {
  // This is the existing, deliberate behaviour and must not regress.
  const { out } = await runLoop([
    { reply: 'I will look that up.', toolCalls: [memoryCall('c1', 'search')], usage: {}, finishReason: 'tool_calls' },
    { reply: 'Saved under owner-sg-mcp-origin.', toolCalls: [], usage: {}, finishReason: 'stop' },
  ]);
  assert.strictEqual(out.reply, 'Saved under owner-sg-mcp-origin.');
});

test('across several silent tool rounds every pre-tool answer is kept', async () => {
  const { out } = await runLoop([
    { reply: 'Looking it up.', toolCalls: [memoryCall('c1', 'search')], usage: {}, finishReason: 'tool_calls' },
    { reply: 'Saving it now.', toolCalls: [memoryCall('c2')], usage: {}, finishReason: 'tool_calls' },
    { reply: '', toolCalls: [], usage: {}, finishReason: 'stop' },
  ]);
  assert.ok(out.reply.includes('Looking it up.'), 'first pre-tool answer missing');
  assert.ok(out.reply.includes('Saving it now.'), 'second pre-tool answer missing');
  assert.ok(out.reply.indexOf('Looking it up.') < out.reply.indexOf('Saving it now.'), 'order must hold');
});

test('a turn with no prose anywhere is not rescued into a false answer', async () => {
  // Nothing was ever said before the tool, so there is nothing to fall back to
  // and the loop must go back to the model rather than invent a reply.
  const { out } = await runLoop([
    { reply: '', toolCalls: [memoryCall('c1')], usage: {}, finishReason: 'tool_calls' },
    { reply: '', toolCalls: [], usage: {}, finishReason: 'stop' },
    { reply: 'Done.', toolCalls: [], usage: {}, finishReason: 'stop' },
  ]);
  assert.strictEqual(out.reply, 'Done.');
});
