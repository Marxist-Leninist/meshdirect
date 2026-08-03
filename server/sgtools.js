'use strict';

const http = require('http');
const https = require('https');

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SERVER_NAMES = new Set(['sg1', 'sg2']);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 320;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class MCPTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPTransportError';
    this.transport = true;
  }
}

class MCPResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPResponseError';
    this.transport = false;
  }
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
    throw new MCPTransportError('SG MCP returned invalid JSON');
  }
  if (!value || typeof value !== 'object') throw new MCPTransportError('SG MCP returned an invalid response');
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
    return Promise.reject(new MCPTransportError('SG MCP URL must use HTTP or HTTPS'));
  }
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
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      if (request) request.destroy();
      finish(new MCPTransportError('SG MCP call aborted'));
    };
    const timer = setTimeout(() => {
      if (request) request.destroy();
      finish(new MCPTransportError('SG MCP call timed out'));
    }, boundedInteger(timeoutMs, 150_000, 1_000, 450_000));

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
      let raw = '';
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(new MCPTransportError('SG MCP response exceeded 8 MB'));
          return;
        }
        raw += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new MCPTransportError(`SG MCP HTTP ${response.statusCode}`));
          return;
        }
        try {
          finish(null, parseMcpResponse(raw, response.headers['content-type']));
        } catch (error) {
          finish(error);
        }
      });
      response.on('error', (error) => finish(new MCPTransportError(`SG MCP stream failed: ${error.message}`)));
    });
    request.on('error', (error) => finish(new MCPTransportError(`SG MCP request failed: ${error.message}`)));
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
      description: `Use the live ${name.toUpperCase()} MCP tool server. action='search' discovers tools by name/description; action='call' invokes one discovered tool with its JSON arguments.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'call'] },
          query: { type: 'string', description: 'Search text for action=search.' },
          name: { type: 'string', description: 'Exact MCP tool name for action=call.' },
          arguments: { type: 'object', additionalProperties: true },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          timeout: { type: 'integer', minimum: 1, maximum: 450, description: 'Call timeout in seconds.' },
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
    if (!value || typeof value.url !== 'string') throw new MCPTransportError(`${name.toUpperCase()} is not configured`);
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
    };
  }

  async execute(toolName, rawArgs, options = {}) {
    if (!SERVER_NAMES.has(toolName)) throw new MCPResponseError('Unknown SG server');
    const args = requireArgumentsObject(rawArgs, 'SG request arguments');
    if (args.action === 'search') return this.search(toolName, args, options);
    if (args.action === 'call') return this.call(toolName, args, options);
    throw new MCPResponseError("SG action must be exactly 'search' or 'call'");
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
};
