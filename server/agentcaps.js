// agentcaps.js — MeshDirect agent capabilities.
//
// Owner directive 2026-08-05 02:03 UK: the agent must be able to
//   1. spawn subagents on its own initiative,
//   2. self-cron: choose to wake itself up at any time,
//   3. keep and use skills,
//   4. keep native memories,
//   5. add new MCP servers at runtime.
//
// This module is ADDITIVE. It does not touch the existing sg1/sg2 gateway,
// which other agents are actively tuning. New tools are appended to the tool
// list and routed here; if this module throws on load the harness still runs.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { requestJsonRpc, MCPResponseError, MCPTransportError } = require('./sgtools');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_SUBAGENT_DEPTH = 2;
const MIN_WAKE_SECONDS = 30;
const MAX_WAKE_SECONDS = 60 * 60 * 24 * 30;

function nowMs() { return Date.now(); }
function id(prefix) { return `${prefix}-${crypto.randomBytes(8).toString('hex')}`; }
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function str(value, max = 20000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/* Durable JSON that survives a crash mid-write: temp file, then rename. */
function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- memories

/* Native memory. Free-text notes with optional key and tags, kept on disk so
   they outlive the process, the session, and the context window. */
class MemoryStore {
  constructor(dir) {
    this.file = path.join(dir, 'memories.json');
    this.items = readJson(this.file, []);
    if (!Array.isArray(this.items)) this.items = [];
  }

  _save() { writeJson(this.file, this.items); }

  remember({ key = '', text = '', tags = [] }) {
    const body = str(text, 40000).trim();
    if (!body) throw new MCPResponseError('memory.remember needs text');
    const slug = str(key, 120).trim();
    const tagList = Array.isArray(tags) ? tags.map((t) => str(t, 40).trim()).filter(Boolean).slice(0, 12) : [];
    // A repeated key updates in place instead of accumulating duplicates.
    const existing = slug ? this.items.find((m) => m.key === slug) : null;
    if (existing) {
      existing.text = body;
      existing.tags = tagList.length ? tagList : existing.tags;
      existing.updatedAt = nowMs();
      this._save();
      return { updated: true, memory: existing };
    }
    const memory = {
      id: id('mem'), key: slug, text: body, tags: tagList,
      createdAt: nowMs(), updatedAt: nowMs(),
    };
    this.items.push(memory);
    this._save();
    return { created: true, memory };
  }

  recall({ key = '', id: wanted = '' }) {
    const memory = this.items.find((m) => (wanted && m.id === wanted) || (key && m.key === key));
    if (!memory) throw new MCPResponseError(`No memory matching ${wanted || key}`);
    return { memory };
  }

  search({ query = '', tags = [], limit = 20 }) {
    const q = str(query, 200).trim().toLowerCase();
    const tagList = Array.isArray(tags) ? tags.map((t) => str(t, 40).toLowerCase()) : [];
    let hits = this.items;
    if (q) hits = hits.filter((m) => m.text.toLowerCase().includes(q) || m.key.toLowerCase().includes(q));
    if (tagList.length) hits = hits.filter((m) => m.tags.some((t) => tagList.includes(t.toLowerCase())));
    hits = hits.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return { matched: hits.length, memories: hits.slice(0, clampInt(limit, 20, 1, 200)) };
  }

  list({ limit = 50 }) {
    const sorted = this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      total: this.items.length,
      memories: sorted.slice(0, clampInt(limit, 50, 1, 500)).map((m) => ({
        id: m.id, key: m.key, tags: m.tags, updatedAt: m.updatedAt,
        preview: m.text.slice(0, 200),
      })),
    };
  }

  forget({ id: wanted = '', key = '' }) {
    const before = this.items.length;
    this.items = this.items.filter((m) => !((wanted && m.id === wanted) || (key && m.key === key)));
    if (this.items.length === before) throw new MCPResponseError(`No memory matching ${wanted || key}`);
    this._save();
    return { forgotten: before - this.items.length };
  }

  /* Short digest injected into the system prompt so the agent knows what it
     already knows without having to call a tool first. */
  digest(limit = 20) {
    if (!this.items.length) return '';
    const sorted = this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    return sorted.map((m) => `- ${m.key || m.id}: ${m.text.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
  }
}

// ------------------------------------------------------------------ skills

/* Skills are markdown playbooks the agent writes for itself and reads back
   later. The index (name + description) goes in the system prompt; the body is
   fetched on demand so a large library costs almost no context. */
class SkillStore {
  constructor(dir) {
    this.dir = path.join(dir, 'skills');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  _file(name) {
    if (!NAME_RE.test(name)) throw new MCPResponseError('Skill name must be short and alphanumeric (dashes/underscores allowed)');
    return path.join(this.dir, `${name}.md`);
  }

  _describe(body) {
    const line = String(body).split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
    return (line || '').trim().slice(0, 200);
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md')); } catch { names = []; }
    const skills = names.map((f) => {
      const name = f.replace(/\.md$/, '');
      let body = '';
      try { body = fs.readFileSync(path.join(this.dir, f), 'utf8'); } catch { body = ''; }
      return { name, description: this._describe(body), bytes: body.length };
    });
    return { total: skills.length, skills };
  }

  read({ name }) {
    const file = this._file(str(name, 64));
    if (!fs.existsSync(file)) throw new MCPResponseError(`No skill named ${name}`);
    return { name, content: fs.readFileSync(file, 'utf8') };
  }

  save({ name, content }) {
    const body = str(content, 200000);
    if (!body.trim()) throw new MCPResponseError('skills.save needs content');
    const file = this._file(str(name, 64));
    const existed = fs.existsSync(file);
    fs.writeFileSync(file, body, { mode: 0o600 });
    return { saved: true, replaced: existed, name, bytes: body.length };
  }

  delete({ name }) {
    const file = this._file(str(name, 64));
    if (!fs.existsSync(file)) throw new MCPResponseError(`No skill named ${name}`);
    fs.unlinkSync(file);
    return { deleted: true, name };
  }

  index() {
    const { skills } = this.list();
    if (!skills.length) return '';
    return skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n');
  }
}

// ----------------------------------------------------------- mcp registry

/* Extra MCP servers the agent adds for itself at runtime. sg1/sg2 stay exactly
   where they are — this is a second, growable shelf, so nothing that already
   works can break. */
class McpRegistry {
  constructor(dir, config, log) {
    this.file = path.join(dir, 'mcpservers.json');
    this.config = config;
    this.log = log;
    this.servers = readJson(this.file, {});
    if (!this.servers || typeof this.servers !== 'object') this.servers = {};
    this.catalog = new Map();
  }

  _save() { writeJson(this.file, this.servers); }

  _url(name) {
    const entry = this.servers[name];
    if (!entry) throw new MCPResponseError(`No MCP server registered as '${name}'. Use action='list' to see them.`);
    return entry.url;
  }

  list() {
    return {
      builtin: Object.keys(this.config.sgServers || {}),
      total: Object.keys(this.servers).length,
      servers: Object.entries(this.servers).map(([name, v]) => ({
        name, url: v.url, note: v.note || '', addedAt: v.addedAt, lastOkAt: v.lastOkAt || null, toolCount: v.toolCount ?? null,
      })),
    };
  }

  async add({ name, url, note = '', timeout }) {
    const key = str(name, 64).trim();
    if (!NAME_RE.test(key)) throw new MCPResponseError('MCP server name must be short and alphanumeric');
    if (this.config.sgServers && this.config.sgServers[key]) {
      throw new MCPResponseError(`'${key}' is a built-in server name; choose another`);
    }
    const target = str(url, 2048).trim();
    let parsed;
    try { parsed = new URL(target); } catch { throw new MCPResponseError('A valid http(s) MCP endpoint URL is required'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new MCPResponseError('MCP endpoint must be http or https');

    // Never register a server we cannot actually reach: prove tools/list works.
    const timeoutMs = clampInt(timeout, 30, 1, 300) * 1000;
    const result = await requestJsonRpc(target, 'tools/list', {}, { timeoutMs });
    const tools = Array.isArray(result.tools) ? result.tools : [];
    this.servers[key] = {
      url: target, note: str(note, 500), addedAt: nowMs(), lastOkAt: nowMs(), toolCount: tools.length,
    };
    this._save();
    this.catalog.delete(key);
    this.log(`agentcaps: registered MCP server ${key} (${tools.length} tools)`);
    return { added: true, name: key, url: target, toolCount: tools.length };
  }

  remove({ name }) {
    const key = str(name, 64).trim();
    if (!this.servers[key]) throw new MCPResponseError(`No MCP server registered as '${key}'`);
    delete this.servers[key];
    this._save();
    this.catalog.delete(key);
    return { removed: true, name: key };
  }

  async _tools(name, { refresh = false, timeoutMs } = {}) {
    const cached = this.catalog.get(name);
    if (!refresh && cached && nowMs() - cached.at < (this.config.sgCatalogTtlMs || 60000)) return cached.tools;
    const result = await requestJsonRpc(this._url(name), 'tools/list', {}, { timeoutMs: timeoutMs || this.config.sgCallTimeoutMs });
    const tools = Array.isArray(result.tools) ? result.tools.filter((t) => t && typeof t.name === 'string') : [];
    this.catalog.set(name, { at: nowMs(), tools });
    if (this.servers[name]) { this.servers[name].lastOkAt = nowMs(); this.servers[name].toolCount = tools.length; this._save(); }
    return tools;
  }

  async test({ name, timeout }) {
    const startedAt = nowMs();
    const tools = await this._tools(str(name, 64), { refresh: true, timeoutMs: clampInt(timeout, 30, 1, 300) * 1000 });
    return { name, ok: true, toolCount: tools.length, elapsedMs: nowMs() - startedAt };
  }

  async search({ name, query = '', limit = 40, timeout }) {
    const key = str(name, 64);
    const tools = await this._tools(key, { timeoutMs: clampInt(timeout, 60, 1, 300) * 1000 });
    const q = str(query, 200).trim().toLowerCase();
    const matched = q
      ? tools.filter((t) => t.name.toLowerCase().includes(q) || String(t.description || '').toLowerCase().includes(q))
      : tools;
    return {
      server: key,
      matched: matched.length,
      tools: matched.slice(0, clampInt(limit, 40, 1, 200)).map((t) => ({
        name: t.name,
        description: String(t.description || '').slice(0, 500),
        inputSchema: t.inputSchema || { type: 'object' },
      })),
    };
  }

  async call({ name, tool, arguments: args, timeout }, options = {}) {
    const key = str(name, 64);
    const toolName = str(tool, 128).trim();
    if (!TOOL_NAME_RE.test(toolName)) throw new MCPResponseError('A valid MCP tool name is required');
    const timeoutMs = clampInt(timeout, Math.ceil((this.config.sgCallTimeoutMs || 150000) / 1000), 1, 450) * 1000;
    const startedAt = nowMs();
    const result = await requestJsonRpc(this._url(key), 'tools/call', {
      name: toolName,
      arguments: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {},
    }, { timeoutMs, signal: options.signal });
    const text = Array.isArray(result && result.content)
      ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
      : JSON.stringify(result);
    if (result && result.isError) throw new MCPResponseError(String(text).slice(0, this.config.maxToolResultChars));
    return { server: key, tool: toolName, result: String(text).slice(0, this.config.maxToolResultChars), elapsedMs: nowMs() - startedAt };
  }
}

// --------------------------------------------------------------- subagents

/* A subagent is a full nested AgentLoop with its own transcript and its own
   tool access, running detached so the parent can keep working and collect the
   result later. Depth is capped so a runaway agent cannot fork-bomb the box. */
class SubagentRunner {
  constructor(config, log, dir, caps) {
    this.config = config;
    this.log = log;
    // Nested agents share the exact capability gateway used by their parent.
    // That keeps memory, skills, schedules, the MCP registry and the running
    // subagent registry coherent instead of creating stale per-agent copies.
    this.caps = caps;
    this.dir = path.join(dir, 'subagents');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.running = new Map();
  }

  _file(sid) { return path.join(this.dir, `${sid}.json`); }
  _record(sid) {
    const rec = readJson(this._file(sid), null);
    if (!rec) throw new MCPResponseError(`No subagent ${sid}`);
    return rec;
  }
  _write(rec) { writeJson(this._file(rec.id), rec); }

  spawn({ task, label = '', model = 'preview', depth = 0, maxRounds }) {
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new MCPResponseError(`Subagent depth limit ${MAX_SUBAGENT_DEPTH} reached; do this work directly instead of nesting further`);
    }
    const brief = str(task, 60000).trim();
    if (!brief) throw new MCPResponseError('subagent.spawn needs a task');

    const lane = this.config.lanes[model] ? model : 'preview';
    const modelId = this.config.lanes[lane].modelId;
    const rec = {
      id: id('sub'), label: str(label, 120) || brief.slice(0, 80),
      task: brief, model: lane, modelId, depth: depth + 1,
      state: 'running', createdAt: nowMs(), finishedAt: null,
      result: '', error: null, usage: null, toolCalls: 0,
    };
    this._write(rec);

    // Lazy require breaks the agentloop <-> agentcaps cycle.
    const { AgentLoop } = require('./agentloop');
    const controller = new AbortController();
    this.running.set(rec.id, controller);

    const system = [
      this.config.systemPrompt,
      '',
      `You are a SUBAGENT (depth ${rec.depth}) spawned by the MeshDirect lead agent to complete one specific task.`,
      'Do the task fully with the tools available, then reply with the result and what you verified.',
      'Your reply is consumed by the lead agent, not by a human: return findings and outcomes, not conversational filler.',
      depth + 1 >= MAX_SUBAGENT_DEPTH ? 'You are at the maximum nesting depth and cannot spawn further subagents.' : '',
    ].filter(Boolean).join('\n');

    const agent = new AgentLoop(this.config, this.log, {
      caps: this.caps,
      depth: rec.depth,
    });
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: brief },
    ];

    agent.run({
      modelId,
      messages,
      signal: controller.signal,
      onActivity: () => {},
      onProviderError: () => {},
      onFinalDelta: () => {},
      onDelta: () => {},
      takeSteering: () => [],
      setSteeringInterrupt: () => {},
    }).then((out) => {
      const done = this._record(rec.id);
      done.state = 'done';
      done.finishedAt = nowMs();
      done.result = str((out && (out.reply || out.content || out.text)) || '', 200000);
      done.usage = (out && out.usage) || null;
      done.toolCalls = (out && Array.isArray(out.tools)) ? out.tools.length : 0;
      this._write(done);
      this.running.delete(rec.id);
      this.log(`agentcaps: subagent ${rec.id} finished (${done.result.length} chars)`);
    }).catch((err) => {
      const failed = this._record(rec.id);
      failed.state = controller.signal.aborted ? 'cancelled' : 'error';
      failed.finishedAt = nowMs();
      failed.error = String((err && err.message) || err).slice(0, 4000);
      this._write(failed);
      this.running.delete(rec.id);
      this.log(`agentcaps: subagent ${rec.id} ${failed.state}: ${failed.error}`);
    });

    return {
      spawned: true, id: rec.id, label: rec.label, model: lane, depth: rec.depth,
      note: "Running detached. Poll with action='result' (it blocks briefly) or action='status'.",
    };
  }

  status({ id: sid }) {
    const rec = this._record(str(sid, 64));
    return {
      id: rec.id, label: rec.label, state: rec.state, model: rec.model, depth: rec.depth,
      createdAt: rec.createdAt, finishedAt: rec.finishedAt,
      elapsedMs: (rec.finishedAt || nowMs()) - rec.createdAt,
      resultChars: rec.result ? rec.result.length : 0, error: rec.error,
    };
  }

  /* Waits up to waitSeconds for completion so the agent can spawn-and-collect
     in one turn instead of busy-polling the model. */
  async result({ id: sid, wait = 0 }) {
    const key = str(sid, 64);
    const deadline = nowMs() + clampInt(wait, 0, 0, 600) * 1000;
    for (;;) {
      const rec = this._record(key);
      if (rec.state !== 'running' || nowMs() >= deadline) {
        return {
          id: rec.id, label: rec.label, state: rec.state,
          elapsedMs: (rec.finishedAt || nowMs()) - rec.createdAt,
          result: rec.result, error: rec.error, usage: rec.usage,
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  list({ limit = 30 }) {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
    const recs = files.map((f) => readJson(path.join(this.dir, f), null)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, clampInt(limit, 30, 1, 200));
    return {
      total: files.length,
      subagents: recs.map((r) => ({
        id: r.id, label: r.label, state: r.state, model: r.model, depth: r.depth,
        createdAt: r.createdAt, elapsedMs: (r.finishedAt || nowMs()) - r.createdAt,
        resultChars: r.result ? r.result.length : 0,
      })),
    };
  }

  cancel({ id: sid }) {
    const key = str(sid, 64);
    const controller = this.running.get(key);
    if (!controller) throw new MCPResponseError(`Subagent ${key} is not running`);
    controller.abort();
    return { cancelling: true, id: key };
  }
}

// ------------------------------------------------------------ self-cron

/* Self-scheduling. The agent decides when it wants to run again and the
   scheduler enqueues a real turn at that time, so a wake-up is indistinguishable
   from the owner sending a message. Survives restart via schedules.json. */
class SelfScheduler {
  constructor(config, log, dir) {
    this.config = config;
    this.log = log;
    this.file = path.join(dir, 'schedules.json');
    this.items = readJson(this.file, []);
    if (!Array.isArray(this.items)) this.items = [];
    this.jobs = null;
    this.timer = null;
  }

  /* app.js calls this once the JobManager exists (avoids a require cycle). */
  attach(jobs) {
    this.jobs = jobs;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 15000);
    this.timer.unref();
    const pending = this.items.filter((s) => s.enabled).length;
    this.log(`agentcaps: scheduler attached (${pending} active schedule${pending === 1 ? '' : 's'})`);
  }

  _save() { writeJson(this.file, this.items); }

  create({ prompt, delay_seconds, at, every_seconds, note = '', model = 'preview' }) {
    const body = str(prompt, 20000).trim();
    if (!body) throw new MCPResponseError('schedule.create needs the prompt to send yourself on wake-up');

    let nextRunAt = null;
    let everyMs = null;
    if (every_seconds !== undefined && every_seconds !== null && every_seconds !== '') {
      everyMs = clampInt(every_seconds, 3600, MIN_WAKE_SECONDS, MAX_WAKE_SECONDS) * 1000;
      nextRunAt = nowMs() + everyMs;
    } else if (at) {
      const when = Date.parse(String(at));
      if (!Number.isFinite(when)) throw new MCPResponseError("'at' must be an ISO-8601 timestamp");
      if (when <= nowMs()) throw new MCPResponseError("'at' must be in the future");
      nextRunAt = when;
    } else {
      const delay = clampInt(delay_seconds, 300, MIN_WAKE_SECONDS, MAX_WAKE_SECONDS);
      nextRunAt = nowMs() + delay * 1000;
    }

    const lane = this.config.lanes[model] ? model : 'preview';
    const item = {
      id: id('wake'), prompt: body, note: str(note, 500), model: lane,
      everyMs, nextRunAt, enabled: true,
      createdAt: nowMs(), lastRunAt: null, runs: 0, lastError: null,
    };
    this.items.push(item);
    this._save();
    this.log(`agentcaps: scheduled ${item.id} for ${new Date(nextRunAt).toISOString()}${everyMs ? ` (repeats every ${everyMs / 1000}s)` : ''}`);
    return {
      created: true, id: item.id, nextRunAt: new Date(nextRunAt).toISOString(),
      repeats: Boolean(everyMs), everySeconds: everyMs ? everyMs / 1000 : null,
    };
  }

  list() {
    return {
      total: this.items.length,
      attached: Boolean(this.jobs),
      schedules: this.items.map((s) => ({
        id: s.id, note: s.note, model: s.model, enabled: s.enabled,
        nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
        repeats: Boolean(s.everyMs), everySeconds: s.everyMs ? s.everyMs / 1000 : null,
        runs: s.runs, lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
        lastError: s.lastError, promptPreview: s.prompt.slice(0, 160),
      })),
    };
  }

  cancel({ id: sid }) {
    const key = str(sid, 64);
    const before = this.items.length;
    this.items = this.items.filter((s) => s.id !== key);
    if (this.items.length === before) throw new MCPResponseError(`No schedule ${key}`);
    this._save();
    return { cancelled: true, id: key };
  }

  runNow({ id: sid }) {
    const item = this.items.find((s) => s.id === str(sid, 64));
    if (!item) throw new MCPResponseError(`No schedule ${sid}`);
    const fired = this._fire(item);
    this._save();
    return { fired: fired.ok, id: item.id, jobId: fired.jobId || null, error: fired.error || null };
  }

  _fire(item) {
    if (!this.jobs) return { ok: false, error: 'scheduler not attached to the job manager' };
    try {
      const job = this.jobs.enqueue({
        ownerKey: this.config.username,
        model: item.model,
        message: item.prompt,
        attachments: [],
        clientTurnId: `${item.id}-${item.runs + 1}`,
      });
      item.runs += 1;
      item.lastRunAt = nowMs();
      item.lastError = null;
      this.log(`agentcaps: schedule ${item.id} woke the agent (job ${job.jobId})`);
      return { ok: true, jobId: job.jobId };
    } catch (err) {
      item.lastError = String((err && err.message) || err).slice(0, 500);
      this.log(`agentcaps: schedule ${item.id} failed to wake: ${item.lastError}`);
      return { ok: false, error: item.lastError };
    }
  }

  _tick() {
    const due = this.items.filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= nowMs());
    if (!due.length) return;
    for (const item of due) {
      this._fire(item);
      if (item.everyMs) item.nextRunAt = nowMs() + item.everyMs;
      else { item.enabled = false; item.nextRunAt = null; }
    }
    // Drop spent one-shots so the file does not grow without bound.
    this.items = this.items.filter((s) => s.enabled || (s.lastRunAt && nowMs() - s.lastRunAt < 86400000));
    this._save();
  }
}

// -------------------------------------------------------------- tool specs

const CAP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'memory',
      description: 'Your own persistent memory, on disk, surviving restarts and context resets. Use it whenever you learn something worth keeping: infrastructure facts, owner preferences, decisions and why you made them, and mistakes not to repeat.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remember', 'recall', 'search', 'list', 'forget'] },
          key: { type: 'string', description: 'Stable short name. Reusing a key overwrites that memory instead of duplicating it.' },
          text: { type: 'string', description: 'The content to remember.' },
          tags: { type: 'array', items: { type: 'string' } },
          query: { type: 'string', description: 'Free-text search for action=search.' },
          id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skills',
      description: 'Your skill library: markdown playbooks you write for yourself and read back later. Save a skill after working out how to do something non-obvious, so the next run does not re-derive it. The skill index is always in your system prompt; read one for the full text.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'save', 'delete'] },
          name: { type: 'string', description: 'Short skill name, e.g. promote-agillm-checkpoint.' },
          content: { type: 'string', description: 'Markdown body for action=save. First non-heading line is used as the description.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_servers',
      description: "Add and use MCP tool servers beyond the built-in sg1/sg2. action='add' registers a new server by URL (it is probed first and rejected if unreachable), then 'search' and 'call' work against it exactly like sg1/sg2. Registrations persist across restarts.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'test', 'search', 'call'] },
          name: { type: 'string', description: 'Registry name of the server.' },
          url: { type: 'string', description: 'JSON-RPC MCP endpoint URL, for action=add.' },
          note: { type: 'string' },
          tool: { type: 'string', description: 'Exact tool name for action=call.' },
          arguments: { type: 'object', additionalProperties: true },
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          timeout: { type: 'integer', minimum: 1, maximum: 450 },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'subagent',
      description: 'Spawn a subagent: a full nested agent with its own transcript and the same tools, to work a task in parallel while you continue. Use it to fan out independent work, or to isolate a long investigation from your own context. Spawn returns immediately; collect with action=result (set wait to block until it finishes).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['spawn', 'status', 'result', 'list', 'cancel'] },
          task: { type: 'string', description: 'Self-contained brief. The subagent cannot see your conversation, so include everything it needs.' },
          label: { type: 'string' },
          model: { type: 'string', enum: ['preview', 'stable'] },
          id: { type: 'string' },
          wait: { type: 'integer', minimum: 0, maximum: 600, description: 'For action=result: seconds to block waiting for completion.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule',
      description: 'Wake yourself up later. Creates a real turn at the chosen time with the prompt you supply, so you can come back to unfinished work, poll something that takes hours, or run a recurring check — without anyone asking. Use delay_seconds, an ISO timestamp in at, or every_seconds to repeat. Schedules survive restarts.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'cancel', 'run_now'] },
          prompt: { type: 'string', description: 'The message delivered to you on wake-up. Write it so a fresh turn has the context to act.' },
          delay_seconds: { type: 'integer', minimum: 30, description: 'Wake this many seconds from now.' },
          at: { type: 'string', description: 'ISO-8601 wake time, alternative to delay_seconds.' },
          every_seconds: { type: 'integer', minimum: 30, description: 'Repeat forever at this interval instead of firing once.' },
          note: { type: 'string' },
          model: { type: 'string', enum: ['preview', 'stable'] },
          id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
];

const CAP_TOOL_NAMES = new Set(CAP_TOOLS.map((t) => t.function.name));

// ---------------------------------------------------------------- gateway

class CapabilityGateway {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    const dir = config.stateDir || path.join(path.dirname(config.sessionsDir || '/opt/meshdirect/sessions'), 'state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.memory = new MemoryStore(dir);
    this.skills = new SkillStore(dir);
    this.mcp = new McpRegistry(dir, config, log);
    this.subagents = new SubagentRunner(config, log, dir, this);
    this.scheduler = new SelfScheduler(config, log, dir);
  }

  handles(name) { return CAP_TOOL_NAMES.has(name); }

  async execute(toolName, rawArgs, options = {}) {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (!action) throw new MCPResponseError(`${toolName} requires an 'action'`);

    switch (toolName) {
      case 'memory':
        if (action === 'remember') return this.memory.remember(args);
        if (action === 'recall') return this.memory.recall(args);
        if (action === 'search') return this.memory.search(args);
        if (action === 'list') return this.memory.list(args);
        if (action === 'forget') return this.memory.forget(args);
        break;
      case 'skills':
        if (action === 'list') return this.skills.list();
        if (action === 'read') return this.skills.read(args);
        if (action === 'save') return this.skills.save(args);
        if (action === 'delete') return this.skills.delete(args);
        break;
      case 'mcp_servers':
        if (action === 'list') return this.mcp.list();
        if (action === 'add') return this.mcp.add(args);
        if (action === 'remove') return this.mcp.remove(args);
        if (action === 'test') return this.mcp.test(args);
        if (action === 'search') return this.mcp.search(args);
        if (action === 'call') return this.mcp.call(args, options);
        break;
      case 'subagent':
        if (action === 'spawn') return this.subagents.spawn({ ...args, depth: options.depth || 0 });
        if (action === 'status') return this.subagents.status(args);
        if (action === 'result') return this.subagents.result(args);
        if (action === 'list') return this.subagents.list(args);
        if (action === 'cancel') return this.subagents.cancel(args);
        break;
      case 'schedule':
        if (action === 'create') return this.scheduler.create(args);
        if (action === 'list') return this.scheduler.list();
        if (action === 'cancel') return this.scheduler.cancel(args);
        if (action === 'run_now') return this.scheduler.runNow(args);
        break;
      default:
        throw new MCPResponseError(`Unknown capability tool ${toolName}`);
    }
    throw new MCPResponseError(`Unsupported action '${action}' for ${toolName}`);
  }

  /* Appended to the system prompt each turn so the agent knows, without
     spending a tool call, what it already remembers and which skills exist. */
  promptContext() {
    const parts = [];
    const skillIndex = this.skills.index();
    if (skillIndex) parts.push(`Your saved skills (read one with the skills tool for the full playbook):\n${skillIndex}`);
    const memDigest = this.memory.digest(20);
    if (memDigest) parts.push(`Your most recent memories:\n${memDigest}`);
    try {
      const extra = this.mcp.list();
      if (extra.total) parts.push(`MCP servers you have registered beyond sg1/sg2: ${extra.servers.map((s) => s.name).join(', ')}`);
    } catch { /* registry unreadable: prompt simply omits it */ }
    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
  }
}

module.exports = {
  CAP_TOOLS,
  CAP_TOOL_NAMES,
  CapabilityGateway,
  MemoryStore,
  SkillStore,
  McpRegistry,
  SubagentRunner,
  SelfScheduler,
};
