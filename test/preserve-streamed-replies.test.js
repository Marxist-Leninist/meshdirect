'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  install,
  createWrappedRun,
  mergeStreamedReply,
} = require('../server/preserve-streamed-replies');

const longAnswer = 'The detailed answer remains visible. '.repeat(30).trim();

test('keeps a substantial streamed answer when a short closing summary would replace it', () => {
  const summary = 'Fixed and saved.';
  const streamed = `${longAnswer}\n\n${summary}`;
  assert.strictEqual(mergeStreamedReply(streamed, summary), streamed);
});

test('still drops trivial pre-tool narration when the real answer follows', () => {
  const finalReply = 'The actual answer contains the useful result and enough detail to stand on its own.';
  assert.strictEqual(
    mergeStreamedReply(`I will check that now.\n\n${finalReply}`, finalReply),
    finalReply,
  );
});

test('wrapped run forwards live deltas but publishes the preserved final only once', async () => {
  const summary = 'Done.';
  const originalRun = async (options) => {
    options.onActivity({ phase: 'model', status: 'running', round: 1 });
    options.onDelta(longAnswer);
    options.onActivity({ phase: 'tool', status: 'running', round: 1 });
    options.onActivity({ phase: 'model', status: 'running', round: 2 });
    options.onDelta(summary);
    options.onFinalDelta(summary);
    return { reply: summary, rounds: 2, tools: [] };
  };

  const deltas = [];
  const finals = [];
  const activities = [];
  const output = await createWrappedRun(originalRun).call({}, {
    onDelta: (text) => deltas.push(text),
    onFinalDelta: (text) => finals.push(text),
    onActivity: (event) => activities.push(event),
  });

  assert.deepStrictEqual(deltas, [longAnswer, summary]);
  assert.strictEqual(finals.length, 1);
  assert.ok(finals[0].includes(longAnswer));
  assert.ok(finals[0].endsWith(summary));
  assert.strictEqual(output.reply, finals[0]);
  assert.ok(activities.some((event) => event.status === 'recovered'));
});

test('live steering discards stale streamed text before preserving the revised answer', async () => {
  const stale = 'This stale draft must not survive. '.repeat(30).trim();
  const revised = 'This is the revised answer after steering. '.repeat(20).trim();
  let steeringTaken = false;

  const originalRun = async (options) => {
    options.onActivity({ phase: 'model', status: 'running', round: 1 });
    options.onDelta(stale);
    options.takeSteering({ round: 1, resetOutput: true, phase: 'after-decision' });
    options.onActivity({ phase: 'model', status: 'running', round: 2 });
    options.onDelta(revised);
    options.onFinalDelta(revised);
    return { reply: revised, rounds: 2, tools: [] };
  };

  const finals = [];
  const output = await createWrappedRun(originalRun).call({}, {
    takeSteering: () => {
      if (steeringTaken) return [];
      steeringTaken = true;
      return [{ message: 'Revise it' }];
    },
    onDelta: () => {},
    onFinalDelta: (text) => finals.push(text),
    onActivity: () => {},
  });

  assert.strictEqual(output.reply, revised);
  assert.deepStrictEqual(finals, [revised]);
  assert.ok(!output.reply.includes('stale draft'));
});

test('install is idempotent', () => {
  class FakeAgentLoop {
    async run() { return { reply: 'ok' }; }
  }
  assert.strictEqual(install(FakeAgentLoop), true);
  assert.strictEqual(install(FakeAgentLoop), false);
});
