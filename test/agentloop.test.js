'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentLoop, parseTextToolCalls, routeToolCall, toolLabel } = require('../server/agentloop');
const {
  applyToolCallDelta,
  assertStreamCompleted,
  materializeToolCalls,
} = require('../server/modelclient');

function config() {
  return { maxAgentRounds: 6, maxToolCalls: 8, maxToolResultChars: 20_000 };
}


test('local capability chips describe the requested action instead of claiming invalid request', () => {
  assert.equal(toolLabel({ name: 'schedule', arguments: { action: 'list' } }), 'SCHEDULE · list');
  assert.equal(
    toolLabel({ name: 'goals', arguments: { action: 'note', id: 'goal_msfg3pu43bze5d' } }),
    'GOALS · note: goal_msfg3pu43bze5d'
  );
  assert.equal(
    toolLabel({ name: 'skills', arguments: { action: 'read', name: 'mesh-cluster-ops' } }),
    'SKILLS · read: mesh-cluster-ops'
  );
  assert.equal(
    toolLabel({ name: 'mcp_servers', arguments: { action: 'call', name: 'lab', tool: 'probe' } }),
    'MCP_SERVERS · call: lab / probe'
  );
  assert.equal(
    toolLabel({ name: 'sg1', arguments: { action: 'call', name: 'remote_exec' } }),
    'SG1 · remote_exec'
  );
});

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

test('capability tool execution receives the AgentLoop nesting depth', async () => {
  let providerCall = 0;
  let seenOptions = null;
  const caps = {
    promptContext() { return ''; },
    handles(name) { return name === 'subagent'; },
    async execute(name, args, options) {
      assert.equal(name, 'subagent');
      assert.equal(args.action, 'spawn');
      seenOptions = options;
      return { blocked: true };
    },
  };
  const loop = new AgentLoop(config(), () => {}, {
    depth: 2,
    caps,
    gateway: { async execute() { throw new Error('SG gateway should not be called'); } },
    modelclient: {
      async runChat(_config, _model, messages) {
        providerCall += 1;
        if (providerCall === 1) {
          return {
            reply: '',
            toolCalls: [{
              id: 'spawn-1', type: 'function',
              function: { name: 'subagent', arguments: JSON.stringify({ action: 'spawn', task: 'nested' }) },
            }],
            usage: {}, provider: 'test', finishReason: 'tool_calls',
          };
        }
        assert.equal(messages.at(-1).role, 'tool');
        return { reply: 'Depth was enforced.', toolCalls: [], usage: {}, provider: 'test', finishReason: 'stop' };
      },
    },
  });
  const result = await loop.run({
    modelId: 'test',
    messages: [{ role: 'user', content: 'spawn' }],
    onActivity() {},
  });
  assert.equal(result.reply, 'Depth was enforced.');
  assert.equal(seenOptions.depth, 2);
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

test('zero round and tool-call limits keep running until the agent completes', async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  const unlimited = { ...config(), maxAgentRounds: 0, maxToolCalls: 0 };
  const loop = new AgentLoop(unlimited, () => {}, {
    modelclient: {
      async runChat() {
        modelCalls += 1;
        if (modelCalls <= 12) {
          return {
            reply: '',
            toolCalls: [{
              id: `call-${modelCalls}`,
              type: 'function',
              function: { name: 'sg1', arguments: '{"action":"search","query":"health"}' },
            }],
            usage: {},
            provider: 'test',
          };
        }
        return { reply: 'Verified complete.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: {
      async execute() {
        toolCalls += 1;
        return { result: 'healthy' };
      },
    },
  });
  const result = await loop.run({ modelId: 'qwen-test', messages: [{ role: 'user', content: 'own this goal' }] });
  assert.equal(result.reply, 'Verified complete.');
  assert.equal(result.rounds, 13);
  assert.equal(toolCalls, 12);
});


test('live steering suppresses a stale model decision and is injected in order', async () => {
  const pending = [];
  const applied = [];
  let calls = 0;
  let executions = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        calls += 1;
        if (calls === 1) {
          assert.equal(messages.some((message) => String(message.content).includes('Latest live instruction')), false);
          pending.push({ id: 's1', message: 'Check DNS first.' }, { id: 's2', message: 'Do not restart anything.' });
          return {
            reply: '',
            toolCalls: [{
              id: 'tool-1',
              type: 'function',
              function: { name: 'sg1', arguments: '{"action":"search","query":"dns"}' },
            }],
            usage: {},
            provider: 'test',
          };
        }
        const steering = messages.filter((message) => (
          message.role === 'user' && String(message.content).includes('[Latest live instruction')
        ));
        assert.deepEqual(steering.map((message) => message.content.split('\n').at(-1)), [
          'Check DNS first.',
          'Do not restart anything.',
        ]);
        return { reply: 'Steered safely.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: {
      async execute() {
        executions += 1;
        return { result: 'must not run' };
      },
    },
  });
  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Repair the host.' }],
    takeSteering(meta) {
      const items = pending.splice(0);
      if (items.length) applied.push(meta);
      return items;
    },
  });
  assert.equal(result.reply, 'Steered safely.');
  assert.equal(calls, 2);
  assert.equal(executions, 0, 'the stale tool decision must not execute');
  assert.equal(applied[0].phase, 'after-decision');
  assert.equal(applied[0].resetOutput, true);
});

test('steering received during a would-be final draft causes a clean revision', async () => {
  const pending = [];
  let calls = 0;
  const applied = [];
  const emitted = [];
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        calls += 1;
        if (calls === 1) {
          pending.push({ id: 'late', message: 'Use the SSH relay instead.' });
          return { reply: 'I will restart DNS.', toolCalls: [], usage: {}, provider: 'test' };
        }
        assert.equal(messages.some((message) => message.role === 'assistant' && message.content === 'I will restart DNS.'), false);
        assert.match(messages.at(-1).content, /Use the SSH relay instead/);
        return { reply: 'I used the SSH relay and left DNS untouched.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: { execute: async () => { throw new Error('no tool expected'); } },
  });
  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Repair access.' }],
    takeSteering(meta) {
      const items = pending.splice(0);
      if (items.length) applied.push(meta);
      return items;
    },
    onFinalDelta: (text) => emitted.push(text),
  });
  assert.equal(result.reply, 'I used the SSH relay and left DNS untouched.');
  assert.deepEqual(emitted, ['I used the SSH relay and left DNS untouched.']);
  assert.equal(applied.at(-1).phase, 'after-decision');
  assert.equal(applied.at(-1).resetOutput, true);
  assert.equal(calls, 2);
});

test('steering after an active tool skips stale remaining tool calls', async () => {
  const pending = [];
  const executed = [];
  let modelCalls = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            reply: 'I will inspect both routes.',
            toolCalls: [
              { id: 'call-one', type: 'function', function: { name: 'sg1', arguments: '{"action":"search","query":"first"}' } },
              { id: 'call-two', type: 'function', function: { name: 'sg2', arguments: '{"action":"search","query":"second"}' } },
            ],
            usage: {}, provider: 'test',
          };
        }
        const skipped = messages.find((message) => (
          message.role === 'tool' && message.tool_call_id === 'call-two'
        ));
        assert.ok(skipped);
        assert.match(skipped.content, /Skipped because the user steered/);
        assert.match(messages.at(-1).content, /Do not probe the second route/);
        return { reply: 'Stopped after the first route and followed the new instruction.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: {
      async execute(name) {
        executed.push(name);
        pending.push({ id: 'during-tool', message: 'Do not probe the second route.' });
        return { result: 'first route checked' };
      },
    },
  });
  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Inspect the routes.' }],
    takeSteering() { return pending.splice(0); },
  });
  assert.deepEqual(executed, ['sg1']);
  assert.equal(modelCalls, 2);
  assert.match(result.reply, /followed the new instruction/);
});

test('steering already waiting in the I/O queue wins the provider completion race', async () => {
  const pending = [];
  let modelCalls = 0;
  let executions = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        modelCalls += 1;
        if (modelCalls === 1) {
          setImmediate(() => pending.push({ id: 'io-provider', message: 'Do not execute that tool.' }));
          return {
            reply: '',
            toolCalls: [{
              id: 'stale-tool',
              type: 'function',
              function: { name: 'sg1', arguments: '{"action":"search","query":"stale"}' },
            }],
            usage: {},
            provider: 'test',
          };
        }
        assert.match(messages.at(-1).content, /Do not execute that tool/);
        return { reply: 'Replanned before tool execution.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: {
      async execute() {
        executions += 1;
        return { result: 'must not execute' };
      },
    },
  });

  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Run the task.' }],
    takeSteering() { return pending.splice(0); },
  });

  assert.equal(result.reply, 'Replanned before tool execution.');
  assert.equal(modelCalls, 2);
  assert.equal(executions, 0);
});

test('steering already waiting in the I/O queue wins the tool completion race', async () => {
  const pending = [];
  const executions = [];
  let modelCalls = 0;
  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            reply: '',
            toolCalls: [
              { id: 'first-tool', type: 'function', function: { name: 'sg1', arguments: '{"action":"search","query":"first"}' } },
              { id: 'stale-second-tool', type: 'function', function: { name: 'sg2', arguments: '{"action":"search","query":"second"}' } },
            ],
            usage: {},
            provider: 'test',
          };
        }
        assert.match(messages.at(-1).content, /Skip the second tool/);
        const skipped = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'stale-second-tool');
        assert.match(skipped.content, /Skipped because the user steered/);
        return { reply: 'Stopped after the active tool.', toolCalls: [], usage: {}, provider: 'test' };
      },
    },
    gateway: {
      async execute(name) {
        executions.push(name);
        setImmediate(() => pending.push({ id: 'io-tool', message: 'Skip the second tool.' }));
        return { result: 'first complete' };
      },
    },
  });

  const result = await loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Run both checks.' }],
    takeSteering() { return pending.splice(0); },
  });

  assert.equal(result.reply, 'Stopped after the active tool.');
  assert.deepEqual(executions, ['sg1']);
  assert.equal(modelCalls, 2);
});

test('live steering aborts the in-flight model draft and replans immediately', async () => {
  const pending = [];
  const applied = [];
  const activities = [];
  let interrupt = null;
  let modelCalls = 0;
  let entered;
  const providerStarted = new Promise((resolve) => { entered = resolve; });

  const loop = new AgentLoop(config(), () => {}, {
    modelclient: {
      async runChat(_config, _model, messages, opts) {
        modelCalls += 1;
        if (modelCalls === 1) {
          opts.onDelta('Stale draft that must disappear.');
          entered();
          return new Promise((resolve, reject) => {
            const fail = () => {
              const error = new Error('aborted');
              error.status = 499;
              reject(error);
            };
            if (opts.signal.aborted) fail();
            else opts.signal.addEventListener('abort', fail, { once: true });
          });
        }
        assert.equal(messages.some((message) => (
          message.role === 'assistant' && String(message.content).includes('Stale draft')
        )), false);
        assert.match(messages.at(-1).content, /Use the relay immediately/);
        return {
          reply: 'Replanned immediately around the relay.',
          toolCalls: [],
          usage: {},
          provider: 'test',
        };
      },
    },
    gateway: { execute: async () => { throw new Error('no tool expected'); } },
  });

  const running = loop.run({
    modelId: 'qwen-test',
    messages: [{ role: 'user', content: 'Repair access.' }],
    setSteeringInterrupt(value) { interrupt = value; },
    takeSteering(meta) {
      const items = pending.splice(0);
      if (items.length) applied.push(meta);
      return items;
    },
    onActivity(event) { activities.push(event); },
    onDelta() {},
  });

  await providerStarted;
  pending.push({ id: 'instant', message: 'Use the relay immediately.' });
  assert.equal(typeof interrupt, 'function');
  assert.equal(interrupt(), true);

  const result = await running;
  assert.equal(result.reply, 'Replanned immediately around the relay.');
  assert.equal(modelCalls, 2);
  assert.equal(interrupt, null);
  assert.equal(applied[0].phase, 'during-model');
  assert.equal(applied[0].resetOutput, true);
  assert.ok(activities.some((event) => (
    event.phase === 'steer' && /Stopped the stale model draft/.test(event.label)
  )));
});
