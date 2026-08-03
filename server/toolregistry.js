// MeshDirect owned tool registry. No OpenClaw runtime, subprocess, or protocol dependency.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeError, sanitizeToolOutput, compactOneLine } = require('./util');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run exact Bash source on the GETH host. Use this for local inspection, coding, tests, and service operations. Commands run in a persistent per-model workspace unless cwd is supplied.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Exact Bash command or multiline script.' },
          cwd: { type: 'string', description: 'Optional working directory. Relative paths resolve inside the model workspace.' },
          timeout_s: { type: 'integer', minimum: 1, maximum: 120, description: 'Execution timeout in seconds.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from GETH. Relative paths resolve inside the model workspace. Secret stores and private keys are blocked.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          max_chars: { type: 'integer', minimum: 1, maximum: 100000 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file on GETH. Parent directories are created. Relative paths resolve inside the model workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          executable: { type: 'boolean', description: 'Set mode 0755 instead of 0644.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories on GETH with bounded recursion.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Default is the model workspace.' },
          max_depth: { type: 'integer', minimum: 0, maximum: 6 },
          max_entries: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch an HTTP or HTTPS URL and return status, headers, and a bounded text body.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'HEAD'] },
          max_chars: { type: 'integer', minimum: 1, maximum: 100000 },
          timeout_s: { type: 'integer', minimum: 1, maximum: 60 },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sg_mcp',
      description: 'Discover and call the complete SG1 or SG2 MCP tool catalog. Use action=health to verify access, search to find tools, schema before an unfamiliar call, then call to execute it. This exposes hundreds of SG tools without OpenClaw.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['health', 'search', 'schema', 'call'] },
          server: { type: 'string', enum: ['sg1', 'sg2', 'all'], description: 'call requires sg1 or sg2; discovery may use all.' },
          query: { type: 'string', description: 'Search phrase for action=search.' },
          name: { type: 'string', description: 'Exact MCP tool name for schema or call.' },
          arguments: { type: 'object', description: 'Tool arguments for action=call.', additionalProperties: true },
          timeout_s: { type: 'integer', minimum: 1, maximum: 300 },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

const PROTECTED_PATHS = [
  /^\/root\/vault\.json$/,
  /^\/root\/\.ssh(?:\/|$)/,
  /^\/root\/\.openclaw(?:-|\/|$)/,
  /^\/etc\/(?:shadow|gshadow|sudoers)(?:\.|$)/,
  /^\/etc\/(?:meshdirect|qwen38)[^/]*\.env$/,
  /^\/proc\/\d+\/(?:environ|mem)$/,
  /^\/sys\/kernel\/security(?:\/|$)/,
];

function clampInt(value, dflt, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function workspaceFor(config, model) {
  return path.join(config.workspaceRoot, model === 'stable' ? 'stable' : 'preview');
}

function resolveToolPath(config, model, value) {
  const workspace = workspaceFor(config, model);
  const raw = typeof value === 'string' && value.trim() ? value.trim() : workspace;
  return path.normalize(path.isAbsolute(raw) ? raw : path.resolve(workspace, raw));
}

function assertNotProtected(target, operation) {
  if (PROTECTED_PATHS.some((re) => re.test(target))) {
    throw new Error(`${operation} blocked for protected credential path`);
  }
}

function processEnv(config, workspace) {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: workspace,
    USER: 'meshdirect',
    LOGNAME: 'meshdirect',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: config.tmpDir,
  };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = Math.max(1000, options.timeoutMs || 30000);
    const maxOutput = Math.max(1024, options.maxOutput || 60000);
    const signal = options.signal;
    if (signal && signal.aborted) {
      const err = new Error('aborted'); err.status = 499; reject(err); return;
    }

    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { reject(e); return; }

    let stdout = '';
    let stderr = '';
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (kind, chunk) => {
      const text = chunk.toString('utf8');
      const remaining = maxOutput - kept;
      if (remaining <= 0) { truncated = true; return; }
      const part = text.slice(0, remaining);
      kept += part.length;
      if (kind === 'stdout') stdout += part; else stderr += part;
      if (part.length < text.length) truncated = true;
    };
    child.stdout.on('data', (c) => append('stdout', c));
    child.stderr.on('data', (c) => append('stderr', c));

    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 1200).unref();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 600).unref();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        const err = new Error('aborted'); err.status = 499; reject(err); return;
      }
      resolve({
        exitCode: timedOut ? 124 : (Number.isInteger(code) ? code : 1),
        signal: closeSignal || null,
        stdout,
        stderr: timedOut ? `${stderr}${stderr ? '\n' : ''}command timed out after ${Math.round(timeoutMs / 1000)}s` : stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });

    if (options.input != null) child.stdin.end(String(options.input));
    else child.stdin.end();
  });
}

async function executeLocal(config, model, args, opts) {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) throw new Error('command is required');
  if (command.length > 100000) throw new Error('command is too long');
  const workspace = workspaceFor(config, model);
  const cwd = resolveToolPath(config, model, args.cwd || workspace);
  const st = await fsp.stat(cwd).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
  const timeoutS = clampInt(args.timeout_s, Math.round(config.toolTimeoutMs / 1000), 1, 120);
  const result = await runProcess('/bin/bash', ['-lc', command], {
    cwd,
    env: processEnv(config, workspace),
    timeoutMs: timeoutS * 1000,
    maxOutput: config.toolOutputMaxChars,
    signal: opts.signal,
  });
  return result;
}

async function readFile(config, model, args) {
  const target = resolveToolPath(config, model, args.path);
  assertNotProtected(target, 'read');
  const maxChars = clampInt(args.max_chars, Math.min(config.toolOutputMaxChars, 60000), 1, 100000);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('path is not a regular file');
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxChars + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead);
    if (raw.includes(0)) throw new Error('binary file reading is not supported');
    const text = raw.toString('utf8');
    return { path: target, size: stat.size, content: text.slice(0, maxChars), truncated: stat.size > bytesRead || text.length > maxChars };
  } finally { await handle.close(); }
}

async function writeFile(config, model, args) {
  const target = resolveToolPath(config, model, args.path);
  assertNotProtected(target, 'write');
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  if (args.content.length > config.maxWriteChars) throw new Error(`content exceeds ${config.maxWriteChars} characters`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.meshdirect-${process.pid}-${Date.now()}`;
  const mode = args.executable ? 0o755 : 0o644;
  try {
    await fsp.writeFile(tmp, args.content, { mode });
    await fsp.rename(tmp, target);
    await fsp.chmod(target, mode);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  return { path: target, bytes: Buffer.byteLength(args.content), mode: mode.toString(8) };
}

async function listFiles(config, model, args) {
  const root = resolveToolPath(config, model, args.path || '');
  assertNotProtected(root, 'list');
  const maxDepth = clampInt(args.max_depth, 2, 0, 6);
  const maxEntries = clampInt(args.max_entries, 250, 1, 1000);
  const entries = [];

  async function walk(dir, depth) {
    if (entries.length >= maxEntries) return;
    const names = await fsp.readdir(dir, { withFileTypes: true });
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of names) {
      if (entries.length >= maxEntries) return;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full) || '.';
      let type = ent.isDirectory() ? 'directory' : ent.isFile() ? 'file' : ent.isSymbolicLink() ? 'symlink' : 'other';
      let size = null;
      if (ent.isFile()) {
        try { size = (await fsp.stat(full)).size; } catch { /* raced */ }
      }
      entries.push({ path: rel, type, size });
      if (ent.isDirectory() && depth < maxDepth && !['node_modules', '.git', '__pycache__'].includes(ent.name)) {
        await walk(full, depth + 1);
      }
    }
  }
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error('path is not a directory');
  await walk(root, 0);
  return { root, entries, truncated: entries.length >= maxEntries };
}

async function readResponseLimited(response, maxChars) {
  if (!response.body || response.requestMethod === 'HEAD') return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (out.length <= maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > maxChars) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  out += decoder.decode();
  return out.slice(0, maxChars);
}

async function webFetch(config, args, opts) {
  let url;
  try { url = new URL(String(args.url || '')); }
  catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only HTTP and HTTPS URLs are supported');
  const timeoutS = clampInt(args.timeout_s, 20, 1, 60);
  const maxChars = clampInt(args.max_chars, Math.min(config.toolOutputMaxChars, 60000), 1, 100000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutS * 1000);
  const onAbort = () => ac.abort();
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const method = args.method === 'HEAD' ? 'HEAD' : 'GET';
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'MeshDirect/2.0 (+private-agent-harness)', 'Accept': 'text/*,application/json,application/xml;q=0.9,*/*;q=0.5' },
    });
    const body = method === 'HEAD' ? '' : await readResponseLimited(response, maxChars);
    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') || '',
      contentLength: response.headers.get('content-length') || null,
      body,
      truncated: body.length >= maxChars,
    };
  } catch (e) {
    if ((opts.signal && opts.signal.aborted)) { const err = new Error('aborted'); err.status = 499; throw err; }
    if (ac.signal.aborted) throw new Error(`web fetch timed out after ${timeoutS}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

async function sgMcp(config, model, args, opts) {
  const action = String(args.action || '');
  const server = args.server || (action === 'call' ? 'sg2' : 'all');
  if (!['health', 'search', 'schema', 'call'].includes(action)) throw new Error('invalid sg_mcp action');
  if (!['sg1', 'sg2', 'all'].includes(server)) throw new Error('invalid SG server');
  if (action === 'call' && server === 'all') throw new Error('action=call requires server sg1 or sg2');
  const timeoutS = clampInt(args.timeout_s, action === 'call' ? 120 : 20, 1, 300);
  const argv = ['--timeout', String(timeoutS), action];
  if (action === 'health') argv.push(server);
  if (action === 'search') {
    if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required for search');
    argv.push(args.query, server);
  }
  if (action === 'schema') {
    if (typeof args.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.name)) throw new Error('valid tool name is required for schema');
    argv.push(args.name, server);
  }
  if (action === 'call') {
    if (typeof args.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.name)) throw new Error('valid tool name is required for call');
    const callArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
    const encoded = JSON.stringify(callArgs);
    if (encoded.length > 250000) throw new Error('MCP arguments are too large');
    argv.push(server, args.name, '--args', encoded);
  }
  const workspace = workspaceFor(config, model);
  const result = await runProcess(config.sgMcpCli, argv, {
    cwd: workspace,
    env: processEnv(config, workspace),
    timeoutMs: Math.min((timeoutS + 10) * 1000, 310000),
    maxOutput: config.toolOutputMaxChars,
    signal: opts.signal,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || `sg_mcp exited ${result.exitCode}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { parsed = { text: result.stdout }; }
  return { server, action, result: parsed, durationMs: result.durationMs, truncated: result.truncated };
}

function parseArguments(call) {
  const raw = call && call.function ? call.function.arguments : call && call.arguments;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') throw new Error('tool arguments must be a JSON object');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`invalid tool argument JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be a JSON object');
  return parsed;
}

function labelFor(name, args) {
  if (name === 'exec') return `exec · ${compactOneLine(args.command || '', 90)}`;
  if (name === 'sg_mcp') return `${String(args.server || 'all').toUpperCase()} · ${args.action}${args.name ? ' · ' + args.name : ''}`;
  if (name === 'web_fetch') return `web · ${compactOneLine(args.url || '', 90)}`;
  if (name === 'read_file' || name === 'write_file' || name === 'list_files') return `${name} · ${compactOneLine(args.path || '.', 90)}`;
  return name;
}

async function executeTool(config, model, call, opts = {}) {
  const started = Date.now();
  const name = call && call.function && call.function.name ? call.function.name : call && call.name;
  let args = {};
  try { args = parseArguments(call); }
  catch (e) {
    return { name: name || 'unknown', label: name || 'unknown', ok: false, content: JSON.stringify({ ok: false, error: sanitizeError(e.message) }), summary: sanitizeError(e.message), durationMs: 0, arguments: '{}' };
  }
  const label = labelFor(name, args);
  const argsSummary = compactOneLine(args, 500);
  try {
    let value;
    if (name === 'exec') value = await executeLocal(config, model, args, opts);
    else if (name === 'read_file') value = await readFile(config, model, args);
    else if (name === 'write_file') value = await writeFile(config, model, args);
    else if (name === 'list_files') value = await listFiles(config, model, args);
    else if (name === 'web_fetch') value = await webFetch(config, args, opts);
    else if (name === 'sg_mcp') value = await sgMcp(config, model, args, opts);
    else throw new Error(`unknown tool: ${name || '(missing)'}`);

    const sanitized = sanitizeToolOutput({ ok: true, ...value }, config.toolOutputMaxChars);
    const ok = !(value && Number.isInteger(value.exitCode) && value.exitCode !== 0);
    let summary = 'completed';
    if (name === 'exec') summary = ok ? `exit 0 in ${value.durationMs}ms` : `exit ${value.exitCode} in ${value.durationMs}ms`;
    else if (name === 'sg_mcp') summary = `${String(value.server).toUpperCase()} ${value.action} completed in ${value.durationMs}ms`;
    else if (name === 'web_fetch') summary = `HTTP ${value.status} ${value.url}`;
    else if (name === 'read_file') summary = `read ${value.size} bytes`;
    else if (name === 'write_file') summary = `wrote ${value.bytes} bytes`;
    else if (name === 'list_files') summary = `${value.entries.length} entries`;
    return { name, label, ok, content: sanitized.text, summary: compactOneLine(summary, 220), durationMs: Date.now() - started, arguments: argsSummary, truncated: sanitized.truncated || !!(value && value.truncated) };
  } catch (e) {
    if (e && e.status === 499) throw e;
    const clean = sanitizeError(e && e.message);
    return { name: name || 'unknown', label, ok: false, content: JSON.stringify({ ok: false, error: clean }), summary: clean, durationMs: Date.now() - started, arguments: argsSummary, truncated: false };
  }
}

function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

module.exports = { getToolDefinitions, executeTool, runProcess, parseArguments, labelFor };
