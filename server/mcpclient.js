'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { MCPResponseError, MCPTransportError } = require('./sgtools');

const LATEST_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const MAX_TOOL_PAGES = 100;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const VISIBLE_ASCII_RE = /^[\x21-\x7e]+$/;
const SAFE_MIRRORED_VALUE_RE = /^[\x20-\x7e]*$/;
const BASE64_SENTINEL_RE = /^=\?base64\?.*\?=$/;
const MODERN_PROTOCOL_ERROR_CODES = new Set([-32020, -32021, -32022]);
const TRANSPORT_ALIASES = new Map([
  ['auto', 'auto'],
  ['latest', 'latest'],
  ['current-http', 'latest'],
  ['session', 'session'],
  ['streamable-http', 'session'],
  ['direct', 'direct'],
  ['stateless', 'direct'],
]);
const SAFE_SECRET_ROOTS = ['/etc/meshdirect-secrets', '/run/secrets'];
const SENSITIVE_LITERAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-auth-token', 'cookie', 'set-cookie',
]);
const BLOCKED_CUSTOM_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  'mcp-session-id',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function text(value, max = 20_000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidToolName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function cleanHeaderName(value) {
  const name = text(value, 200).trim().toLowerCase();
  if (!HEADER_NAME_RE.test(name)) throw new MCPResponseError(`Invalid HTTP header name '${text(value, 80)}'`);
  if (BLOCKED_CUSTOM_HEADERS.has(name) || name.startsWith('mcp-')) {
    throw new MCPResponseError(`Header '${name}' is controlled by the MCP transport and cannot be overridden`);
  }
  return name;
}

function cleanHeaderValue(value, label) {
  const result = text(value, 8192);
  if (!result || /[\r\n\0]/.test(result)) throw new MCPResponseError(`${label} must be a non-empty single-line string`);
  return result;
}

function encodeProtocolHeaderValue(value) {
  const source = String(value);
  const plain = SAFE_MIRRORED_VALUE_RE.test(source)
    && source === source.trim()
    && !BASE64_SENTINEL_RE.test(source);
  return plain
    ? source
    : `=?base64?${Buffer.from(source, 'utf8').toString('base64')}?=`;
}

function normalizeTransport(value) {
  const raw = text(value, 40).trim() || 'auto';
  const normalized = TRANSPORT_ALIASES.get(raw);
  if (!normalized) throw new MCPResponseError(`Unknown MCP transport '${raw}'`);
  return normalized;
}

function safeSecretPath(value, label) {
  const file = text(value, 2048).trim();
  if (!file.startsWith('/') || /[\r\n\0]/.test(file)) {
    throw new MCPResponseError(`${label} must be an absolute file path`);
  }
  let resolved;
  try { resolved = fs.realpathSync(file); } catch {
    // Keep registration validation useful before a secret is mounted, while
    // still collapsing '..' so it cannot syntactically escape the secret root.
    resolved = path.resolve(file);
  }
  const allowed = SAFE_SECRET_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  if (!allowed) throw new MCPResponseError(`${label} must live under /etc/meshdirect-secrets or /run/secrets`);
  return resolved;
}

function normalizeHeaderMap(value, kind) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new MCPResponseError(`${kind} must be an object mapping HTTP header names to strings`);
  }
  const out = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = cleanHeaderName(rawName);
    if (kind === 'header_env') {
      const envName = text(rawValue, 128).trim();
      if (!ENV_NAME_RE.test(envName)) throw new MCPResponseError(`${kind}.${name} must name an environment variable`);
      out[name] = envName;
    } else if (kind === 'header_files') {
      out[name] = safeSecretPath(rawValue, `${kind}.${name}`);
    } else {
      if (SENSITIVE_LITERAL_HEADERS.has(name)) {
        throw new MCPResponseError(`Store sensitive header '${name}' through header_env or header_files, not headers`);
      }
      out[name] = cleanHeaderValue(rawValue, `${kind}.${name}`);
    }
  }
  return out;
}

function normalizeAuthSpec(args = {}) {
  const auth = {
    literal: normalizeHeaderMap(args.headers, 'headers'),
    env: normalizeHeaderMap(args.header_env, 'header_env'),
    files: normalizeHeaderMap(args.header_files, 'header_files'),
    bearerEnv: '',
    bearerFile: '',
  };
  if (args.bearer_token_env !== undefined && args.bearer_token_env !== null && args.bearer_token_env !== '') {
    const envName = text(args.bearer_token_env, 128).trim();
    if (!ENV_NAME_RE.test(envName)) throw new MCPResponseError('bearer_token_env must name an environment variable');
    auth.bearerEnv = envName;
  }
  if (args.bearer_token_file !== undefined && args.bearer_token_file !== null && args.bearer_token_file !== '') {
    auth.bearerFile = safeSecretPath(args.bearer_token_file, 'bearer_token_file');
  }
  const explicitAuthorization = ['literal', 'env', 'files'].some((kind) => auth[kind].authorization);
  if (explicitAuthorization && (auth.bearerEnv || auth.bearerFile)) {
    throw new MCPResponseError('Use either an Authorization header or bearer_token_env/bearer_token_file, not both');
  }
  if (auth.bearerEnv && auth.bearerFile) {
    throw new MCPResponseError('Use either bearer_token_env or bearer_token_file, not both');
  }
  return auth;
}

function authSummary(auth = {}) {
  return {
    literalHeaders: Object.keys(auth.literal || {}),
    environmentHeaders: Object.keys(auth.env || {}),
    fileHeaders: Object.keys(auth.files || {}),
    bearer: auth.bearerEnv ? 'environment' : (auth.bearerFile ? 'file' : null),
  };
}

function readSecretFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    throw new MCPTransportError(`${label} secret file is unavailable`, 'auth');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MCPTransportError(`${label} secret path must be a regular non-symlink file`, 'auth');
  }
  if (stat.size <= 0 || stat.size > MAX_SECRET_FILE_BYTES) {
    throw new MCPTransportError(`${label} secret file has an invalid size`, 'auth');
  }
  let value;
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch {
    throw new MCPTransportError(`${label} secret file could not be read`, 'auth');
  }
  if (!value || /[\r\n\0]/.test(value)) {
    throw new MCPTransportError(`${label} secret must be one non-empty line`, 'auth');
  }
  return value;
}

function resolveAuthHeaders(auth = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(auth.literal || {})) headers[name] = cleanHeaderValue(value, name);
  for (const [name, envName] of Object.entries(auth.env || {})) {
    const value = process.env[envName];
    if (!value) throw new MCPTransportError(`Required MCP header environment variable ${envName} is unset`, 'auth');
    headers[name] = cleanHeaderValue(value, name);
  }
  for (const [name, file] of Object.entries(auth.files || {})) headers[name] = readSecretFile(file, name);
  if (auth.bearerEnv) {
    const token = process.env[auth.bearerEnv];
    if (!token) throw new MCPTransportError(`Required MCP bearer environment variable ${auth.bearerEnv} is unset`, 'auth');
    headers.authorization = `Bearer ${cleanHeaderValue(token, 'bearer token')}`;
  } else if (auth.bearerFile) {
    headers.authorization = `Bearer ${readSecretFile(auth.bearerFile, 'bearer token')}`;
  }
  return headers;
}

function transportError(message, kind, statusCode, responseHeaders) {
  const error = new MCPTransportError(message, kind);
  if (statusCode !== undefined) error.statusCode = statusCode;
  if (responseHeaders) error.responseHeaders = responseHeaders;
  return error;
}

function parseSsePayloads(raw) {
  const payloads = [];
  let data = [];
  const flush = () => {
    if (data.length) payloads.push(data.join('\n'));
    data = [];
  };
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  flush();
  return payloads;
}

function parseJsonValues(raw, contentType) {
  const source = String(contentType || '').toLowerCase().includes('text/event-stream')
    ? parseSsePayloads(raw)
    : [String(raw)];
  const values = [];
  for (const payload of source) {
    if (!payload.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch {
      throw new MCPTransportError('MCP server returned invalid JSON', 'invalid-response');
    }
    if (Array.isArray(parsed)) values.push(...parsed);
    else values.push(parsed);
  }
  return values;
}

function rpcResponseError(response) {
  const message = typeof response.error.message === 'string'
    ? response.error.message
    : JSON.stringify(response.error).slice(0, 2000);
  const error = new MCPResponseError(message || 'MCP server rejected the request');
  error.rpcError = true;
  if (Number.isSafeInteger(response.error.code)) error.code = response.error.code;
  if (response.error.data !== undefined) error.data = response.error.data;
  return error;
}

function parseRpcResult(raw, contentType, expectedId) {
  const values = parseJsonValues(raw, contentType);
  const response = values.find((value) => (
    value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'id') && value.id === expectedId
  ));
  if (!response) throw new MCPTransportError('MCP server returned no JSON-RPC response with the matching request id', 'invalid-response');
  if (response.error) throw rpcResponseError(response);
  if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new MCPTransportError('MCP response omitted both result and error', 'invalid-response');
  }
  return response.result === undefined || response.result === null ? {} : response.result;
}

function parseRpcError(raw, contentType, expectedId) {
  const values = parseJsonValues(raw, contentType);
  const response = values.find((value) => (
    value && typeof value === 'object'
      && value.error
      && (expectedId === undefined || value.id === expectedId)
  ));
  return response ? rpcResponseError(response) : null;
}

function modernParams(params, protocolVersion) {
  const base = isPlainObject(params) ? { ...params } : {};
  const existingMeta = isPlainObject(base._meta) ? base._meta : {};
  base._meta = {
    ...existingMeta,
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'MeshDirect', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  return base;
}

function internalTransportHeaders(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new MCPResponseError('Internal MCP transport headers must be an object');
  const out = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName || '').trim().toLowerCase();
    const headerValue = String(rawValue);
    if (!HEADER_NAME_RE.test(name) || /[\r\n\0]/.test(headerValue)) {
      throw new MCPResponseError(`Invalid MCP transport header '${name || '(empty)'}'`);
    }
    out[name] = headerValue;
  }
  return out;
}

function requestHttpJsonRpc(urlString, method, params = {}, options = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new MCPTransportError('MCP URL must use HTTP or HTTPS', 'invalid-response'));
  }
  const notification = options.notification === true;
  const requestId = notification
    ? undefined
    : `meshdirect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const message = { jsonrpc: '2.0', method };
  if (!notification) message.id = requestId;
  if (isPlainObject(params)) message.params = params;
  const body = JSON.stringify(message);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.min(450_000, Math.max(1000, options.timeoutMs))
    : 150_000;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body),
    'user-agent': 'MeshDirect-MCP/1.0',
    ...resolveAuthHeaders(options.auth),
    ...internalTransportHeaders(options.transportHeaders),
  };
  if (options.standardHeaders !== false) {
    headers['mcp-method'] = method;
    const named = params && (params.name !== undefined ? params.name : params.uri);
    if (named !== undefined && named !== null && named !== '') {
      headers['mcp-name'] = encodeProtocolHeaderValue(named);
    }
  }
  if (options.protocolVersion) headers['mcp-protocol-version'] = options.protocolVersion;
  if (options.sessionId) headers['mcp-session-id'] = options.sessionId;

  const transport = url.protocol === 'https:' ? https : http;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let responseStarted = false;
    let bytesReceived = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (error) {
        if (error.elapsedMs === undefined) error.elapsedMs = Date.now() - startedAt;
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => {
      if (request) request.destroy();
      finish(new MCPTransportError('MCP call aborted', 'aborted'));
    };
    const timer = setTimeout(() => {
      if (request) request.destroy();
      finish(new MCPTransportError(
        responseStarted
          ? `MCP response timed out after ${Math.round(timeoutMs / 1000)}s mid-stream`
          : `MCP request timed out after ${Math.round(timeoutMs / 1000)}s`,
        responseStarted ? 'midstream-close' : 'timeout',
      ));
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
    }, (response) => {
      responseStarted = true;
      let raw = '';
      response.on('data', (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(new MCPTransportError('MCP response exceeded the 8 MB limit', 'oversize'));
          return;
        }
        raw += chunk.toString('utf8');
      });
      response.on('aborted', () => finish(new MCPTransportError('MCP response ended before completion', 'midstream-close')));
      response.on('end', () => {
        const responseHeaders = response.headers || {};
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          if (raw.trim()) {
            try {
              const rpcError = parseRpcError(raw, responseHeaders['content-type'], requestId);
              if (rpcError) {
                rpcError.statusCode = statusCode;
                rpcError.responseHeaders = responseHeaders;
                finish(rpcError);
                return;
              }
            } catch {
              // The status code remains the source of truth when the body is not
              // a valid JSON-RPC error (common for expired legacy sessions).
            }
          }
          const kind = statusCode === 401 || statusCode === 403 ? 'auth' : 'http-error';
          finish(transportError(`MCP endpoint returned HTTP ${statusCode}`, kind, statusCode, responseHeaders));
          return;
        }
        if (notification) {
          finish(null, { result: {}, headers: responseHeaders, statusCode });
          return;
        }
        if (!raw.trim()) {
          finish(new MCPTransportError('MCP endpoint returned an empty response', 'empty-response'));
          return;
        }
        try {
          finish(null, {
            result: parseRpcResult(raw, responseHeaders['content-type'], requestId),
            headers: responseHeaders,
            statusCode,
          });
        } catch (error) {
          if (error && typeof error === 'object') {
            error.statusCode = statusCode;
            error.responseHeaders = responseHeaders;
          }
          finish(error);
        }
      });
      response.on('error', (error) => finish(new MCPTransportError(`MCP stream failed: ${error.message}`, 'midstream-close')));
    });
    request.on('error', (error) => {
      const code = error && error.code;
      let kind = 'connect-failed';
      if (code === 'ECONNREFUSED') kind = 'connect-refused';
      else if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') kind = 'connect-timeout';
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') kind = 'dns';
      else if (code === 'ECONNRESET') kind = responseStarted ? 'midstream-close' : 'reset';
      finish(new MCPTransportError(`MCP request failed: ${error.message}${code ? ` (${code})` : ''}`, kind));
    });
    request.end(body);
  });
}

function containsHeaderAnnotation(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'x-mcp-header')) return true;
  return Object.values(value).some(containsHeaderAnnotation);
}

function collectToolHeaderAnnotations(schema) {
  if (!isPlainObject(schema)) return [];
  const annotations = [];
  const usedNames = new Set();

  const visit = (node, propertyPath, reachableProperty) => {
    if (!isPlainObject(node)) return;
    if (Object.prototype.hasOwnProperty.call(node, 'x-mcp-header')) {
      if (!reachableProperty || propertyPath.length === 0) {
        throw new MCPResponseError('x-mcp-header must be attached to a statically reachable object property');
      }
      const suffix = text(node['x-mcp-header'], 200).trim();
      if (!HEADER_NAME_RE.test(suffix)) throw new MCPResponseError(`Invalid x-mcp-header name '${suffix}'`);
      const lower = suffix.toLowerCase();
      if (usedNames.has(lower)) throw new MCPResponseError(`Duplicate x-mcp-header name '${suffix}'`);
      usedNames.add(lower);
      if (!['string', 'integer', 'boolean'].includes(node.type)) {
        throw new MCPResponseError(`x-mcp-header '${suffix}' must annotate a string, integer, or boolean property`);
      }
      annotations.push({
        path: [...propertyPath],
        type: node.type,
        header: `mcp-param-${suffix.toLowerCase()}`,
        label: suffix,
      });
    }

    if (isPlainObject(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        visit(child, [...propertyPath, name], true);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === 'x-mcp-header') continue;
      if (containsHeaderAnnotation(value)) {
        throw new MCPResponseError(`x-mcp-header cannot appear under schema keyword '${key}'`);
      }
    }
  };

  visit(schema, [], false);
  return annotations;
}

function valueAtPath(root, propertyPath) {
  let value = root;
  for (const part of propertyPath) {
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function annotationHeaders(annotations, args) {
  const headers = {};
  for (const annotation of annotations) {
    const value = valueAtPath(args, annotation.path);
    if (value === undefined || value === null) continue;
    if (annotation.type === 'string' && typeof value !== 'string') {
      throw new MCPResponseError(`Tool argument ${annotation.path.join('.')} must be a string for MCP header ${annotation.label}`);
    }
    if (annotation.type === 'boolean' && typeof value !== 'boolean') {
      throw new MCPResponseError(`Tool argument ${annotation.path.join('.')} must be a boolean for MCP header ${annotation.label}`);
    }
    if (annotation.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new MCPResponseError(`Tool argument ${annotation.path.join('.')} must be a safe integer for MCP header ${annotation.label}`);
    }
    headers[annotation.header] = encodeProtocolHeaderValue(value);
  }
  return headers;
}

function shouldFallBackFromLatest(error) {
  if (error && (error.kind === 'auth' || error.kind === 'aborted')) return false;
  if (error instanceof MCPResponseError) {
    if (MODERN_PROTOCOL_ERROR_CODES.has(error.code) || error.code === -32602 || error.code === -32020) return false;
    return error.code === -32601;
  }
  return error instanceof MCPTransportError
    && [400, 404, 405, 415].includes(error.statusCode)
    && !error.rpcError;
}

class McpHttpClient {
  constructor(entry, log = () => {}) {
    this.entry = entry;
    this.log = log;
    this.session = null;
    this.toolHeaders = new Map();
    this.toolDefinitions = new Map();
  }

  _options(timeoutMs, signal, extra = {}) {
    return {
      timeoutMs,
      signal,
      auth: this.entry.auth || {},
      ...extra,
    };
  }

  async _latest(method, params, options = {}) {
    const protocolVersion = this.entry.protocolVersion || LATEST_PROTOCOL_VERSION;
    const requestParams = modernParams(params, protocolVersion);
    return requestHttpJsonRpc(this.entry.url, method, requestParams, this._options(
      options.timeoutMs,
      options.signal,
      {
        protocolVersion,
        standardHeaders: true,
        notification: options.notification,
        transportHeaders: options.transportHeaders,
      },
    ));
  }

  async _direct(method, params, options = {}) {
    return requestHttpJsonRpc(this.entry.url, method, params, this._options(
      options.timeoutMs,
      options.signal,
      { standardHeaders: false, notification: options.notification },
    ));
  }

  async _initialize(options = {}) {
    const proposed = this.entry.protocolVersion && this.entry.protocolVersion !== LATEST_PROTOCOL_VERSION
      ? this.entry.protocolVersion
      : LEGACY_PROTOCOL_VERSION;
    const response = await requestHttpJsonRpc(this.entry.url, 'initialize', {
      protocolVersion: proposed,
      capabilities: {},
      clientInfo: { name: 'MeshDirect', version: '1.0.0' },
    }, this._options(options.timeoutMs, options.signal, {
      protocolVersion: proposed,
      standardHeaders: false,
    }));
    const negotiated = text(response.result && response.result.protocolVersion, 40).trim();
    if (!VERSION_RE.test(negotiated) || negotiated === LATEST_PROTOCOL_VERSION) {
      throw new MCPResponseError('MCP initialize returned an invalid initialization-era protocolVersion');
    }
    const rawSession = response.headers && response.headers['mcp-session-id'];
    const candidate = Array.isArray(rawSession) ? rawSession[0] : rawSession;
    const sessionId = candidate === undefined ? '' : text(candidate, 1024);
    if (sessionId && !VISIBLE_ASCII_RE.test(sessionId)) {
      throw new MCPResponseError('MCP server returned an invalid Mcp-Session-Id header');
    }
    this.session = { id: sessionId, protocolVersion: negotiated, initializedAt: Date.now() };
    await requestHttpJsonRpc(this.entry.url, 'notifications/initialized', {}, this._options(
      options.timeoutMs,
      options.signal,
      {
        protocolVersion: negotiated,
        sessionId,
        standardHeaders: false,
        notification: true,
      },
    ));
    return this.session;
  }

  async _sessionRequest(method, params, options = {}, retry = true) {
    if (!this.session) await this._initialize(options);
    try {
      return await requestHttpJsonRpc(this.entry.url, method, params, this._options(
        options.timeoutMs,
        options.signal,
        {
          protocolVersion: this.session.protocolVersion,
          sessionId: this.session.id,
          standardHeaders: false,
          notification: options.notification,
        },
      ));
    } catch (error) {
      if (retry && this.session && this.session.id && error && error.statusCode === 404) {
        this.log('agentcaps: MCP session expired; reinitialising once');
        this.session = null;
        await this._initialize(options);
        return this._sessionRequest(method, params, options, false);
      }
      throw error;
    }
  }

  async _request(mode, method, params, options = {}) {
    if (mode === 'latest') return this._latest(method, params, options);
    if (mode === 'session') return this._sessionRequest(method, params, options);
    if (mode === 'direct') return this._direct(method, params, options);
    throw new MCPResponseError(`Unknown MCP transport mode '${mode}'`);
  }

  _indexTools(rawTools, mode) {
    const unique = new Map();
    const headers = new Map();
    for (const tool of rawTools) {
      if (!tool || !isValidToolName(tool.name)) {
        this.log('agentcaps: ignored MCP tool with an invalid or missing name');
        continue;
      }
      try {
        const annotations = mode === 'latest'
          ? collectToolHeaderAnnotations(tool.inputSchema || { type: 'object' })
          : [];
        unique.set(tool.name, tool);
        headers.set(tool.name, annotations);
      } catch (error) {
        this.log(`agentcaps: ignored MCP tool ${tool.name}: ${text(error && error.message, 500)}`);
      }
    }
    this.toolDefinitions = unique;
    this.toolHeaders = headers;
    return [...unique.values()];
  }

  async _listToolsMode(mode, options = {}) {
    const rawTools = [];
    let cursorPresent = false;
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params = cursorPresent ? { cursor } : {};
      const response = await this._request(mode, 'tools/list', params, options);
      const result = response.result || {};
      if (Array.isArray(result.tools)) rawTools.push(...result.tools);
      if (!Object.prototype.hasOwnProperty.call(result, 'nextCursor')) {
        return this._indexTools(rawTools, mode);
      }
      if (typeof result.nextCursor !== 'string') {
        throw new MCPResponseError('MCP tools/list nextCursor must be a string');
      }
      const nextCursor = result.nextCursor;
      const marker = JSON.stringify(nextCursor);
      if (seenCursors.has(marker)) throw new MCPResponseError('MCP tools/list repeated a pagination cursor');
      seenCursors.add(marker);
      cursorPresent = true;
      cursor = nextCursor;
    }
    throw new MCPResponseError(`MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
  }

  async _probeLatest(options = {}) {
    let requested = this.entry.protocolVersion || LATEST_PROTOCOL_VERSION;
    if (!VERSION_RE.test(requested)) throw new MCPResponseError('Current MCP protocolVersion must use YYYY-MM-DD');
    this.entry.protocolVersion = requested;

    let discovery;
    try {
      discovery = await this._latest('server/discover', {}, options);
    } catch (error) {
      if (!(error instanceof MCPResponseError) || error.code !== -32022) throw error;
      const data = isPlainObject(error.data) ? error.data : {};
      const advertised = Array.isArray(data.supportedVersions)
        ? data.supportedVersions
        : (Array.isArray(data.supported) ? data.supported : []);
      if (!advertised.includes(LATEST_PROTOCOL_VERSION) || requested === LATEST_PROTOCOL_VERSION) throw error;
      // The current protocol is request-scoped, so a version mismatch is fixed
      // by retrying the same modern request with a mutually supported version.
      // It is not evidence that the endpoint is a legacy initialize server.
      requested = LATEST_PROTOCOL_VERSION;
      this.entry.protocolVersion = requested;
      discovery = await this._latest('server/discover', {}, options);
    }

    const result = discovery.result || {};
    const supported = Array.isArray(result.supportedVersions)
      ? result.supportedVersions.filter((version) => typeof version === 'string')
      : [];
    if (!supported.includes(requested)) {
      const error = new MCPResponseError(`MCP server discovery does not advertise ${requested}`);
      error.code = -32022;
      error.data = { supportedVersions: supported };
      error.rpcError = true;
      throw error;
    }
    if (requested !== LATEST_PROTOCOL_VERSION) {
      throw new MCPResponseError(`MeshDirect implements current stateless MCP ${LATEST_PROTOCOL_VERSION}, not ${requested}`);
    }
    const tools = await this._listToolsMode('latest', options);
    const serverInfo = isPlainObject(result._meta) && isPlainObject(result._meta['io.modelcontextprotocol/serverInfo'])
      ? result._meta['io.modelcontextprotocol/serverInfo']
      : null;
    return {
      transport: 'latest',
      protocolVersion: requested,
      sessionful: false,
      serverInfo,
      capabilities: isPlainObject(result.capabilities) ? result.capabilities : {},
      tools,
    };
  }

  async _probeMode(mode, options = {}) {
    if (mode === 'latest') return this._probeLatest(options);
    const tools = await this._listToolsMode(mode, options);
    return {
      transport: mode,
      protocolVersion: mode === 'session' && this.session ? this.session.protocolVersion : null,
      sessionful: mode === 'session' && Boolean(this.session && this.session.id),
      serverInfo: null,
      tools,
    };
  }

  async probe(options = {}) {
    const requested = normalizeTransport(this.entry.transport);
    const modes = requested === 'auto' ? ['latest', 'session', 'direct'] : [requested];
    const failures = [];
    for (const mode of modes) {
      this.session = null;
      try {
        return await this._probeMode(mode, options);
      } catch (error) {
        failures.push(`${mode}: ${text(error && error.message, 280) || 'failed'}`);
        if (requested !== 'auto') throw error;
        if (mode === 'latest' && !shouldFallBackFromLatest(error)) throw error;
        if (error && (error.kind === 'auth' || error.kind === 'aborted')) throw error;
      }
    }
    throw new MCPTransportError(`Could not negotiate MCP transport (${failures.join('; ')})`, 'connect-failed');
  }

  async listTools(options = {}) {
    let mode = normalizeTransport(this.entry.transport);
    if (mode === 'auto') {
      const negotiated = await this.probe(options);
      this.entry.transport = negotiated.transport;
      this.entry.protocolVersion = negotiated.protocolVersion;
      return negotiated.tools;
    }
    return this._listToolsMode(mode, options);
  }

  async callTool(name, args, options = {}) {
    if (!isValidToolName(name)) throw new MCPResponseError('A valid MCP tool name is required');
    const toolArgs = isPlainObject(args) ? args : {};
    let mode = normalizeTransport(this.entry.transport);
    if (mode === 'auto') {
      const negotiated = await this.probe(options);
      mode = negotiated.transport;
      this.entry.transport = mode;
      this.entry.protocolVersion = negotiated.protocolVersion;
    }

    if (mode !== 'latest') {
      const response = await this._request(mode, 'tools/call', { name, arguments: toolArgs }, options);
      return response.result || {};
    }

    if (!this.toolDefinitions.has(name)) await this._listToolsMode('latest', options);
    if (!this.toolDefinitions.has(name)) throw new MCPResponseError(`MCP server does not advertise tool '${name}'`);
    const invoke = async (retryHeaderMismatch) => {
      const transportHeaders = annotationHeaders(this.toolHeaders.get(name) || [], toolArgs);
      try {
        const response = await this._latest('tools/call', { name, arguments: toolArgs }, {
          ...options,
          transportHeaders,
        });
        return response.result || {};
      } catch (error) {
        if (retryHeaderMismatch && error instanceof MCPResponseError && error.code === -32020) {
          await this._listToolsMode('latest', options);
          return invoke(false);
        }
        throw error;
      }
    };
    return invoke(true);
  }
}

module.exports = {
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  McpHttpClient,
  authSummary,
  collectToolHeaderAnnotations,
  encodeProtocolHeaderValue,
  isValidToolName,
  normalizeAuthSpec,
  normalizeTransport,
  requestHttpJsonRpc,
  resolveAuthHeaders,
};
