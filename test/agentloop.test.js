'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentLoop, parseTextToolCalls, routeToolCall } = require('../server/agentloop');
const {
  applyToolCallDelta,
  assertStreamCompleted,
  materializeToolCalls,
} = require('../server/modelclient');

function config() {
  return { maxAgentRounds: 6, maxToolCalls: 8, maxToolResultChars: 20_000 };
}

test('fragmented native function calls are reconstructed in index order', () => {
  const fragments = new Map();
  applyToolCallDelta(fragments, [{
    index: 1, id: 'call-b', type: 'function', function: { name: 'sg', arguments: '{"action":"sea' },
  }, {
    index: 0, id: 'call-a', type: 'function', function: { name: 'sg1', arguments: '{"action":"call",' },
  }]);
  applyToolCallDelta(fragments, [{
    index: 1, function: { name: '2', arguments: 'rch"}' },
  }, {
    index: 0, function: { arguments: '"name":"memory_search"}' },
  }]);
  assert.deepEqual(materializeToolCalls(fragments), [{
    id: 'call-a', type: 'function', function: { name: 'sg1', arguments: '{"action":"call","name":"memory_search"}' },
  }, {
    id: 'call-b', type: 'function', function: { name: 'sg2', arguments: '{"action":"search"}' },
  }]);
});

test('textual Qwen tool tags are parsed without retaining executable markup', () => {
  const parsed = parseTextToolCalls('Let me check.\n<tool_call>{"name":"sg1","arguments":{"action":"search","query":"ssh"}}</tool_call>');
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.residual, 'Let me check.');
  assert.deepEqual(parsed.calls, [{ name: 'sg1', arguments: { action: 'search', query: 'ssh' } }]);

  const multiple = parseTextToolCalls('<tool_call>{"name":"sg1","arguments":{"action":"search"}}</tool_call>\n<tool_call>{"name":"sg2","arguments":{"action":"search"}}</tool_call>');
  assert.equal(multiple.calls.length, 2);
  assert.equal(multiple.residual, '');

  const incomplete = parseTextToolCalls('Checking <tool_call>{"name":"sg1"}');
  assert.equal(incomplete.malformed, true);
  assert.equal(incomplete.residual, 'Checking');
});

test('legacy exec calls route through the SG1 shell tool', () => {
  assert.deepEqual(routeToolCall({ id: 'x', name: 'exec', arguments: { command: 'hostname' } }, 0), {
    id: 'x',
    name: 'sg1',
    arguments: { action: 'call', name: 'shell', arguments: { command: 'hostname' } },
  });
});

test('malformed SG arguments are not promoted while unknown functions become safe discovery', () => {
  assert.equal(routeToolCall({ id: 'bad', name: 'exec', arguments: '{bad' }, 0).arguments, null);
  assert.equal(routeToolCall({ id: 'bad', name: 'sg1', arguments: '{bad' }, 0).arguments, null);
  assert.deepEqual(routeToolCall({ id: 'x', name: 'hallucinated_tool', arguments: '{bad' }, 0), {
    id: 'x',
    name: 'sg1',
    arguments: { action: 'search', query: 'hallucinated_tool', limit: 12 },
  });
});

test('provider stream completion requires DONE or a finish reason', () => {
  assert.throws(() => assertStreamCompleted(false, null, true), /without a completion marker/);
  assert.doesNotThrow(() => assertStreamCompleted(true, null, true));
  assert.doesNotThrow(() => assertStreamCompleted(false, 'stop', true));
});

test('agent loop executes SG tool call and only emits the final answer', async () => {
  const providerCalls = [];
  const gatewayCalls = [];
  const emitted = [];
  const activity = [];
  const fakeModel = {
    async runChat(_config, _model, messages) {
      providerCalls.push(messages);
      if (providerCalls.length === 1) {
        return {
          reply: 'I will inspect it.\n<tool_call>{"name":"sg1","arguments":{"action":"call","name":"remote_exec","arguments":{"server":"geth","command":"hostname"}}}</tool_call>',
          toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, provider: 'test',
        };
      }
      assert.equal(messages.at(-1).role, 'tool');
      assert.match(messages.at(-1).content, /goddess/);
      return {
        reply: 'SG1 is reachable.', toolCalls: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, provider: 'test',
      };
    },
  };
  const gateway = {
    async execute(name, args) {
      gatewayCalls.push({ name, args });
      return { server: 'sg1', tool: 'remote_exec', result: 'goddess-mcp' };
    },
  };
  const loop = new AgentLoop(config(), () => {}, { modelclient: fakeModel, gateway });
  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Can you reach SG1?' }],
    onFinalDelta: (text) => emitted.push(text),
    onActivity: (event) => activity.push(event),
  });
  assert.equal(result.reply, 'SG1 is reachable.');
  assert.deepEqual(emitted, ['SG1 is reachable.']);
  assert.equal(gatewayCalls.length, 1);
  assert.equal(gatewayCalls[0].name, 'sg1');
  assert.equal(gatewayCalls[0].args.name, 'remote_exec');
  assert.equal(result.usage.total_tokens, 29);
  assert.ok(activity.some((event) => event.phase === 'tool' && event.status === 'running'));
  assert.ok(activity.some((event) => event.phase === 'tool' && event.status === 'complete'));
  assert.doesNotMatch(result.reply, /tool_call/);
});

test('malformed tool markup is withheld and retried', async () => {
  let calls = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        calls += 1;
        if (calls === 1) return { reply: 'Wait <tool_call>{bad json}', toolCalls: [], usage: {}, provider: 'test' };
        assert.match(messages.at(-1).content, /malformed/);
        return { reply: 'Recovered.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: { execute: async () => { throw new Error('must not execute malformed call'); } },
  });
  const result = await loop.run({ modelId: 'qwen-test', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(result.reply, 'Recovered.');
  assert.equal(calls, 2);
});

test('native calls strip any duplicate textual tool markup and redact tool secrets', async () => {
  let calls = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        calls += 1;
        if (calls === 1) {
          return {
            reply: 'Checking now. <tool_call>{"name":"sg1","arguments":{"action":"search"}}</tool_call>',
            toolCalls: [{
              id: 'native-1', type: 'function',
              function: { name: 'sg1', arguments: '{"action":"search","query":"status"}' },
            }],
            usage: {}, provider: 'test',
          };
        }
        const assistant = messages.at(-2);
        const tool = messages.at(-1);
        assert.equal(assistant.content, 'Checking now.');
        assert.doesNotMatch(tool.content, /sk-live-super-secret-token/);
        assert.match(tool.content, /sk-REDACTED/);
        return { reply: 'Done.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: { execute: async () => ({ result: 'sk-live-super-secret-token' }) },
  });
  const result = await loop.run({ modelId: 'qwen-test', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(result.reply, 'Done.');
});

test('length responses continue and combine clean partial answer text', async () => {
  let calls = 0;
  const emitted = [];
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        calls += 1;
        if (calls === 1) {
          return {
            reply: 'The answer is ', toolCalls: [], finishReason: 'length', usage: { total_tokens: 2 }, provider: 'test',
          };
        }
        assert.match(messages.at(-1).content, /Continue the answer exactly/);
        return {
          reply: 'complete.', toolCalls: [], finishReason: 'stop', usage: { total_tokens: 3 }, provider: 'test',
        };
      },
    },
    gateway: { execute: async () => { throw new Error('no tool expected'); } },
  });
  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'answer' }],
    onFinalDelta: (text) => emitted.push(text),
  });
  assert.equal(result.reply, 'The answer is complete.');
  assert.deepEqual(emitted, ['The answer is complete.']);
  assert.equal(result.usage.total_tokens, 5);
});

test('truncated tool attempts are never executed and raw markup is never emitted', async () => {
  let calls = 0;
  let executions = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat() {
        calls += 1;
        if (calls === 1) {
          return {
            reply: 'Checking <tool_call>{"name":"sg1"',
            toolCalls: [],
            finishReason: 'length',
            usage: {},
            provider: 'test',
          };
        }
        return { reply: 'Safe answer.</tool_call>', toolCalls: [], finishReason: 'stop', usage: {}, provider: 'test' };
      },
    },
    gateway: { execute: async () => { executions += 1; } },
  });
  const result = await loop.run({ modelId: 'qwen-test', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(executions, 0);
  assert.equal(result.reply, 'Safe answer.');
  assert.doesNotMatch(result.reply, /tool_call/);
});

test('content_filter is a terminal provider error', async () => {
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat() {
        return { reply: 'partial', toolCalls: [], finishReason: 'content_filter', usage: {}, provider: 'test' };
      },
    },
    gateway: { execute: async () => { throw new Error('no tool expected'); } },
  });
  await assert.rejects(
    loop.run({ modelId: 'qwen-test', messages: [{ role: 'user', content: 'go' }] }),
    (error) => error.status === 502 && /content_filter/.test(error.message),
  );
});
