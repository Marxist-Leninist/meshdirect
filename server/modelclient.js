// warm in-process model client: streaming OpenAI-compatible chat over corporate proxy,
// runtime key resolution (token-plan vault resolver) + free-pool fallback. Memory-only keys.
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { sanitizeError } = require('./util');

// --- key management (never written to disk or logs) ---------------------------
let primaryKey = null;
let fallbackKey = null;

function resolvePrimaryKey(config, force) {
  if (primaryKey && !force) return Promise.resolve(primaryKey);
  const input = JSON.stringify({
    protocolVersion: 1,
    provider: config.providers.primary.resolverProvider,
    ids: [config.providers.primary.resolverId],
  });
  return new Promise((resolve, reject) => {
    const child = execFile(config.providers.primary.resolverPath, [], { timeout: 15000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      let out = null;
      try { out = JSON.parse(stdout || '{}'); } catch { /* fall through */ }
      const key = out && out.values && out.values[config.providers.primary.resolverId];
      if (typeof key === 'string' && key.length > 8) { primaryKey = key; resolve(key); }
      else reject(new Error(`key resolver failed: ${err ? err.message : 'empty values'}`));
    });
    child.stdin.end(input);
  });
}

function loadFallbackKey(config, log) {
  fallbackKey = null;
  if (config.providers.fallback.enabled === false) {
    log('fallback provider disabled by configuration');
    return;
  }
  const file = config.providers.fallback.keyFile;
  if (!file) { log('fallback provider disabled: no key file configured'); return; }
  try {
    const stat = fs.statSync(file);
    if (stat.uid !== 0 || (stat.mode & 0o077)) throw new Error('unsafe fallback key permissions');
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key.length > 8 && !/\s/.test(key)) {
      fallbackKey = key;
      log('fallback provider key loaded into memory');
    } else {
      log('WARN: fallback provider key file has an invalid format');
    }
  } catch (e) { log(`WARN: cannot load fallback provider key: ${sanitizeError(e.message)}`); }
}

// --- proxy transport ----------------------------------------------------------
function hostInNoProxy(config, host) {
  return config.noProxy.some((p) => p && (host === p || (p.startsWith('.') && host.endsWith(p))));
}

// open a TLS socket to target, via HTTP CONNECT proxy when configured
function connectSocket(config, url, cb) {
  let called = false;
  const once = (err, sock) => { if (!called) { called = true; cb(err, sock); } };
  const direct = () => {
    const s = tls.connect({ host: url.hostname, port: 443, servername: url.hostname }, () => once(null, s));
    s.once('error', (e) => once(e));
  };
  if (!config.httpsProxy || hostInNoProxy(config, url.hostname)) return direct();
  let pu;
  try { pu = new URL(config.httpsProxy); } catch { return direct(); }
  const sock = net.connect(parseInt(pu.port || '8080', 10), pu.hostname, () => {
    sock.write(`CONNECT ${url.hostname}:443 HTTP/1.1\r\nHost: ${url.hostname}:443\r\n\r\n`);
  });
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 8192) { sock.destroy(); cb(new Error('proxy CONNECT response too large')); }
      return;
    }
    sock.removeListener('data', onData);
    const statusLine = buf.slice(0, buf.indexOf('\r\n'));
    if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
      sock.destroy();
      return once(new Error(`proxy CONNECT failed: ${statusLine}`));
    }
    const tlsSock = tls.connect({ socket: sock, servername: url.hostname }, () => once(null, tlsSock));
    tlsSock.once('error', (e) => once(e));
  };
  sock.on('data', onData);
  sock.once('error', (e) => once(e));
}

// one streaming provider pass. Content streams live via opts.onDelta through
// ToolCallTextFilter, so tokens reach the browser incrementally while raw
// <tool_call> markup is held back; the accumulated raw reply is still returned
// for the agent loop's own tool-call parsing.
class ProviderError extends Error {
  constructor(message, status, retriable) { super(message); this.status = status; this.retriable = retriable; }
}

function providerModelId(provider, requestedModelId) {
  return provider && provider.modelId ? provider.modelId : requestedModelId;
}

function shouldRetryPrimary(status) {
  return status === 429 || status === 502 || status === 504;
}

function assertStreamCompleted(sawDone, finishReason, gotDelta = false) {
  if (!sawDone && !finishReason) {
    throw new ProviderError('provider stream ended without a completion marker', 502, !gotDelta);
  }
}

function applyToolCallDelta(toolFragments, pieces) {
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    const index = Number.isSafeInteger(piece.index) ? piece.index : toolFragments.size;
    const current = toolFragments.get(index) || { index, id: '', type: 'function', name: '', arguments: '' };
    if (typeof piece.id === 'string') current.id += piece.id;
    if (typeof piece.type === 'string') current.type = piece.type;
    const fn = piece.function && typeof piece.function === 'object' ? piece.function : {};
    if (typeof fn.name === 'string') current.name += fn.name;
    if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
    toolFragments.set(index, current);
  }
}

function materializeToolCalls(toolFragments) {
  return [...toolFragments.values()]
    .sort((left, right) => left.index - right.index)
    .map((call, index) => ({
      id: call.id || `call-${index + 1}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }));
}

// Incremental filter for live token streaming: emits user-visible text chunks
// as they arrive while holding back <tool_call> markup (qwen habit of narrating
// calls as prose). Complete blocks never reach the browser; flush() DROPS any
// unterminated tail block rather than leaking partial markup. Native tool_calls
// deltas travel in a separate field and never enter this path.
const TOOL_TAG_OPEN = '<tool_call>';
const TOOL_TAG_CLOSE = '</tool_call>';

class ToolCallTextFilter {
  constructor() {
    this.pending = '';   // possible partial tag at end of current plain text
    this.block = null;   // accumulating inside a <tool_call> block
  }
  push(text) {
    let s = this.pending + String(text);
    this.pending = '';
    let emit = '';
    const holdPartial = (tag) => {
      let hold = 0;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(s.length - k))) { hold = k; break; }
      }
      this.pending = s.slice(s.length - hold);
      return s.slice(0, s.length - hold);
    };
    while (s.length) {
      if (this.block === null) {
        const i = s.indexOf(TOOL_TAG_OPEN);
        if (i < 0) {
          emit += holdPartial(TOOL_TAG_OPEN);
          s = '';
        } else {
          emit += s.slice(0, i);
          s = s.slice(i + TOOL_TAG_OPEN.length);
          this.block = '';
        }
      } else {
        const j = s.indexOf(TOOL_TAG_CLOSE);
        if (j < 0) {
          this.block += holdPartial(TOOL_TAG_CLOSE);
          s = '';
        } else {
          this.block = null; // complete block: dropped entirely
          s = s.slice(j + TOOL_TAG_CLOSE.length);
        }
      }
    }
    return emit;
  }
  flush() {
    // Stream ended: release held plain text; DROP any unterminated markup tail.
    const emit = this.block === null ? this.pending : '';
    this.pending = '';
    this.block = null;
    return emit;
  }
}

function chatAttempt(config, provider, apiKey, modelId, messages, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions');
    const requestBody = {
      model: modelId,
      messages,
      stream: true,
      max_tokens: config.maxOutputTokens,
      stream_options: { include_usage: true },
    };
    if (Array.isArray(opts.tools) && opts.tools.length) {
      requestBody.tools = opts.tools;
      requestBody.tool_choice = 'auto';
    }
    const body = JSON.stringify(requestBody);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };

    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const done = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };

    let reply = '';
    let usage = null;
    let gotDelta = false;
    let finishReason = null;
    let sawDone = false;
    const toolFragments = new Map();
    const deltaFilter = typeof opts.onDelta === 'function' ? new ToolCallTextFilter() : null;
    let req = null;
    let activeSocket = null;
    let res = null;
    let lineBuf = '';

    const connectTimer = setTimeout(() => {
      if (req) req.destroy();
      if (activeSocket) activeSocket.destroy();
      fail(new ProviderError('connect timed out', 504, true));
    }, config.connectTimeoutMs);

    let stallTimer = null;
    let firstByteTimer = null;
    const armFirstByte = () => {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      const timeoutMs = Number(config.firstByteTimeoutMs) > 0
        ? Number(config.firstByteTimeoutMs)
        : Math.max(Number(config.stallTimeoutMs) || 60000, 60000);
      firstByteTimer = setTimeout(() => {
        if (req) req.destroy();
        if (activeSocket) activeSocket.destroy();
        fail(new ProviderError('provider timed out before response headers', 504, true));
      }, timeoutMs);
    };
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (req) req.destroy();
        fail(new ProviderError(gotDelta ? 'stream stall mid-response' : 'stream stall before first token', 504, !gotDelta));
      }, config.stallTimeoutMs);
    };
    const cleanup = () => {
      clearTimeout(connectTimer);
      if (firstByteTimer) clearTimeout(firstByteTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (req) req.destroy();
      if (activeSocket) activeSocket.destroy();
      fail(new ProviderError('aborted', 499, false));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return fail(new ProviderError('aborted', 499, false));
      opts.signal.addEventListener('abort', onAbort);
    }

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j.usage) usage = j.usage;
      const choice = j.choices && j.choices[0];
      const delta = choice && choice.delta;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const text = delta && typeof delta.content === 'string' ? delta.content : '';
      if (text) {
        gotDelta = true;
        reply += text;
        if (deltaFilter) {
          const visible = deltaFilter.push(text);
          if (visible) opts.onDelta(visible);
        }
        if (opts.onOutput) opts.onOutput('content');
      }
      const pieces = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      if (pieces.length) {
        applyToolCallDelta(toolFragments, pieces);
        gotDelta = true;
        if (opts.onOutput) opts.onOutput('tool_call');
      }
    };

    connectSocket(config, url, (err, socket) => {
      activeSocket = socket || null;
      if (settled) {
        if (socket) socket.destroy();
        return;
      }
      if (err) return fail(new ProviderError(`connect failed: ${err.message}`, 502, true));
      // NB: pass createConnection at request level with NO agent option —
      // https.Agent ignores createConnection; agent:false also ignores it.
      // Proxy/TLS is established. Provider prefill for a large context is
      // not a connection failure and therefore uses its own longer timer.
      clearTimeout(connectTimer);
      req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers,
        createConnection: () => socket,
      });
      req.on('error', (e) => {
        if (!settled) fail(new ProviderError(`request error: ${e.message}`, 502, !gotDelta));
      });
      req.on('response', (r) => {
        res = r;
        if (firstByteTimer) {
          clearTimeout(firstByteTimer);
          firstByteTimer = null;
        }
        if (r.statusCode !== 200) {
          let errBody = '';
          r.on('data', (c) => { if (errBody.length < 2048) errBody += c.toString('utf8'); });
          r.on('end', () => {
            const retriable = r.statusCode === 401 || r.statusCode === 403 || r.statusCode === 429 || r.statusCode >= 500;
            fail(new ProviderError(`provider HTTP ${r.statusCode}: ${errBody.slice(0, 300)}`, r.statusCode, retriable));
          });
          return;
        }
        armStall();
        r.on('data', (chunk) => {
          armStall();
          lineBuf += chunk.toString('utf8');
          let idx;
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx).replace(/\r$/, '');
            lineBuf = lineBuf.slice(idx + 1);
            handleLine(line);
          }
        });
        r.on('end', () => {
          if (lineBuf.trim()) handleLine(lineBuf.replace(/\r$/, ''));
          try {
            assertStreamCompleted(sawDone, finishReason, gotDelta);
          } catch (error) {
            fail(error);
            return;
          }
          if (deltaFilter) {
            const tail = deltaFilter.flush();
            if (tail) opts.onDelta(tail);
          }
          const toolCalls = materializeToolCalls(toolFragments);
          done({ reply, usage, toolCalls, finishReason });
        });
        r.on('error', (e) => fail(new ProviderError(`stream error: ${e.message}`, 502, !gotDelta)));
      });
      armFirstByte();
      req.end(body);
    });
  });
}

// full turn with token-plan primary (+ one key refresh on 401) then free-pool fallback
async function runChat(config, modelId, messages, opts) {
  const attempts = [];
  let lastErr = null;
  try {
    const key = await resolvePrimaryKey(config, false);
    attempts.push({ provider: config.providers.primary, key });
    attempts.push({ provider: config.providers.primary, key: null, refresh: true }); // on 401 only
    attempts.push({ provider: config.providers.primary, key: null, retry: true }); // transient pre-output retry
  } catch (error) {
    lastErr = new ProviderError(error.message, 502, true);
    if (opts.onProviderError) opts.onProviderError(config.providers.primary.name, 502, sanitizeError(error.message));
  }
  if (fallbackKey) attempts.push({ provider: config.providers.fallback, key: fallbackKey });

  let sawOutput = false;
  for (const attempt of attempts) {
    if (attempt.refresh && !(lastErr && lastErr.status === 401)) continue; // refresh retry only after 401
    if (attempt.retry && !(lastErr && shouldRetryPrimary(lastErr.status))) continue;
    if (attempt.refresh) {
      try { attempt.key = await resolvePrimaryKey(config, true); }
      catch (e) { lastErr = new ProviderError(e.message, 502, true); continue; }
    } else if (attempt.retry) {
      try { attempt.key = await resolvePrimaryKey(config, false); }
      catch (e) { lastErr = new ProviderError(e.message, 502, true); continue; }
    }
    if (!attempt.key) continue;
    try {
      const out = await chatAttempt(config, attempt.provider, attempt.key, providerModelId(attempt.provider, modelId), messages, {
        ...opts,
        onOutput: (kind) => { sawOutput = true; if (opts.onOutput) opts.onOutput(kind); },
      });
      out.provider = attempt.provider.name;
      return out;
    } catch (e) {
      lastErr = e instanceof ProviderError ? e : new ProviderError(e.message, 502, true);
      if (opts.onProviderError && lastErr.status !== 499) {
        opts.onProviderError(attempt.provider.name, lastErr.status, sanitizeError(lastErr.message));
      }
      const canFailover = !sawOutput && lastErr.retriable && lastErr.status !== 499;
      if (!canFailover) break;
    }
  }
  const err = lastErr || new ProviderError('no provider available', 502, false);
  err.message = sanitizeError(err.message);
  throw err;
}

module.exports = {
  ProviderError,
  ToolCallTextFilter,
  applyToolCallDelta,
  assertStreamCompleted,
  chatAttempt,
  loadFallbackKey,
  materializeToolCalls,
  providerModelId,
  runChat,
  shouldRetryPrimary,
};