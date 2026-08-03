// MeshDirect autonomous tool-use loop.
'use strict';
const { randomToken, compactOneLine } = require('./util');
const modelclient = require('./modelclient');
const { getToolDefinitions, executeTool, labelFor } = require('./toolregistry');

const TEXT_TOOL_RE = /<tool_call(?:\s[^>]*)?>([\s\S]*?)<\/tool_call\s*>/gi;

function parseTextToolCalls(text) {
  const source = String(text || '');
  const calls = [];
  let match;
  TEXT_TOOL_RE.lastIndex = 0;
  while ((match = TEXT_TOOL_RE.exec(source)) !== null) {
    const raw = match[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const fn = parsed && parsed.function && typeof parsed.function === 'object' ? parsed.function : parsed;
    const name = fn && typeof fn.name === 'string' ? fn.name : '';
    if (!name) continue;
    let args = fn.arguments != null ? fn.arguments : parsed.arguments;
    if (args == null) args = {};
    if (typeof args !== 'string') args = JSON.stringify(args);
    calls.push({
      id: parsed.id || `call_text_${randomToken(8)}`,
      type: 'function',
      function: { name, arguments: args },
      textual: true,
    });
  }
  const visible = calls.length ? source.replace(TEXT_TOOL_RE, '').replace(/<tool_calls?>|<\/tool_calls?>/gi, '').trim() : source;
  return { calls, visible };
}

function normalizeNativeCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls.map((call, index) => ({
    id: call && call.id ? String(call.id) : `call_native_${randomToken(8)}_${index}`,
    type: 'function',
    function: {
      name: call && call.function && call.function.name ? String(call.function.name) : '',
      arguments: call && call.function && call.function.arguments != null ? String(call.function.arguments) : '{}',
    },
  })).filter((call) => call.function.name);
}

function createStreamingGuard(onDelta) {
  let raw = '';
  let emitted = 0;
  const guardChars = 96;

  function push(text) {
    raw += String(text || '');
    const lower = raw.toLowerCase();
    const tagAt = lower.indexOf('<tool_call');
    const safeEnd = tagAt >= 0
      ? raw.slice(0, tagAt).trimEnd().length
      : Math.max(emitted, raw.length - guardChars);
    if (safeEnd > emitted) {
      onDelta(raw.slice(emitted, safeEnd));
      emitted = safeEnd;
    }
  }

  function finish(visible, hasTextualTools) {
    const target = String(visible || '');
    if (!hasTextualTools) {
      if (raw.length > emitted) onDelta(raw.slice(emitted));
      emitted = raw.length;
      return;
    }
    // Text before the first XML tool block is a prefix of visible and may have streamed.
    const alreadyVisible = Math.min(emitted, target.length);
    if (target.length > alreadyVisible) onDelta(target.slice(alreadyVisible));
    emitted = raw.length;
  }

  return { push, finish, raw: () => raw };
}

function assistantToolMessage(content, calls) {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments || '{}' },
    })),
  };
}

function joinReply(current, next) {
  const a = String(current || '').trimEnd();
  const b = String(next || '').trim();
  if (!b) return a;
  if (!a) return b;
  return `${a}\n\n${b}`;
}

async function runAgent(config, model, initialMessages, hooks = {}) {
  const tools = getToolDefinitions();
  const messages = initialMessages.map((m) => ({ ...m }));
  const toolHistory = [];
  const signatureCounts = new Map();
  let combinedReply = '';
  let finalUsage = null;
  let provider = null;
  let totalToolCalls = 0;
  let reasoningChars = 0;

  for (let step = 1; step <= config.maxAgentSteps; step += 1) {
    if (hooks.signal && hooks.signal.aborted) { const e = new Error('aborted'); e.status = 499; throw e; }
    if (hooks.onProgress) hooks.onProgress({ phase: 'model', activity: 'thinking', step, totalToolCalls });

    const guard = createStreamingGuard((text) => {
      if (!text) return;
      if (hooks.onDelta) hooks.onDelta(text);
    });

    const output = await modelclient.runChat(config, config.lanes[model].modelId, messages, {
      signal: hooks.signal,
      tools,
      onDelta: guard.push,
      onReasoning: (count) => {
        reasoningChars += count;
        if (hooks.onProgress) hooks.onProgress({ phase: 'model', activity: 'reasoning', step, totalToolCalls, reasoningChars });
      },
      onToolDelta: () => {
        if (hooks.onProgress) hooks.onProgress({ phase: 'model', activity: 'preparing tool call', step, totalToolCalls });
      },
      onProviderError: hooks.onProviderError,
    });
    provider = output.provider || provider;
    finalUsage = output.usage || finalUsage;

    const rawText = guard.raw();
    const textual = parseTextToolCalls(rawText);
    const nativeCalls = normalizeNativeCalls(output.toolCalls);
    const calls = nativeCalls.length ? nativeCalls : textual.calls;
    const visible = textual.calls.length ? textual.visible : rawText;
    guard.finish(visible, textual.calls.length > 0);
    combinedReply = joinReply(combinedReply, visible);

    if (!calls.length) {
      if (hooks.onProgress) hooks.onProgress({ phase: 'complete', activity: 'done', step, totalToolCalls });
      return {
        reply: combinedReply,
        usage: finalUsage,
        provider,
        tools: toolHistory,
        steps: step,
        toolCalls: totalToolCalls,
        reasoningChars,
      };
    }

    messages.push(assistantToolMessage(visible, calls));

    for (const call of calls.slice(0, config.maxToolCallsPerStep)) {
      if (totalToolCalls >= config.maxToolCallsPerTurn) {
        messages.push({
          role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify({ ok: false, error: `Tool call limit ${config.maxToolCallsPerTurn} reached. Finish the task with the available results.` }),
        });
        continue;
      }
      if (hooks.signal && hooks.signal.aborted) { const e = new Error('aborted'); e.status = 499; throw e; }

      totalToolCalls += 1;
      const signature = `${call.function.name}:${compactOneLine(call.function.arguments, 2000)}`;
      const repeated = (signatureCounts.get(signature) || 0) + 1;
      signatureCounts.set(signature, repeated);

      let parsedArgs = {};
      try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch { /* executor reports malformed JSON */ }
      const label = labelFor(call.function.name, parsedArgs);
      const activity = {
        id: call.id,
        name: call.function.name,
        label,
        status: 'running',
        step,
        sequence: totalToolCalls,
        arguments: compactOneLine(call.function.arguments || '{}', 500),
        summary: '',
        durationMs: null,
      };
      toolHistory.push(activity);
      if (hooks.onTool) hooks.onTool({ ...activity, phase: 'start' });
      if (hooks.onProgress) hooks.onProgress({ phase: 'tool', activity: `running ${label}`, step, totalToolCalls, currentTool: call.function.name });

      let result;
      if (repeated > config.maxIdenticalToolCalls) {
        result = {
          name: call.function.name,
          label,
          ok: false,
          content: JSON.stringify({ ok: false, error: `Identical tool call repeated ${repeated} times; blocked to prevent a loop.` }),
          summary: 'repeated tool call blocked',
          durationMs: 0,
          arguments: activity.arguments,
        };
      } else {
        result = await executeTool(config, model, call, { signal: hooks.signal });
      }

      activity.status = result.ok ? 'done' : 'error';
      activity.summary = result.summary;
      activity.durationMs = result.durationMs;
      activity.truncated = !!result.truncated;
      if (hooks.onTool) hooks.onTool({ ...activity, phase: 'finish' });
      if (hooks.onProgress) hooks.onProgress({ phase: 'tool', activity: `${result.ok ? 'completed' : 'failed'} ${label}`, step, totalToolCalls, currentTool: null });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: String(result.content || '').slice(0, config.toolContextMaxChars),
      });
    }
  }

  // The model exhausted the configured loop. Preserve useful streamed text and make the limit explicit.
  const limitText = `Agent stopped after ${config.maxAgentSteps} model steps to prevent an infinite loop.`;
  if (hooks.onDelta) hooks.onDelta(`${combinedReply ? '\n\n' : ''}${limitText}`);
  return {
    reply: joinReply(combinedReply, limitText),
    usage: finalUsage,
    provider,
    tools: toolHistory,
    steps: config.maxAgentSteps,
    toolCalls: totalToolCalls,
    reasoningChars,
    limitReached: true,
  };
}

module.exports = {
  runAgent,
  parseTextToolCalls,
  normalizeNativeCalls,
  createStreamingGuard,
};
