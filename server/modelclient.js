// Warm in-process OpenAI-compatible model client with native function calling.
// MeshDirect owns the loop; no OpenClaw process or protocol is involved.
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const https = require('https');
const { execFile } = require('child_process');
const { sanitizeError } = require('./util');

let primaryKey = null;
let fallbackKey = null;

function resolvePrimaryKey(config, force) {
  if (primaryKey && !force) return Promise.resolve(primaryKey);
  const providerId = config.providers.primary.resolverProvider || 'meshdirect-vault';
  const input = JSON.stringify({ protocolVersion: 1, provider: providerId, ids: [config.providers.primary.resolverId] });
  return new Promise((resolve, reject) => {
    const child = execFile(config.providers.primary.resolverPath, [], {
      timeout: 15000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    }, (err, stdout) => {
      let out = null;
      try { out = JSON.parse(stdout || '{}'); } catch { /* handled below */ }
      const key = out && out.values && out.values[config.providers.primary.resolverId];
      if (typeof key === 'string' && key.length > 8) {
        primaryKey = key;
        resolve(key);
      } else {
        reject(new Error(`key resolver failed: ${err ? err.message : 'empty values'}`));
      }
    });
    child.on('error', reject);
    child.stdin.end(input);
  });
}

function loadFallbackKey(config, log) {
  fallbackKey = null;
  const file = config.providers.fallback.keyFile;
  if (!file) { log('fallback provider disabled: no key file configured'); return; }
  try {
    const st = fs.statSync(file);
    if (st.uid !== 0 || (st.mode & 0o077)) throw new Error('unsafe fallback key permissions');
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key.length > 8 && !/\s/.test(key)) {
      fallbackKey = key;
      log('fallback provider key loaded into memory');
    } else {
      log('WARN: fallback provider key file has an invalid format');
    }
  } catch (e) {
    log(`WARN: cannot load fallback provider key: ${sanitizeError(e.message)}`);
  }
}

function hostInNoProxy(config, host) {
  return config.noProxy.some((entry) => {
    const p = String(entry || '').trim();
    return p && (host === p || (p.startsWith('.') && host.endsWith(p)));
  });
}

function connectSocket(config, url, cb) {
  let called = false;
  const once = (err, sock) => { if (!called) { called = true; cb(err, sock); } };
  const direct = () => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname }, () => once(null, socket));
    socket.once('error', (e) => once(e));
  };
  if (!config.httpsProxy || hostInNoProxy(config, url.hostname)) return direct();

  let proxy;
  try { proxy = new URL(config.httpsProxy); }
  catch { return direct(); }
  const socket = net.connect(Number(proxy.port || 8080), proxy.hostname, () => {
    socket.write(`CONNECT ${url.hostname}:${url.port || 443} HTTP/1.1\r\nHost: ${url.hostname}:${url.port || 443}\r\nConnection: keep-alive\r\n\r\n`);
  });
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('latin1');
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buffer.length > 8192) { socket.destroy(); once(new Error('proxy CONNECT response too large')); }
      return;
    }
    socket.removeListener('data', onData);
    const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
    if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
      socket.destroy();
      once(new Error(`proxy CONNECT failed: ${statusLine}`));
      return;
    }
    const tlsSocket = tls.connect({ socket, servername: url.hostname }, () => once(null, tlsSocket));
    tlsSocket.once('error', (e) => once(e));
  };
  socket.on('data', onData);
  socket.once('error', (e) => once(e));
}

class ProviderError extends Error {
  constructor(message, status, retriable) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retriable = retriable;
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function normalizeToolAccumulator(accumulator) {
  return Array.from(accumulator.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, call], index) => ({
      id: call.id || `call_meshdirect_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: call.function.name || '',
        arguments: call.function.arguments || '{}',
      },
    }))
    .filter((call) => call.function.name);
}

function chatAttempt(config, provider, apiKey, modelId, messages, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions');
    const payload = {
      model: modelId,
      messages,
      stream: true,
      max_tokens: config.maxOutputTokens,
      stream_options: { include_usage: true },
    };
    if (Array.isArray(opts.tools) && opts.tools.length) {
      payload.tools = opts.tools;
      payload.tool_choice = 'auto';
      payload.parallel_tool_calls = true;
    }
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'MeshDirect/2.0',
    };

    let settled = false;
    let request = null;
    let lineBuffer = '';
    let reply = '';
    let usage = null;
    let finishReason = null;
    let gotOutput = false;
    let reasoningChars = 0;
    const toolAccumulator = new Map();
    let stallTimer = null;

    const cleanup = () => {
      clearTimeout(connectTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        reply,
        usage,
        finishReason,
        toolCalls: normalizeToolAccumulator(toolAccumulator),
        reasoningChars,
      });
    };
    const connectTimer = setTimeout(() => {
      if (request) request.destroy();
      fail(new ProviderError('connect timed out', 504, !gotOutput));
    }, config.connectTimeoutMs);
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (request) request.destroy();
        fail(new ProviderError(gotOutput ? 'stream stalled mid-response' : 'stream stalled before first output', 504, !gotOutput));
      }, config.stallTimeoutMs);
    };
    const onAbort = () => {
      if (request) request.destroy();
      fail(new ProviderError('aborted', 499, false));
    };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleToolDelta = (part) => {
      if (!part || typeof part !== 'object') return;
      const index = Number.isInteger(part.index) ? part.index : 0;
      const current = toolAccumulator.get(index) || { id: '', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string' && part.id) current.id = part.id;
      const fn = part.function || {};
      if (typeof fn.name === 'string') current.function.name += fn.name;
      if (typeof fn.arguments === 'string') current.function.arguments += fn.arguments;
      toolAccumulator.set(index, current);
      gotOutput = true;
      if (opts.onToolDelta) opts.onToolDelta(index, current);
    };

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      if (event.usage) usage = event.usage;
      const choice = event.choices && event.choices[0];
      if (!choice) return;
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      const text = contentText(delta.content);
      if (text) {
        gotOutput = true;
        reply += text;
        if (opts.onDelta) opts.onDelta(text);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        gotOutput = true;
        reasoningChars += delta.reasoning_content.length;
        if (opts.onReasoning) opts.onReasoning(delta.reasoning_content.length);
      }
      if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach(handleToolDelta);
      // Some compatible endpoints return a complete tool call under message even in a stream.
      const complete = choice.message && choice.message.tool_calls;
      if (Array.isArray(complete)) complete.forEach(handleToolDelta);
    };

    connectSocket(config, url, (socketError, socket) => {
      if (socketError) {
        fail(new ProviderError(`connect failed: ${socketError.message}`, 502, !gotOutput));
        return;
      }
      request = https.request({
        hostname: url.hostname,
        port: Number(url.port || 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        createConnection: () => socket,
      });
      request.on('error', (e) => {
        fail(new ProviderError(`request error: ${e.message}`, 502, !gotOutput));
      });
      request.on('response', (response) => {
        clearTimeout(connectTimer);
        if (response.statusCode !== 200) {
          let errorBody = '';
          response.on('data', (chunk) => { if (errorBody.length < 4096) errorBody += chunk.toString('utf8'); });
          response.on('end', () => {
            const status = response.statusCode || 502;
            const retriable = [401, 403, 408, 409, 425, 429].includes(status) || status >= 500;
            fail(new ProviderError(`provider HTTP ${status}: ${errorBody.slice(0, 500)}`, status, retriable));
          });
          return;
        }
        armStall();
        response.on('data', (chunk) => {
          armStall();
          lineBuffer += chunk.toString('utf8');
          let index;
          while ((index = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, index).replace(/\r$/, '');
            lineBuffer = lineBuffer.slice(index + 1);
            handleLine(line);
          }
        });
        response.on('end', () => {
          if (lineBuffer.trim()) handleLine(lineBuffer.replace(/\r$/, ''));
          done();
        });
        response.on('error', (e) => {
          fail(new ProviderError(`stream error: ${e.message}`, 502, !gotOutput));
        });
      });
      request.end(body);
    });
  });
}

async function runChat(config, modelId, messages, opts = {}) {
  const attempts = [];
  let lastError = null;
  try {
    const key = await resolvePrimaryKey(config, false);
    attempts.push({ provider: config.providers.primary, key, kind: 'primary' });
    attempts.push({ provider: config.providers.primary, key: null, refresh: true, kind: 'primary-refresh' });
  } catch (e) {
    lastError = new ProviderError(e.message, 502, true);
    if (opts.onProviderError) opts.onProviderError(config.providers.primary.name, 502, sanitizeError(e.message));
  }
  if (fallbackKey) attempts.push({ provider: config.providers.fallback, key: fallbackKey, kind: 'fallback' });

  let sawModelOutput = false;
  for (const attempt of attempts) {
    if (attempt.refresh && !(lastError && lastError.status === 401)) continue;
    if (attempt.refresh) {
      try { attempt.key = await resolvePrimaryKey(config, true); }
      catch (e) {
        lastError = new ProviderError(e.message, 502, true);
        if (opts.onProviderError) opts.onProviderError(attempt.provider.name, 502, sanitizeError(e.message));
        continue;
      }
    }
    if (!attempt.key) continue;
    try {
      const output = await chatAttempt(config, attempt.provider, attempt.key, modelId, messages, {
        ...opts,
        onDelta: (text) => {
          sawModelOutput = true;
          if (opts.onDelta) opts.onDelta(text);
        },
        onToolDelta: (index, call) => {
          sawModelOutput = true;
          if (opts.onToolDelta) opts.onToolDelta(index, call);
        },
        onReasoning: (count) => {
          sawModelOutput = true;
          if (opts.onReasoning) opts.onReasoning(count);
        },
      });
      output.provider = attempt.provider.name;
      return output;
    } catch (e) {
      lastError = e instanceof ProviderError ? e : new ProviderError(e.message, 502, true);
      if (opts.onProviderError && lastError.status !== 499) {
        opts.onProviderError(attempt.provider.name, lastError.status, sanitizeError(lastError.message));
      }
      const mayFailover = !sawModelOutput && lastError.retriable && lastError.status !== 499;
      if (!mayFailover) break;
    }
  }
  const error = lastError || new ProviderError('no provider available', 502, false);
  error.message = sanitizeError(error.message);
  throw error;
}

module.exports = {
  runChat,
  loadFallbackKey,
  ProviderError,
  normalizeToolAccumulator,
  contentText,
};
