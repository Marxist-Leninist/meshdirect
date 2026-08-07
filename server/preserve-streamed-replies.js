'use strict';

const PATCHED = Symbol.for('meshdirect.preserveStreamedReplies');
const MIN_STREAM_CHARS = 320;
const MIN_DROPPED_CHARS = 180;
const MIN_LENGTH_RATIO = 1.35;

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function compactText(value) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function containsSameText(haystack, needle) {
  const compactHaystack = compactText(haystack);
  const compactNeedle = compactText(needle);
  return !!compactNeedle && compactHaystack.includes(compactNeedle);
}

function mergeStreamedReply(streamedValue, finalValue) {
  const streamed = cleanText(streamedValue);
  const finalReply = cleanText(finalValue);

  if (!streamed) return finalReply;
  if (!finalReply) return streamed;
  if (compactText(streamed) === compactText(finalReply)) return finalReply;
  if (containsSameText(finalReply, streamed)) return finalReply;

  const dropped = streamed.length - finalReply.length;
  const substantialLoss = streamed.length >= MIN_STREAM_CHARS
    && dropped >= MIN_DROPPED_CHARS
    && streamed.length >= finalReply.length * MIN_LENGTH_RATIO;

  // A little pre-tool narration such as "I will check" should still disappear
  // when a real answer follows. Only rescue a meaningfully larger body of text.
  if (!substantialLoss) return finalReply;

  // The final pass is normally already the last streamed segment. In that case
  // the exact text the user watched is the authoritative answer and needs no
  // duplicate appended beneath it.
  if (containsSameText(streamed, finalReply)) return streamed;

  return `${streamed}\n\n---\n\n${finalReply}`;
}

function createWrappedRun(originalRun) {
  if (typeof originalRun !== 'function') throw new TypeError('AgentLoop.run must be a function');

  return async function preserveStreamedRun(options = {}) {
    const originalOnDelta = options.onDelta;
    const originalOnFinalDelta = options.onFinalDelta;
    const originalOnActivity = options.onActivity;
    const originalTakeSteering = options.takeSteering;

    const segments = [];
    let currentSegment = '';
    let currentRound = null;
    let observedFinal = '';

    const flushSegment = () => {
      const text = cleanText(currentSegment);
      if (text) segments.push(text);
      currentSegment = '';
    };

    const wrapped = {
      ...options,
      onActivity: (event) => {
        if (event && event.phase === 'model' && event.status === 'running') {
          const round = Number.isSafeInteger(event.round) ? event.round : null;
          if (currentRound !== null && round !== currentRound) flushSegment();
          currentRound = round;
        }
        if (typeof originalOnActivity === 'function') originalOnActivity(event);
      },
      onDelta: (text) => {
        if (typeof text === 'string' && text) currentSegment += text;
        if (typeof originalOnDelta === 'function') originalOnDelta(text);
      },
      // Hold back the authoritative final replacement until we have compared it
      // with everything the user was shown. This prevents a short closing pass
      // from briefly blanking or replacing a much larger streamed answer.
      onFinalDelta: (text) => {
        observedFinal = cleanText(text);
      },
      takeSteering: (meta) => {
        const items = typeof originalTakeSteering === 'function'
          ? originalTakeSteering(meta)
          : [];
        if (Array.isArray(items) && items.length && meta && meta.resetOutput) {
          segments.length = 0;
          currentSegment = '';
          currentRound = null;
        }
        return items;
      },
    };

    const output = await originalRun.call(this, wrapped);
    flushSegment();

    const streamed = segments.join('\n\n');
    const finalReply = output && typeof output.reply === 'string'
      ? output.reply
      : observedFinal;
    const merged = mergeStreamedReply(streamed, finalReply);

    if (output && typeof output === 'object') output.reply = merged;

    if (merged !== cleanText(finalReply) && typeof originalOnActivity === 'function') {
      originalOnActivity({
        phase: 'model',
        status: 'recovered',
        label: 'Kept the longer streamed answer instead of replacing it with a short closing summary',
        round: output && Number.isSafeInteger(output.rounds) ? output.rounds : undefined,
      });
    }
    if (typeof originalOnFinalDelta === 'function') originalOnFinalDelta(merged);

    return output;
  };
}

function install(AgentLoopClass) {
  if (!AgentLoopClass) ({ AgentLoop: AgentLoopClass } = require('./agentloop'));
  if (!AgentLoopClass || !AgentLoopClass.prototype || typeof AgentLoopClass.prototype.run !== 'function') {
    throw new TypeError('AgentLoop class is unavailable');
  }
  if (AgentLoopClass.prototype[PATCHED]) return false;

  const originalRun = AgentLoopClass.prototype.run;
  Object.defineProperty(AgentLoopClass.prototype, PATCHED, {
    value: originalRun,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  AgentLoopClass.prototype.run = createWrappedRun(originalRun);
  return true;
}

module.exports = {
  install,
  createWrappedRun,
  mergeStreamedReply,
};
