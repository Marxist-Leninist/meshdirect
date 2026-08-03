// Per-model job lanes plus the MeshDirect autonomous agent loop.
'use strict';
const { randomToken, sanitizeError, classifyStatus } = require('./util');
const sessions = require('./sessions');
const { runAgent } = require('./agentloop');

const JOB_STATES = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', ERROR: 'error' };

class JobManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.jobs = new Map();
    this.lanes = {
      preview: { running: null, queue: [] },
      stable: { running: null, queue: [] },
    };
    this.live = {
      preview: this._freshLive(),
      stable: this._freshLive(),
    };
    const timer = setInterval(() => this._reap(), 60000);
    timer.unref();
  }

  _freshLive() {
    return {
      providerErrors: 0,
      latestError: '',
      lastError: null,
      abortedLastRun: false,
      lastActivity: 'waiting',
      lastActivityAt: null,
      steps: 0,
      toolCalls: 0,
      currentTool: null,
      recentTools: [],
    };
  }

  _reap() {
    const cutoff = Date.now() - this.config.jobRetentionMs;
    for (const [id, job] of this.jobs) {
      if ((job.state === JOB_STATES.DONE || job.state === JOB_STATES.ERROR) && job.finishedAt && job.finishedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  enqueue({ ownerKey, model, message }) {
    const lane = this.lanes[model];
    if (!lane) { const error = new Error('Invalid model'); error.status = 400; throw error; }
    if (lane.queue.length >= this.config.maxQueuePerLane) {
      const error = new Error('Too many turns waiting for this model');
      error.status = 429;
      throw error;
    }
    const job = {
      jobId: randomToken(24),
      ownerKey,
      model,
      sessionId: 'main',
      message,
      state: JOB_STATES.QUEUED,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      reply: '',
      error: null,
      usage: null,
      provider: null,
      status: null,
      abort: null,
      listeners: new Set(),
      tools: [],
      step: 0,
      toolCalls: 0,
      activity: 'queued',
    };
    this.jobs.set(job.jobId, job);
    if (lane.running) lane.queue.push(job);
    else this._start(job);
    return job;
  }

  queuePosition(job) {
    if (job.state !== JOB_STATES.QUEUED) return 0;
    return this.lanes[job.model].queue.indexOf(job) + 1 || 0;
  }

  publicView(job) {
    const now = Date.now();
    const view = {
      jobId: job.jobId,
      state: job.state,
      model: job.model,
      sessionId: job.sessionId,
      queuePosition: this.queuePosition(job),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: (job.finishedAt || now) - job.createdAt,
      durationMs: job.startedAt ? (job.finishedAt || now) - job.startedAt : null,
      activity: job.activity,
      step: job.step,
      toolCalls: job.toolCalls,
      tools: job.tools.slice(-30),
    };
    if (job.state === JOB_STATES.DONE) {
      view.reply = job.reply;
      if (job.usage) view.usage = job.usage;
    }
    if (job.state === JOB_STATES.ERROR) view.error = job.error;
    return view;
  }

  getOwned(jobId, ownerKey) {
    const job = this.jobs.get(jobId);
    if (!job || job.ownerKey !== ownerKey) return null;
    return job;
  }

  _emit(job, event, data) {
    for (const listener of job.listeners) {
      try { listener(event, data); } catch { /* disconnected listener */ }
    }
  }
  subscribe(job, listener) {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  laneSnapshot(model) {
    const lane = this.lanes[model];
    return {
      running: lane.running ? {
        sessionId: 'main',
        elapsedMs: Date.now() - (lane.running.startedAt || Date.now()),
        activity: lane.running.activity,
        step: lane.running.step,
        toolCalls: lane.running.toolCalls,
        currentTool: this.live[model].currentTool,
      } : null,
      queued: lane.queue.length,
    };
  }

  _buildMessages(model) {
    const config = this.config;
    const history = sessions.readMessages(config, model, 'main', config.historyContextMessages)
      .filter((message) => !message.failed && (message.role === 'user' || message.role === 'assistant'));
    const chosen = [];
    let chars = config.systemPrompt.length;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (chars + message.content.length > config.historyContextMaxChars && chosen.length) break;
      chosen.push({ role: message.role, content: message.content });
      chars += message.content.length;
    }
    chosen.reverse();
    return [{ role: 'system', content: config.systemPrompt }, ...chosen];
  }

  async _start(job) {
    const config = this.config;
    const lane = this.lanes[job.model];
    const live = this.live[job.model];
    lane.running = job;
    job.state = JOB_STATES.RUNNING;
    job.startedAt = Date.now();
    job.activity = 'thinking';
    live.lastActivity = 'thinking';
    live.lastActivityAt = Date.now();
    live.steps = 0;
    live.toolCalls = 0;
    live.currentTool = null;
    live.recentTools = [];
    this._emit(job, 'status', { state: 'running', elapsedMs: 0, activity: job.activity, step: 0, toolCalls: 0 });
    this._broadcastQueue(job.model);

    const abortController = new AbortController();
    job.abort = abortController;
    const turnCap = setTimeout(() => abortController.abort(new Error('turn cap exceeded')), config.turnTimeoutMs);
    const userRow = sessions.appendMessage(config, job.model, 'main', { role: 'user', content: job.message });

    try {
      const output = await runAgent(config, job.model, this._buildMessages(job.model), {
        signal: abortController.signal,
        onDelta: (text) => {
          live.lastActivity = 'writing';
          live.lastActivityAt = Date.now();
          job.activity = 'writing reply';
          job.reply += text;
          this._emit(job, 'delta', { text });
        },
        onProgress: (progress) => {
          job.activity = progress.activity || progress.phase || 'running';
          job.step = Number.isFinite(progress.step) ? progress.step : job.step;
          job.toolCalls = Number.isFinite(progress.totalToolCalls) ? progress.totalToolCalls : job.toolCalls;
          live.lastActivity = job.activity;
          live.lastActivityAt = Date.now();
          live.steps = job.step;
          live.toolCalls = job.toolCalls;
          live.currentTool = progress.currentTool || null;
          this._emit(job, 'status', {
            state: 'running',
            elapsedMs: Date.now() - job.startedAt,
            activity: job.activity,
            phase: progress.phase,
            step: job.step,
            toolCalls: job.toolCalls,
            currentTool: live.currentTool,
          });
        },
        onTool: (toolEvent) => {
          const existing = job.tools.find((tool) => tool.id === toolEvent.id);
          if (existing) Object.assign(existing, toolEvent);
          else job.tools.push({ ...toolEvent });
          live.recentTools = job.tools.slice(-8).map((tool) => ({
            name: tool.name,
            label: tool.label,
            status: tool.status,
            summary: tool.summary || '',
            durationMs: tool.durationMs,
          }));
          live.currentTool = toolEvent.phase === 'start' ? toolEvent.name : null;
          this._emit(job, 'tool', toolEvent);
        },
        onProviderError: (provider, status, message) => {
          live.providerErrors += 1;
          live.latestError = message;
          live.lastActivity = 'retrying provider';
          live.lastActivityAt = Date.now();
          job.activity = 'retrying provider';
          this.log(`provider error [${job.model}/${provider}] HTTP ${status}: ${message}`);
          this._emit(job, 'status', {
            state: 'running',
            activity: job.activity,
            step: job.step,
            toolCalls: job.toolCalls,
            providerError: message,
          });
        },
      });

      clearTimeout(turnCap);
      job.reply = output.reply || job.reply;
      job.usage = output.usage || null;
      job.provider = output.provider || null;
      job.tools = output.tools || job.tools;
      job.step = output.steps || job.step;
      job.toolCalls = output.toolCalls || job.toolCalls;
      job.state = JOB_STATES.DONE;
      job.finishedAt = Date.now();
      job.activity = output.limitReached ? 'step limit reached' : 'done';
      live.lastActivity = 'waiting';
      live.lastActivityAt = Date.now();
      live.abortedLastRun = false;
      live.currentTool = null;
      live.steps = job.step;
      live.toolCalls = job.toolCalls;
      live.recentTools = job.tools.slice(-8);
      sessions.appendMessage(config, job.model, 'main', {
        role: 'assistant',
        content: job.reply,
        usage: job.usage || undefined,
        tools: job.tools.map((tool) => ({
          name: tool.name,
          label: tool.label,
          status: tool.status,
          summary: tool.summary,
          durationMs: tool.durationMs,
        })),
        agent: { steps: job.step, toolCalls: job.toolCalls, provider: job.provider },
      });
      this._emit(job, 'done', {
        reply: job.reply,
        usage: job.usage || undefined,
        elapsedMs: job.finishedAt - job.createdAt,
        tools: job.tools,
        steps: job.step,
        toolCalls: job.toolCalls,
      });
    } catch (error) {
      clearTimeout(turnCap);
      const aborted = abortController.signal.aborted || (error && error.status === 499);
      const clean = sanitizeError(aborted ? 'Turn aborted' : (error && error.message));
      job.error = clean;
      job.status = aborted ? 499 : classifyStatus(clean);
      job.state = JOB_STATES.ERROR;
      job.finishedAt = Date.now();
      job.activity = aborted ? 'aborted' : 'failed';
      live.lastActivity = 'waiting';
      live.lastActivityAt = Date.now();
      live.abortedLastRun = aborted;
      live.currentTool = null;
      live.lastError = { error: clean, at: new Date().toISOString() };
      sessions.markFailed(config, job.model, 'main', userRow.id);
      if (job.reply) {
        sessions.appendMessage(config, job.model, 'main', {
          role: 'assistant',
          content: `${job.reply}\n\n[turn ${aborted ? 'aborted' : 'failed'}]`,
          failed: true,
          tools: job.tools,
        });
      }
      this._emit(job, 'error', { error: clean, status: job.status, tools: job.tools });
    } finally {
      lane.running = null;
      job.abort = null;
      const next = lane.queue.shift();
      if (next) this._start(next);
      this._broadcastQueue(job.model);
    }
  }

  _broadcastQueue(model) {
    const lane = this.lanes[model];
    lane.queue.forEach((job, index) => {
      this._emit(job, 'status', {
        state: 'queued',
        queuePosition: index + 1,
        elapsedMs: Date.now() - job.createdAt,
        activity: 'queued',
        step: 0,
        toolCalls: 0,
      });
    });
  }

  abortJob(job) {
    if (job.state === JOB_STATES.QUEUED) {
      const lane = this.lanes[job.model];
      const index = lane.queue.indexOf(job);
      if (index >= 0) lane.queue.splice(index, 1);
      job.state = JOB_STATES.ERROR;
      job.error = 'Turn aborted';
      job.status = 499;
      job.finishedAt = Date.now();
      job.activity = 'aborted';
      this.live[job.model].abortedLastRun = true;
      this._emit(job, 'error', { error: job.error, status: 499, tools: job.tools });
      return true;
    }
    if (job.state === JOB_STATES.RUNNING && job.abort) {
      job.abort.abort();
      return true;
    }
    return false;
  }
}

module.exports = { JobManager, JOB_STATES };
