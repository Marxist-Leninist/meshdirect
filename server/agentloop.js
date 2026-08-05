'use strict';

const modelclient = require('./modelclient');
const { MODEL_TOOLS, SGToolGateway, normalizeArguments } = require('./sgtools');
const { CAP_TOOLS, CAP_TOOL_NAMES, CapabilityGateway } = require('./agentcaps');

// The model sees the SG gateways plus the local capability tools as one list.
const ALL_TOOLS = [...MODEL_TOOLS, ...CAP_TOOLS];
const { redactSecrets, sanitizeError } = require('./util');

const TOOL_TAG_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const TOOL_TAG_OPEN_RE = /<tool_call>/i;
const TOOL_TAG_ANY_RE = /<\/?tool_call\b[^>]*>/gi;

function safeJson(value, maximum = 60_000) {
  let text;
  try { text = JSON.stringify(value); } catch { text = JSON.stringify({ error: 'Tool result was not serializable' }); }
  text = redactSecrets(text).replace(/\u0000/g, '');
  if (text.length <= maximum) return text;
  const half = Math.max(1_000, Math.floor((maximum - 100) / 2));
  return `${text.slice(0, half)}\n...[tool result truncated ${text.length - half * 2} chars]...\n${text.slice(-half)}`;
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last >= first) text = text.slice(first, last + 1);
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseTextToolCalls(content) {
  if (typeof content !== 'string' || !TOOL_TAG_OPEN_RE.test(content)) {
    const residual = String(content || '').replace(TOOL_TAG_ANY_RE, '');
    return { calls: [], residual, rawResidual: residual, malformed: false };
  }
  TOOL_TAG_RE.lastIndex = 0;
  const calls = [];
  let malformed = false;
  let matched = false;
  let residual = '';
  let cursor = 0;
  let match;
  while ((match = TOOL_TAG_RE.exec(content)) !== null) {
    matched = true;
    residual += content.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const value = parseJsonObject(match[1]);
    if (!value || typeof value.name !== 'string' || !value.name.trim()) {
      malformed = true;
      continue;
    }
    calls.push({ name: value.name.trim(), arguments: normalizeArguments(value.arguments) });
  }
  residual += content.slice(cursor);
  if (!matched) {
    malformed = true;
    residual = content.slice(0, content.search(TOOL_TAG_OPEN_RE));
  } else if (TOOL_TAG_OPEN_RE.test(residual)) {
    malformed = true;
    residual = residual.slice(0, residual.search(TOOL_TAG_OPEN_RE));
  }
  residual = residual.replace(TOOL_TAG_ANY_RE, '');
  return { calls, residual: residual.trim(), rawResidual: residual, malformed };
}

function parseNativeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call, index) => {
    const fn = call && call.function && typeof call.function === 'object' ? call.function : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) return [];
    return [{
      id: typeof call.id === 'string' && call.id ? call.id : `call-${index + 1}`,
      name,
      arguments: normalizeArguments(fn.arguments),
    }];
  });
}

function routeToolCall(call, index) {
  let name = call.name;
  let args = normalizeArguments(call.arguments);
  if (name === 'exec') {
    name = 'sg1';
    // Only a valid JSON object can be promoted to a legacy shell call. A
    // malformed argument payload remains invalid and the gateway rejects it.
    if (args) args = { action: 'call', name: 'shell', arguments: args };
  } else if (CAP_TOOL_NAMES.has(name)) {
    // Local capability tools (memory, skills, subagent, schedule,
    // mcp_servers) are executed in-process. Their arguments are their own;
    // do not rewrite them into an SG discovery call.
  } else if (name !== 'sg1' && name !== 'sg2') {
    // A hallucinated direct function name must never become an accidental
    // no-argument call. Convert it into safe discovery; the next round can
    // invoke the exact SG tool deliberately.
    args = { action: 'search', query: name, limit: 12 };
    name = 'sg1';
  }
  return {
    id: call.id || `call-${Date.now()}-${index + 1}`,
    name,
    arguments: args,
  };
}

function toolLabel(call) {
  const args = call.arguments || {};
  const action = args.action;
  if (action === 'search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    return `${call.name.toUpperCase()} tool search${query ? `: ${query.slice(0, 80)}` : ''}`;
  }
  const target = typeof args.name === 'string' ? args.name : 'invalid request';
  return `${call.name.toUpperCase()} · ${target.slice(0, 120)}`;
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) total[key] += value;
  }
}

class AgentLoop {
  constructor(config, log = () => {}, dependencies = {}) {
    this.config = config;
    this.log = log;
    this.modelclient = dependencies.modelclient || modelclient;
    this.gateway = dependencies.gateway || new SGToolGateway(config, log);
    this.caps = dependencies.caps || new CapabilityGateway(config, log);
  }

  async run({ modelId, messages, signal, onActivity, onProviderError, onFinalDelta, onDelta, takeSteering, setSteeringInterrupt }) {
    const transcript = messages.map((message) => ({ ...message }));
    // Fold the live skill index and memory digest into the system message so
    // the agent starts each turn already knowing what it knows.
    try {
      const capContext = this.caps.promptContext();
      if (capContext) {
        const systemIndex = transcript.findIndex((m) => m && m.role === 'system');
        if (systemIndex >= 0) transcript[systemIndex].content = `${transcript[systemIndex].content || ''}${capContext}`;
      }
    } catch (error) {
      this.log(`agentcaps: prompt context unavailable: ${error && error.message}`);
    }
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const tools = [];
    const answerParts = [];
    let toolCount = 0;
    let lastProvider = '';

    const activity = (value) => { if (onActivity) onActivity(value); };
    const registerSteeringInterrupt = (value) => {
      if (typeof setSteeringInterrupt === 'function') setSteeringInterrupt(value);
    };
    const yieldToIo = () => new Promise((resolve) => setImmediate(resolve));
    const consumeSteering = (meta) => {
      if (typeof takeSteering !== 'function') return [];
      const value = takeSteering(meta);
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => {
        if (typeof item === 'string' && item.trim()) return [{ message: item.trim() }];
        if (!item || typeof item.message !== 'string' || !item.message.trim()) return [];
        return [{ ...item, message: item.message.trim() }];
      });
    };
    const appendSteering = (items) => {
      for (const item of items) {
        transcript.push({
          role: 'user',
          content: `[Latest live instruction from the user for this current turn. Replan and revise the work accordingly.]\n${item.message}`,
        });
      }
    };

    const maxRounds = Number(this.config.maxAgentRounds) > 0 ? Number(this.config.maxAgentRounds) : Infinity;
    for (let round = 1; round <= maxRounds; round += 1) {
      if (signal && signal.aborted) {
        const error = new Error('aborted');
        error.status = 499;
        throw error;
      }
      const steering = consumeSteering({ round, resetOutput: true, phase: 'before-model' });
      if (steering.length) {
        answerParts.length = 0;
        appendSteering(steering);
        activity({
          phase: 'steer',
          status: 'applied',
          label: steering.length === 1
            ? 'Applying live steering at the next model step'
            : `Applying ${steering.length} live steering instructions`,
          round,
          steeringCount: steering.length,
        });
      }
      activity({ phase: 'model', status: 'running', label: 'Qwen is deciding the next step', round });
      const decisionAbort = new AbortController();
      const decisionSignal = signal
        ? AbortSignal.any([signal, decisionAbort.signal])
        : decisionAbort.signal;
      let interruptedForSteering = false;
      registerSteeringInterrupt(() => {
        if (decisionAbort.signal.aborted) return false;
        interruptedForSteering = true;
        decisionAbort.abort(new Error('live steering'));
        return true;
      });

      let output;
      try {
        output = await this.modelclient.runChat(this.config, modelId, transcript, {
          signal: decisionSignal,
          tools: ALL_TOOLS,
          onProviderError,
          onDelta, // live filtered text chunks; tool markup never reaches this path
        });
      } catch (error) {
        // Give the accepted steering request one I/O turn to enter the pending
        // queue after its provider abort. A whole-turn stop always wins.
        await yieldToIo();
        if (signal && signal.aborted) throw error;
        const duringModelSteering = consumeSteering({
          round, resetOutput: true, phase: 'during-model',
        });
        if (interruptedForSteering && duringModelSteering.length) {
          answerParts.length = 0;
          appendSteering(duringModelSteering);
          activity({
            phase: 'steer',
            status: 'applied',
            label: duringModelSteering.length === 1
              ? 'Stopped the stale model draft and applied steering'
              : `Stopped the stale model draft and applied ${duringModelSteering.length} steering instructions`,
            round,
            steeringCount: duringModelSteering.length,
          });
          continue;
        }
        throw error;
      } finally {
        registerSteeringInterrupt(null);
      }

      lastProvider = output.provider || lastProvider;
      addUsage(usage, output.usage);

      // A steering POST may already be readable by Node when the provider
      // promise resolves. Yield one event-loop turn so that request is handled
      // before we commit the model's now-stale answer or tool decision.
      await yieldToIo();

      let calls = parseNativeToolCalls(output.toolCalls);
      const textFallback = parseTextToolCalls(output.reply || '');
      if (!calls.length && textFallback.calls.length) {
        calls = textFallback.calls.map((call, index) => ({ ...call, id: `text-call-${round}-${index + 1}` }));
      }

      const finishReason = typeof output.finishReason === 'string'
        ? output.finishReason.toLowerCase()
        : '';
      if (finishReason === 'content_filter') {
        throw new modelclient.ProviderError('Provider blocked the response with content_filter', 502, false);
      }
      if (finishReason === 'length') {
        // Never execute a call from a truncated pass: its arguments may only
        // look valid while missing a suffix. Preserve clean prose continuations
        // and ask the model to regenerate any intended function call in full.
        const cleanPartial = String(textFallback.rawResidual || '');
        const hasToolAttempt = calls.length > 0 || textFallback.malformed || textFallback.calls.length > 0;
        if (!hasToolAttempt && cleanPartial) answerParts.push(cleanPartial);
        transcript.push({ role: 'assistant', content: cleanPartial.trim() || '(response truncated)' });
        transcript.push({
          role: 'user',
          content: hasToolAttempt
            ? 'The previous response was truncated. Do not continue or reuse its partial tool call. Issue a complete supplied sg1 or sg2 function call from scratch, or return the final answer as plain text.'
            : 'Continue the answer exactly where it was truncated. Do not repeat completed text and do not print tool markup.',
        });
        activity({ phase: 'model', status: 'retrying', label: 'Qwen response was truncated; continuing', round });
        continue;
      }

      if (!calls.length && textFallback.malformed) {
        transcript.push({ role: 'assistant', content: textFallback.residual || '(attempted a tool call)' });
        transcript.push({
          role: 'user',
          content: 'Your tool call was malformed and was not executed. Use the supplied sg1 or sg2 function tool with valid JSON arguments. Do not print tool markup.',
        });
        activity({ phase: 'model', status: 'retrying', label: 'Qwen produced a malformed tool request; retrying', round });
        continue;
      }

      // Steering accepted while the provider was producing this decision must
      // be applied before committing either a final answer or any tool call.
      // This is the critical stale-decision suppression boundary.
      const decisionSteering = consumeSteering({ round, resetOutput: true, phase: 'after-decision' });
      if (decisionSteering.length) {
        answerParts.length = 0;
        appendSteering(decisionSteering);
        activity({
          phase: 'steer',
          status: 'applied',
          label: decisionSteering.length === 1
            ? 'Steering arrived during the model decision; replanning'
            : `${decisionSteering.length} steering instructions arrived; replanning`,
          round,
          steeringCount: decisionSteering.length,
        });
        continue;
      }

      if (!calls.length) {
        const finalPart = String(textFallback.rawResidual || '');
        const reply = `${answerParts.join('')}${finalPart}`.trim();
        if (!reply) {
          transcript.push({ role: 'assistant', content: '(empty response)' });
          transcript.push({ role: 'user', content: 'Return the completed answer as plain text.' });
          continue;
        }
        if (onFinalDelta) onFinalDelta(reply);
        activity({ phase: 'complete', status: 'complete', label: 'Reply complete', round });
        return { reply, usage, tools, rounds: round, provider: lastProvider };
      }

      const maxToolCalls = Number(this.config.maxToolCalls);
      if (maxToolCalls > 0 && toolCount + calls.length > maxToolCalls) {
        throw new Error(`Agent exceeded the ${maxToolCalls} tool-call limit`);
      }
      const routed = calls.map(routeToolCall);
      transcript.push({
        role: 'assistant',
        content: textFallback.residual || null,
        tool_calls: routed.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });

      let steeredAfterTool = false;
      for (let callIndex = 0; callIndex < routed.length; callIndex += 1) {
        const call = routed[callIndex];
        toolCount += 1;
        const label = toolLabel(call);
        const record = { label, status: 'running', time: new Date().toISOString() };
        tools.push(record);
        activity({ phase: 'tool', status: 'running', label, tool: label, round, toolCount });
        let result;
        try {
          const value = this.caps.handles(call.name)
            ? await this.caps.execute(call.name, call.arguments, { signal })
            : await this.gateway.execute(call.name, call.arguments, { signal });
          result = safeJson({ ok: true, ...value }, this.config.maxToolResultChars);
          record.status = 'complete';
          activity({ phase: 'tool', status: 'complete', label, tool: label, round, toolCount });
        } catch (error) {
          if (signal && signal.aborted) throw error;
          const message = sanitizeError(error && error.message);
          // Classify the failure so the model can reason about retries:
          // transport kinds carry actionable hints, tool kinds mean the
          // remote tool itself rejected the call.
          const errorKind = error && error.kind ? error.kind : (error && error.transport ? 'transport' : 'tool');
          const errorPayload = { ok: false, error: message, errorKind };
          if (error && error.elapsedMs !== undefined) errorPayload.elapsedMs = error.elapsedMs;
          result = safeJson(errorPayload, this.config.maxToolResultChars);
          record.status = 'error';
          activity({ phase: 'tool', status: 'error', label, tool: label, error: message, round, toolCount });
        }
        transcript.push({ role: 'tool', tool_call_id: call.id, content: result });

        // Same race at a tool boundary: let an instruction accepted while the
        // tool was finishing land before any remaining stale calls execute.
        await yieldToIo();
        const toolSteering = consumeSteering({ round, resetOutput: true, phase: 'after-tool' });
        if (toolSteering.length) {
          // Keep the tool-call transcript structurally valid without executing
          // stale remaining calls selected before the steering arrived.
          for (let skippedIndex = callIndex + 1; skippedIndex < routed.length; skippedIndex += 1) {
            transcript.push({
              role: 'tool',
              tool_call_id: routed[skippedIndex].id,
              content: safeJson({
                ok: false,
                skipped: true,
                error: 'Skipped because the user steered the active turn.',
              }, this.config.maxToolResultChars),
            });
          }
          answerParts.length = 0;
          appendSteering(toolSteering);
          activity({
            phase: 'steer',
            status: 'applied',
            label: toolSteering.length === 1
              ? 'Finished the active tool, then applied steering'
              : `Finished the active tool, then applied ${toolSteering.length} steering instructions`,
            round,
            steeringCount: toolSteering.length,
          });
          steeredAfterTool = true;
          break;
        }
      }
      if (steeredAfterTool) continue;
    }
    throw new Error(`Agent reached ${maxRounds} model rounds without a final answer`);
  }
}

module.exports = {
  AgentLoop,
  parseNativeToolCalls,
  parseTextToolCalls,
  routeToolCall,
  safeJson,
};