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
  const input = JSON.stringify({ protocolVersion: 1, provider: 'sg1vault', ids: [config.providers.primary.resolverId] });
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
  try {
    const raw = JSON.parse(fs.readFileSync(config.providers.fallback.openclawConfig, 'utf8'));
    const key = raw && raw.models && raw.models.providers &&
      raw.models.providers.alibaba_free_ws && raw.models.providers.alibaba_free_ws.apiKey;
    if (typeof key === 'string' && key.length > 8) { fallbackKey = key; log('fallback free-pool key loaded into memory'); }
    else log('WARN: fallback free-pool key not found in openclaw.json');
  } catch (e) { log(`WARN: cannot read fallback key: ${e.message}`); }
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

// one streaming chat attempt. resolves {reply, usage} or throws ProviderError
class ProviderError extends Error {
  constructor(message, status, retriable) { super(message); this.status = status; this.retriable = retriable; }
}

function chatAttempt(config, provider, apiKey, modelId, messages, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions');
    const body = JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      max_tokens: config.maxOutputTokens,
      stream_options: { include_usage: true },
    });
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
    let req = null;
    let res = null;
    let lineBuf = '';

    const connectTimer = setTimeout(() => {
      if (req) req.destroy();
      fail(new ProviderError('connect timed out', 504, true));
    }, config.connectTimeoutMs);

    let stallTimer = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (req) req.destroy();
        fail(new ProviderError(gotDelta ? 'stream stall mid-response' : 'stream stall before first token', 504, !gotDelta));
      }, config.stallTimeoutMs);
    };
    const cleanup = () => {
      clearTimeout(connectTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (req) req.destroy();
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
      if (payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j.usage) usage = j.usage;
      const choice = j.choices && j.choices[0];
      const delta = choice && choice.delta;
      const text = delta && typeof delta.content === 'string' ? delta.content : '';
      if (text) {
        gotDelta = true;
        reply += text;
        opts.onDelta(text);
      }
    };

    connectSocket(config, url, (err, socket) => {
      if (err) return fail(new ProviderError(`connect failed: ${err.message}`, 502, true));
      // NB: pass createConnection at request level with NO agent option —
      // https.Agent ignores createConnection; agent:false also ignores it.
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
        clearTimeout(connectTimer);
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
          done({ reply, usage });
        });
        r.on('error', (e) => fail(new ProviderError(`stream error: ${e.message}`, 502, !gotDelta)));
      });
      req.end(body);
    });
  });
}

// full turn with token-plan primary (+ one key refresh on 401) then free-pool fallback
async function runChat(config, modelId, messages, opts) {
  const attempts = [];
  let key = await resolvePrimaryKey(config, false);
  attempts.push({ provider: config.providers.primary, key });
  attempts.push({ provider: config.providers.primary, key: null, refresh: true }); // on 401 only
  if (fallbackKey) attempts.push({ provider: config.providers.fallback, key: fallbackKey });

  let lastErr = null;
  let sawDelta = false;
  for (const attempt of attempts) {
    if (attempt.refresh && !(lastErr && lastErr.status === 401)) continue; // refresh retry only after 401
    if (attempt.refresh) {
      try { attempt.key = await resolvePrimaryKey(config, true); }
      catch (e) { lastErr = new ProviderError(e.message, 502, true); continue; }
    }
    if (!attempt.key) continue;
    try {
      const out = await chatAttempt(config, attempt.provider, attempt.key, modelId, messages, {
        ...opts,
        onDelta: (t) => { sawDelta = true; opts.onDelta(t); },
      });
      out.provider = attempt.provider.name;
      return out;
    } catch (e) {
      lastErr = e instanceof ProviderError ? e : new ProviderError(e.message, 502, true);
      if (opts.onProviderError && lastErr.status !== 499) {
        opts.onProviderError(attempt.provider.name, lastErr.status, sanitizeError(lastErr.message));
      }
      const canFailover = !sawDelta && lastErr.retriable && lastErr.status !== 499;
      if (!canFailover) break;
    }
  }
  const err = lastErr || new ProviderError('no provider available', 502, false);
  err.message = sanitizeError(err.message);
  throw err;
}

module.exports = { runChat, loadFallbackKey, ProviderError };
