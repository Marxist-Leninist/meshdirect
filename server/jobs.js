// job lanes: 1 running + up to 2 queued per model; in-memory jobs; SSE fan-out
'use strict';
const { randomToken, sanitizeError, classifyStatus } = require('./util');
const sessions = require('./sessions');
const modelclient = require('./modelclient');

const JOB_STATES = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', ERROR: 'error' };

class JobManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.jobs = new Map(); // jobId -> job
    this.lanes = {
      preview: { running: null, queue: [] },
      stable: { running: null, queue: [] },
    };
    // live per-model observability for /state
    this.live = {
      preview: this._freshLive(),
      stable: this._freshLive(),
    };
    const t = setInterval(() => this._reap(), 60000);
    t.unref();
  }

  _freshLive() {
    return { providerErrors: 0, latestError: '', lastError: null, abortedLastRun: false, lastActivity: 'waiting', lastActivityAt: null };
  }

  _reap() {
    const cutoff = Date.now() - this.config.jobRetentionMs;
    for (const [id, j] of this.jobs) {
      if ((j.state === JOB_STATES.DONE || j.state === JOB_STATES.ERROR) && j.finishedAt && j.finishedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  enqueue({ ownerKey, model, message }) {
    const lane = this.lanes[model];
    if (lane.queue.length >= this.config.maxQueuePerLane) {
      const err = new Error('Too many turns waiting for this model');
      err.status = 429;
      throw err;
    }
    const job = {
      jobId: randomToken(24),
      ownerKey, model, sessionId: 'main', message,
      state: JOB_STATES.QUEUED,
      createdAt: Date.now(), startedAt: null, finishedAt: null,
      reply: '', error: null, usage: null, status: null,
      abort: null, listeners: new Set(),
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
    const v = {
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
      tools: [],
    };
    if (job.state === JOB_STATES.DONE) v.reply = job.reply;
    if (job.state === JOB_STATES.ERROR) v.error = job.error;
    return v;
  }

  getOwned(jobId, ownerKey) {
    const j = this.jobs.get(jobId);
    if (!j || j.ownerKey !== ownerKey) return null;
    return j;
  }

  // --- SSE fan-out -------------------------------------------------------------
  _emit(job, event, data) {
    for (const fn of job.listeners) {
      try { fn(event, data); } catch { /* listener gone */ }
    }
  }
  subscribe(job, fn) { job.listeners.add(fn); return () => job.listeners.delete(fn); }

  laneSnapshot(model) {
    const lane = this.lanes[model];
    return {
      running: lane.running ? { sessionId: 'main', elapsedMs: Date.now() - (lane.running.startedAt || Date.now()) } : null,
      queued: lane.queue.length,
    };
  }

  // --- execution ---------------------------------------------------------------
  async _start(job) {
    const cfg = this.config;
    const lane = this.lanes[job.model];
    lane.running = job;
    job.state = JOB_STATES.RUNNING;
    job.startedAt = Date.now();
    const live = this.live[job.model];
    live.lastActivity = 'thinking';
    live.lastActivityAt = Date.now();
    this._emit(job, 'status', { state: 'running', elapsedMs: 0 });
    this._broadcastQueue(job.model);

    const ac = new AbortController();
    job.abort = ac;
    const turnCap = setTimeout(() => ac.abort(new Error('turn cap exceeded')), cfg.turnTimeoutMs);

    // persist user message immediately (parity: transcript shows the user turn)
    sessions.appendMessage(cfg, job.model, 'main', { role: 'user', content: job.message });

    try {
      const history = sessions.readMessages(cfg, job.model, 'main', cfg.historyContextMessages);
      const messages = [{ role: 'system', content: cfg.systemPrompt }];
      let chars = cfg.systemPrompt.length;
      for (const m of history) {
        if (chars + m.content.length > cfg.historyContextMaxChars) break;
        messages.push({ role: m.role, content: m.content });
        chars += m.content.length;
      }
      const out = await modelclient.runChat(cfg, cfg.lanes[job.model].modelId, messages, {
        signal: ac.signal,
        onDelta: (text) => {
          live.lastActivity = 'writing';
          live.lastActivityAt = Date.now();
          job.reply += text;
          this._emit(job, 'delta', { text });
        },
        onProviderError: (provider, status, msg) => {
          live.providerErrors += 1;
          live.latestError = msg;
          live.lastActivity = 'retrying';
          this.log(`provider error [${job.model}/${provider}] HTTP ${status}: ${msg}`);
        },
      });
      clearTimeout(turnCap);
      job.reply = out.reply;
      job.usage = out.usage || null;
      job.state = JOB_STATES.DONE;
      job.finishedAt = Date.now();
      live.lastActivity = 'waiting';
      live.abortedLastRun = false;
      sessions.appendMessage(cfg, job.model, 'main', { role: 'assistant', content: out.reply, usage: out.usage || undefined });
      this._emit(job, 'done', { reply: out.reply, usage: job.usage || undefined, elapsedMs: job.finishedAt - job.createdAt });
    } catch (e) {
      clearTimeout(turnCap);
      const aborted = ac.signal.aborted || (e && e.status === 499);
      const clean = sanitizeError(aborted ? 'Turn aborted' : (e && e.message));
      job.error = clean;
      job.status = aborted ? 499 : classifyStatus(clean);
      job.state = JOB_STATES.ERROR;
      job.finishedAt = Date.now();
      live.lastActivity = 'waiting';
      live.abortedLastRun = aborted;
      live.lastError = { error: clean, at: new Date().toISOString() };
      if (aborted && job.reply) {
        sessions.appendMessage(cfg, job.model, 'main', { role: 'assistant', content: job.reply + '\n\n[aborted]' });
      }
      this._emit(job, 'error', { error: clean, status: job.status });
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
    lane.queue.forEach((j, i) => {
      this._emit(j, 'status', { state: 'queued', queuePosition: i + 1, elapsedMs: Date.now() - j.createdAt });
    });
  }

  abortJob(job) {
    if (job.state === JOB_STATES.QUEUED) {
      const lane = this.lanes[job.model];
      const i = lane.queue.indexOf(job);
      if (i >= 0) lane.queue.splice(i, 1);
      job.state = JOB_STATES.ERROR;
      job.error = 'Turn aborted';
      job.status = 499;
      job.finishedAt = Date.now();
      this.live[job.model].abortedLastRun = true;
      this._emit(job, 'error', { error: job.error, status: 499 });
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
