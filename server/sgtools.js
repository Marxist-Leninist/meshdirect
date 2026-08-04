'use strict';

const http = require('http');
const https = require('https');
const { sanitizeError } = require('./util');

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SERVER_NAMES = new Set(['sg1', 'sg2']);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 320;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const STATUS_PROBE_TIMEOUT_MS = 8_000;

class MCPTransportError extends Error {
  constructor(message, kind = 'transport') {
    super(message);
    this.name = 'MCPTransportError';
    this.transport = true;
    this.kind = kind;
  }
}

class MCPResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPResponseError';
    this.transport = false;
    this.kind = 'tool';
  }
}

// Actionable guidance for each failure class so the agent can decide whether
// an immediate retry, a longer timeout, or operator intervention is needed.
const RETRY_HINTS = {
  'connect-refused': 'Endpoint refused the connection: the SG service is down or firewalled. Verify the service before retrying.',
  'connect-timeout': 'Endpoint was unreachable (connect timeout). The host may be down or the route blocked; retrying immediately is unlikely to help.',
  'connect-failed': 'Connection failed before any response. A retry after a short pause may succeed if this was transient.',
  dns: 'DNS resolution failed for the SG endpoint. Check the resolver before retrying.',
  reset: 'The connection was reset by the endpoint. Wait a few seconds before retrying.',
  timeout: 'The call exceeded its timeout while the endpoint stayed silent. Retry with a larger timeout value, or probe with action=status.',
  'midstream-close': 'The endpoint dropped the connection mid-response (its handler may have crashed). Wait before retrying; a shorter or simpler call may survive.',
  'empty-response': 'The endpoint returned an empty response body. It may be starting up or overloaded; retry shortly.',
  'http-error': 'The endpoint answered with an HTTP error status. Retrying the identical call is unlikely to help.',
  'invalid-response': 'The endpoint answered, but the payload was not valid MCP JSON-RPC. Likely a version mismatch or a truncated response.',
  oversize: 'The response exceeded the 8 MB safety cap. Narrow the call so less data is returned.',
  aborted: 'The call was aborted by the harness (turn stopped or steered).',
};

function retryHint(kind) {
  return RETRY_HINTS[kind] || 'Transport-level failure; a retry after a short pause often succeeds.';
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function parseEventStream(raw) {
  const frames = [];
  let data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      if (data.length) frames.push(data.join('\n'));
      data = [];
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length) frames.push(data.join('\n'));
  return frames.at(-1) || '{}';
}

function parseMcpResponse(raw, contentType) {
  const payload = String(contentType || '').includes('text/event-stream')
    ? parseEventStream(raw)
    : raw;
  let value;
  try {
    value = JSON.parse(payload || '{}');
  } catch {
    throw new MCPTransportError('SG MCP returned invalid JSON', 'invalid-response');
  }
  if (!value || typeof value !== 'object') throw new MCPTransportError('SG MCP returned an invalid response', 'invalid-response');
  if (value.error) {
    const message = typeof value.error.message === 'string'
      ? value.error.message
      : JSON.stringify(value.error).slice(0, 2_000);
    throw new MCPResponseError(message || 'SG MCP rejected the request');
  }
  return value.result || {};
}

function requestJsonRpc(urlString, method, params, { timeoutMs, signal } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new MCPTransportError('SG MCP URL must use HTTP or HTTPS', 'invalid-response'));
  }
  const startedAt = Date.now();
  const timeoutValue = boundedInteger(timeoutMs, 150_000, 1_000, 450_000);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: `meshdirect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method,
    params: params || {},
  });
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let responseStarted = false;
    let bytesReceived = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) {
        if (error.elapsedMs === undefined) error.elapsedMs = Date.now() - startedAt;
        reject(error);
      } else resolve(result);
    };
    const onAbort = () => {
      if (request) request.destroy();
      finish(new MCPTransportError('SG MCP call aborted', 'aborted'));
    };
    const timer = setTimeout(() => {
      if (request) request.destroy();
      if (responseStarted) {
        finish(new MCPTransportError(
          `SG MCP call timed out after ${Math.round(timeoutValue / 1000)}s mid-response (${bytesReceived} bytes received). ${retryHint('midstream-close')}`,
          'midstream-close',
        ));
      } else {
        finish(new MCPTransportError(
          `SG MCP call timed out after ${Math.round(timeoutValue / 1000)}s with no response. ${retryHint('timeout')}`,
          'timeout',
        ));
      }
    }, timeoutValue);

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      responseStarted = true;
      let raw = '';
      response.on('data', (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(new MCPTransportError(`SG MCP response exceeded 8 MB. ${retryHint('oversize')}`, 'oversize'));
          return;
        }
        raw += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new MCPTransportError(`SG MCP endpoint returned HTTP ${response.statusCode}. ${retryHint('http-error')}`, 'http-error'));
          return;
        }
        if (!raw.trim()) {
          finish(new MCPTransportError(`SG MCP endpoint returned an empty response body. ${retryHint('empty-response')}`, 'empty-response'));
          return;
        }
        try {
          finish(null, parseMcpResponse(raw, response.headers['content-type']));
        } catch (error) {
          finish(error);
        }
      });
      response.on('error', (error) => finish(new MCPTransportError(`SG MCP stream failed mid-response after ${bytesReceived} bytes: ${error.message}. ${retryHint('midstream-close')}`, 'midstream-close')));
    });
    request.on('error', (error) => {
      const code = error && error.code;
      if (responseStarted) {
        finish(new MCPTransportError(`SG MCP stream failed mid-response: ${error.message}. ${retryHint('midstream-close')}`, 'midstream-close'));
      } else if (code === 'ECONNREFUSED') {
        finish(new MCPTransportError(`SG MCP endpoint refused the connection (${code}). ${retryHint('connect-refused')}`, 'connect-refused'));
      } else if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        finish(new MCPTransportError(`SG MCP endpoint unreachable (${code}). ${retryHint('connect-timeout')}`, 'connect-timeout'));
      } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        finish(new MCPTransportError(`DNS lookup failed for SG MCP endpoint (${code}). ${retryHint('dns')}`, 'dns'));
      } else if (code === 'ECONNRESET') {
        finish(new MCPTransportError(`Connection reset by SG MCP endpoint (${code}). ${retryHint('reset')}`, 'reset'));
      } else {
        finish(new MCPTransportError(`SG MCP request failed: ${error.message}${code ? ` (${code})` : ''}. ${retryHint('connect-failed')}`, 'connect-failed'));
      }
    });
    request.end(body);
  });
}

function toolResultText(result) {
  if (result && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  const blocks = result && Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text || JSON.stringify(result || {});
}

function normalizeArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* handled below */ }
  }
  return null;
}

function requireArgumentsObject(value, label, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return {};
  const parsed = normalizeArguments(value);
  if (!parsed) throw new MCPResponseError(`${label} must be a valid JSON object`);
  return parsed;
}

const MODEL_TOOLS = [
  ...['sg1', 'sg2'].map((name) => ({
    type: 'function',
    function: {
      name,
      description: `Use the live ${name.toUpperCase()} MCP tool server. action='search' discovers tools by name/description; action='call' invokes one discovered tool with its JSON arguments; action='status' probes reachability (tool count and latency) without executing anything.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'call', 'status'], description: "'search' to discover tools, 'call' to run one, 'status' for a safe reachability probe." },
          query: { type: 'string', description: 'Search text for action=search.' },
          name: { type: 'string', description: 'Exact MCP tool name for action=call.' },
          arguments: { type: 'object', additionalProperties: true },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          timeout: { type: 'integer', minimum: 1, maximum: 450, description: 'Per-call timeout in seconds. Default 150, max 450. Transport failures are classified with an errorKind and a retry hint; results include elapsedMs.' },
        },
        required: ['action'],
      },
    },
  })),
];

class SGToolGateway {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.cache = new Map();
  }

  _server(name) {
    if (!SERVER_NAMES.has(name)) throw new MCPResponseError('Unknown SG server');
    const value = this.config.sgServers && this.config.sgServers[name];
    if (!value || typeof value.url !== 'string') throw new MCPTransportError(`${name.toUpperCase()} is not configured`, 'connect-failed');
    return value;
  }

  async _catalog(serverName, options = {}) {
    const cached = this.cache.get(serverName);
    const now = Date.now();
    if (!options.refresh && cached && now - cached.at < this.config.sgCatalogTtlMs) return cached.tools;
    const server = this._server(serverName);
    const result = await requestJsonRpc(server.url, 'tools/list', {}, {
      timeoutMs: options.timeoutMs || this.config.sgCallTimeoutMs,
      signal: options.signal,
    });
    const tools = Array.isArray(result.tools) ? result.tools.filter((tool) => (
      tool && typeof tool.name === 'string' && TOOL_NAME_RE.test(tool.name)
    )) : [];
    this.cache.set(serverName, { at: now, tools });
    return tools;
  }

  async search(serverName, args = {}, options = {}) {
    const startedAt = Date.now();
    const tools = await this._catalog(serverName, options);
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const matched = query ? tools.filter((tool) => (
      tool.name.toLowerCase().includes(query)
      || String(tool.description || '').toLowerCase().includes(query)
    )) : tools;
    return {
      server: serverName,
      matched: matched.length,
      elapsedMs: Date.now() - startedAt,
      tools: matched.slice(0, limit).map((tool) => ({
        name: tool.name,
        description: String(tool.description || '').slice(0, 500),
        inputSchema: tool.inputSchema || { type: 'object' },
      })),
    };
  }

  async call(serverName, args = {}, options = {}) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!TOOL_NAME_RE.test(name)) throw new MCPResponseError('A valid SG MCP tool name is required');
    const toolArguments = requireArgumentsObject(args.arguments, 'SG MCP tool arguments', { allowMissing: true });
    const timeoutSeconds = boundedInteger(args.timeout, Math.ceil(this.config.sgCallTimeoutMs / 1000), 1, 450);
    const server = this._server(serverName);
    const startedAt = Date.now();
    const result = await requestJsonRpc(server.url, 'tools/call', {
      name,
      arguments: toolArguments,
    }, {
      timeoutMs: timeoutSeconds * 1000,
      signal: options.signal,
    });
    if (result && result.isError) {
      throw new MCPResponseError(toolResultText(result).slice(0, this.config.maxToolResultChars));
    }
    return {
      server: serverName,
      tool: name,
      result: toolResultText(result).slice(0, this.config.maxToolResultChars),
      elapsedMs: Date.now() - startedAt,
      timeoutSeconds,
    };
  }

  // Lightweight reachability probe: forces a fresh tools/list round-trip with
  // a short cap so the agent can distinguish 'endpoint down' from 'tool error'
  // without executing anything on the remote host.
  async status(serverName, options = {}) {
    const startedAt = Date.now();
    try {
      const tools = await this._catalog(serverName, {
        refresh: true,
        timeoutMs: STATUS_PROBE_TIMEOUT_MS,
        signal: options.signal,
      });
      return {
        server: serverName,
        reachable: true,
        tools: tools.length,
        latencyMs: Date.now() - startedAt,
        probedAt: new Date().toISOString(),
      };
    } catch (error) {
      const kind = (error && error.kind) || (error && error.transport ? 'transport' : 'tool');
      return {
        server: serverName,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        probedAt: new Date().toISOString(),
        error: sanitizeError(error && error.message),
        errorKind: kind,
        hint: retryHint(kind),
      };
    }
  }

  async execute(toolName, rawArgs, options = {}) {
    if (!SERVER_NAMES.has(toolName)) throw new MCPResponseError('Unknown SG server');
    const args = requireArgumentsObject(rawArgs, 'SG request arguments');
    if (args.action === 'search') return this.search(toolName, args, options);
    if (args.action === 'call') return this.call(toolName, args, options);
    if (args.action === 'status') return this.status(toolName, options);
    throw new MCPResponseError("SG action must be exactly 'search', 'call' or 'status'");
  }
}

module.exports = {
  MODEL_TOOLS,
  MCPResponseError,
  MCPTransportError,
  SGToolGateway,
  normalizeArguments,
  requireArgumentsObject,
  parseMcpResponse,
  requestJsonRpc,
  retryHint,
};
