// agent loop: gives a lane real tools instead of letting the model narrate
// tool calls as prose. Drives modelclient.runChat round-trip by round-trip,
// executing whatever the model asks for and feeding the result back.
//
// By explicit owner instruction there is no step cap and no token cap. The only
// brake is the stop signal, surfaced as shouldStop().

'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');

const SG_ENDPOINTS = { sg1: 'http://10.0.1.20:8095/mcp', sg2: 'http://10.0.1.30:8095/mcp' };
const MAX_TOOL_OUTPUT = 24000;
const SHELL_TIMEOUT_MS = 180000;
const CATALOGUE_TTL_MS = 300000;

const SYSTEM_PROMPT = `You are the Qwen 3.8 Mesh agent for Scott's estate, running on GETH \
(5.75.217.57). You have real tools that actually execute — use them rather than describing what \
you would run.

- shell — run a command on GETH as root.
- read_file / write_file / list_dir — the filesystem.
- sg_find_tools / sg_call — the Silicon Goddess MCP servers. SG1 exposes 305 tools and SG2 exposes \
321, covering the wider estate: other hosts, vast.ai GPUs, Hugging Face, memory, vault, mail, \
budgets and trainer telemetry. Always sg_find_tools first to get an exact name, then sg_call it.

Chain as many tool calls as the task needs; there is no step limit. Prefer finding out over \
guessing: run the command and read the real output rather than assuming.

Be careful with destructive actions. This estate runs live AGILLM training and Scott's services. \
Before anything irreversible — deleting data, killing training, changing firewall rules, rebooting \
— check what you are about to affect and report what you found. There is no automatic brake, so \
your judgement is the safety margin.

Answer in plain prose. Report what you actually ran and what the output actually said.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command on GETH. Returns stdout, stderr and the exit code.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command line, run under bash -lc.' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 file, creating parent directories.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory entries.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sg_find_tools',
      description: 'Search the Silicon Goddess MCP catalogue by keyword. Returns tool names, server and description. Use before sg_call.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword such as "vast", "checkpoint", "memory", "mail".' },
          limit: { type: 'integer' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sg_call',
      description: 'Invoke a Silicon Goddess MCP tool by exact name.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          arguments: { type: 'object' },
          server: { type: 'string', enum: ['sg1', 'sg2'] },
        },
        required: ['tool'],
      },
    },
  },
];

function clip(value, limit = MAX_TOOL_OUTPUT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? null : value);
  if (typeof text !== 'string') return '';
  return text.length > limit
    ? text.slice(0, limit) + '\n…[truncated ' + (text.length - limit) + ' chars]'
    : text;
}

async function mcpRequest(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('MCP HTTP ' + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  return payload.result;
}

let catalogue = { at: 0, tools: [] };

async function loadCatalogue() {
  if (catalogue.tools.length && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.tools;
  const found = [];
  for (const server of Object.keys(SG_ENDPOINTS)) {
    try {
      const result = await mcpRequest(SG_ENDPOINTS[server], 'tools/list', {});
      for (const tool of (result && result.tools) || []) {
        found.push({ server, name: tool.name, description: tool.description || '' });
      }
    } catch {
      // One server down must not blind the agent to the other.
    }
  }
  if (found.length) catalogue = { at: Date.now(), tools: found };
  return found;
}

const IMPLEMENTATIONS = {
  shell({ command }) {
    if (typeof command !== 'string' || !command.trim()) return Promise.resolve('error: no command given');
    return new Promise((resolve) => {
      execFile('/bin/bash', ['-lc', command], {
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: Object.assign({}, process.env, { LC_ALL: 'C.UTF-8' }),
      }, (error, stdout, stderr) => {
        const parts = [];
        if (stdout) parts.push('stdout:\n' + stdout);
        if (stderr) parts.push('stderr:\n' + stderr);
        parts.push('exit: ' + ((error && error.code) || 0));
        resolve(clip(parts.join('\n')));
      });
    });
  },

  async read_file({ path }) {
    try { return clip(await fs.readFile(String(path), 'utf8')); }
    catch (error) { return 'error: ' + error.message; }
  },

  async write_file({ path, content }) {
    try {
      const target = String(path);
      const parent = target.replace(/\/[^/]*$/, '');
      if (parent) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, String(content == null ? '' : content), 'utf8');
      return 'wrote ' + Buffer.byteLength(String(content == null ? '' : content)) + ' bytes to ' + target;
    } catch (error) { return 'error: ' + error.message; }
  },

  async list_dir({ path }) {
    try {
      const entries = await fs.readdir(String(path), { withFileTypes: true });
      return clip(entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n'));
    } catch (error) { return 'error: ' + error.message; }
  },

  async sg_find_tools({ query, limit }) {
    const all = await loadCatalogue();
    if (!all.length) return 'error: no MCP server reachable';
    const needle = String(query || '').toLowerCase();
    const cap = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 60) : 25;
    const hits = all
      .filter((t) => t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle))
      .slice(0, cap)
      .map((t) => t.server + '  ' + t.name + ' — ' + t.description.slice(0, 140));
    return hits.length
      ? clip(hits.join('\n'))
      : 'no tools matched "' + query + '" (catalogue has ' + all.length + ' tools)';
  },

  async sg_call({ tool, arguments: args, server }) {
    const endpoint = SG_ENDPOINTS[server === 'sg2' ? 'sg2' : 'sg1'];
    try {
      const result = await mcpRequest(endpoint, 'tools/call', {
        name: String(tool),
        arguments: args && typeof args === 'object' ? args : {},
      });
      const content = Array.isArray(result && result.content)
        ? result.content.map((i) => (i && i.text) || JSON.stringify(i)).join('\n')
        : JSON.stringify(result);
      return clip(content);
    } catch (error) { return 'error: ' + error.message; }
  },
};

/**
 * Run one turn to completion, executing tools as the model asks for them.
 *
 * @param {object} options
 * @param {Function} options.callModel  async (messages, opts) => {reply, usage, toolCalls}
 * @param {Array}  options.messages     seed conversation (system prompt is prepended)
 * @param {Function} [options.onProgress]
 * @param {Function} [options.shouldStop]
 */
async function runAgentTurn({ callModel, messages, onProgress, shouldStop }) {
  const thread = messages.slice();
  if (thread.length && thread[0] && thread[0].role === 'system') {
    thread[0] = { role: 'system', content: thread[0].content + '\n\n' + SYSTEM_PROMPT };
  } else {
    thread.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }
  const activity = [];
  let step = 0;
  let toolCalls = 0;
  let tokens = 0;

  const report = (lastTool) => {
    if (onProgress) onProgress({ step, toolCalls, tokens, lastTool: lastTool || '', activity: activity.slice(-12) });
  };

  for (;;) {
    if (shouldStop && shouldStop()) {
      return { reply: 'Stopped on request.', stopped: true, steps: step, toolCalls, tokens, activity };
    }
    step += 1;
    report();

    const out = await callModel(thread, { tools: TOOLS });
    if (out && out.usage && out.usage.total_tokens) tokens += out.usage.total_tokens;

    const requested = (out && out.toolCalls) || [];
    if (!requested.length) {
      report();
      return {
        reply: String((out && out.reply) || '').trim() || '(no reply)',
        stopped: false, steps: step, toolCalls, tokens, activity,
      };
    }

    // Keep the assistant turn verbatim so tool_call ids stay paired with results.
    thread.push({ role: 'assistant', content: (out && out.reply) || '', tool_calls: requested });

    for (const call of requested) {
      if (shouldStop && shouldStop()) {
        return { reply: 'Stopped on request.', stopped: true, steps: step, toolCalls, tokens, activity };
      }
      const name = (call.function && call.function.name) || '';
      let args = {};
      try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { args = {}; }
      toolCalls += 1;
      activity.push({ step, tool: name, at: Date.now() });
      report(name);

      const run = IMPLEMENTATIONS[name];
      let output;
      try {
        output = run ? await run(args) : 'error: unknown tool ' + name;
      } catch (error) {
        output = 'error: ' + error.message;
      }
      thread.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
    }
  }
}

module.exports = { runAgentTurn, TOOLS, SYSTEM_PROMPT };
