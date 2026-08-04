// job lanes: one running job plus a configurable server queue per model; SSE fan-out
'use strict';
const { randomToken, sanitizeError, classifyStatus } = require('./util');
const sessions = require('./sessions');
const { AgentLoop } = require('./agentloop');

const JOB_STATES = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', ERROR: 'error' };

class JobManager {
  constructor(config, log, dependencies = {}) {
    this.config = config;
    this.log = log;
    this.agent = dependencies.agent || new AgentLoop(config, log, dependencies);
    this.jobs = new Map(); // jobId -> job
    this.turnIndex = new Map(); // ownerKey + clientTurnId -> jobId
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
    return {
      providerErrors: 0,
      latestError: '',
      lastError: null,
      abortedLastRun: false,
      lastActivity: 'waiting',
      lastActivityAt: null,
      steps: 0,
      toolCalls: 0,
      recentTools: [],
    };
  }

  _reap() {
    const cutoff = Date.now() - this.config.jobRetentionMs;
    for (const [id, j] of this.jobs) {
      if ((j.state === JOB_STATES.DONE || j.state === JOB_STATES.ERROR) && j.finishedAt && j.finishedAt < cutoff) {
        if (j.dedupeKey && this.turnIndex.get(j.dedupeKey) === id) this.turnIndex.delete(j.dedupeKey);
        this.jobs.delete(id);
      }
    }
  }

  enqueue({ ownerKey, model, message, attachments = [], clientTurnId = '' }) {
    const dedupeKey = clientTurnId ? `${ownerKey}:${clientTurnId}` : '';
    if (dedupeKey) {
      const existingId = this.turnIndex.get(dedupeKey);
      const existing = existingId && this.jobs.get(existingId);
      if (existing) return existing;
      if (existingId) this.turnIndex.delete(dedupeKey);
      const durable = sessions.findTurnByClient(this.config, clientTurnId, ownerKey);
      if (durable) return this._durableJob(durable, ownerKey, clientTurnId);
    }
    const lane = this.lanes[model];
    if (lane.queue.length >= this.config.maxQueuePerLane) {
      const err = new Error('Too many turns waiting for this model');
      err.status = 429;
      throw err;
    }
    const job = {
      jobId: randomToken(24),
      ownerKey, model, sessionId: 'main', message, attachments, clientTurnId, dedupeKey,
      state: JOB_STATES.QUEUED,
      createdAt: Date.now(), startedAt: null, finishedAt: null,
      reply: '', error: null, usage: null, status: null, outputRevision: 0,
      abort: null, listeners: new Set(), tools: [], activity: 'Waiting', steering: [],
      acceptingSteering: false,
    };
    this.jobs.set(job.jobId, job);
    if (dedupeKey) this.turnIndex.set(dedupeKey, job.jobId);
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
      userMessageId: job.userMessageId || null,
      clientTurnId: job.clientTurnId || null,
      message: job.message,
      tools: job.tools.slice(-20),
      activity: job.activity,
      outputRevision: Number.isSafeInteger(job.outputRevision) ? job.outputRevision : 0,
      steering: Array.isArray(job.steering) ? {
        pending: job.steering.filter((item) => item.state === 'pending').length,
        applied: job.steering.filter((item) => item.state === 'applied').length,
        notApplied: job.steering.filter((item) => item.state === 'not-applied').length,
        items: job.steering.slice(-20).map((item) => ({
          id: item.id,
          clientSteerId: item.clientSteerId || null,
          clientSteeringId: item.clientSteerId || null,
          state: item.state,
          createdAt: item.createdAt,
          appliedAt: item.appliedAt || null,
        })),
      } : { pending: 0, applied: 0, notApplied: 0, items: [] },
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

  getByClient(clientTurnId, ownerKey) {
    const id = this.turnIndex.get(`${ownerKey}:${clientTurnId}`);
    const active = id ? this.getOwned(id, ownerKey) : null;
    if (active) return active;
    const durable = sessions.findTurnByClient(this.config, clientTurnId, ownerKey);
    return durable ? this._durableJob(durable, ownerKey, clientTurnId) : null;
  }

  _normaliseSteeringId(clientSteerId) {
    const cleanId = typeof clientSteerId === 'string' ? clientSteerId.trim() : '';
    if (!cleanId) return `steer_${randomToken(18)}`;
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(cleanId)) {
      const error = new Error('Invalid steering request id');
      error.status = 400;
      throw error;
    }
    return cleanId;
  }

  _trimSteering(job) {
    if (!Array.isArray(job.steering) || job.steering.length <= 240) return;
    const pending = job.steering.filter((item) => item.state === 'pending');
    const settled = job.steering.filter((item) => item.state !== 'pending').slice(-200);
    job.steering = [...settled, ...pending].sort((a, b) => a.createdAt - b.createdAt);
  }

  steerJob(job, message, clientSteerId = '') {
    const clean = typeof message === 'string' ? message.trim() : '';
    if (!clean || clean.length > 12000 || clean.includes('\0')) {
      const error = new Error('Invalid steering message');
      error.status = 400;
      throw error;
    }
    const cleanId = this._normaliseSteeringId(clientSteerId);
    if (!job) {
      const error = new Error('That turn is no longer tracked');
      error.status = 404;
      throw error;
    }
    if (!Array.isArray(job.steering)) job.steering = [];

    // Network retries remain idempotent even if the turn completed after the
    // first request was accepted. This prevents a successful instruction from
    // being mistaken for a new queued turn merely because the response packet
    // took the scenic route through the internet.
    const existing = job.steering.find((item) => item.clientSteerId === cleanId);
    if (existing) {
      if (existing.message !== clean) {
        const error = new Error('That steering request id was already used for different text');
        error.status = 409;
        throw error;
      }
      return { ...existing, duplicate: true };
    }

    if (job.state !== JOB_STATES.RUNNING) {
      const error = new Error('That turn is no longer running. Queue the message as the next turn instead.');
      error.status = 409;
      throw error;
    }

    const entry = {
      id: randomToken(18),
      clientSteerId: cleanId,
      message: clean,
      state: 'pending',
      createdAt: Date.now(),
      appliedAt: null,
      duplicate: false,
    };
    job.steering.push(entry);
    job.activity = 'Steering accepted; waiting for the next safe boundary';
    this._emit(job, 'steer', {
      id: entry.id,
      clientSteerId: entry.clientSteerId,
      clientSteeringId: entry.clientSteerId,
      state: 'accepted',
      createdAt: entry.createdAt,
      pending: job.steering.filter((item) => item.state === 'pending').length,
      applied: job.steering.filter((item) => item.state === 'applied').length,
      resetOutput: false,
    });
    return entry;
  }

  _takeSteering(job, meta = {}) {
    if (!Array.isArray(job.steering)) return [];
    const pending = job.steering.filter((item) => item.state === 'pending');
    if (!pending.length) return [];
    const appliedAt = Date.now();
    for (const item of pending) {
      item.state = 'applied';
      item.appliedAt = appliedAt;
    }
    const resetOutput = !!meta.resetOutput || !!job.reply;
    if (resetOutput) job.reply = '';
    job.activity = resetOutput
      ? 'Applying steering and revising the reply'
      : 'Applying steering at the next model step';
    this._emit(job, 'steer', {
      ids: pending.map((item) => item.id),
      count: pending.length,
      state: 'applied',
      appliedAt,
      round: Number.isSafeInteger(meta.round) ? meta.round : undefined,
      phase: typeof meta.phase === 'string' ? meta.phase : undefined,
      resetOutput,
      pending: 0,
      applied: job.steering.filter((item) => item.state === 'applied').length,
      notApplied: job.steering.filter((item) => item.state === 'not-applied').length,
    });
    this._trimSteering(job);
    return pending.map((item) => ({
      id: item.id,
      clientSteerId: item.clientSteerId,
      message: item.message,
      createdAt: item.createdAt,
    }));
  }

  _markPendingSteeringNotApplied(job, reason) {
    if (!Array.isArray(job.steering)) return;
    const pending = job.steering.filter((item) => item.state === 'pending');
    if (!pending.length) return;
    const at = Date.now();
    for (const item of pending) {
      item.state = 'not-applied';
      item.appliedAt = at;
    }
    this._emit(job, 'steer', {
      ids: pending.map((item) => item.id),
      count: pending.length,
      state: 'not-applied',
      appliedAt: at,
      reason,
      pending: 0,
      applied: job.steering.filter((item) => item.state === 'applied').length,
      notApplied: job.steering.filter((item) => item.state === 'not-applied').length,
      resetOutput: false,
    });
    this._trimSteering(job);
  }

  _durableJob(record, ownerKey, clientTurnId) {
    const completed = record.assistant && !record.assistant.failed;
    const createdAt = Number(record.user.timestamp) || Date.now();
    const finishedAt = Number(record.assistant && record.assistant.timestamp) || createdAt;
    return {
      jobId: `durable-${clientTurnId}`,
      ownerKey,
      model: record.model,
      sessionId: 'main',
      message: record.user.content,
      clientTurnId,
      state: completed ? JOB_STATES.DONE : JOB_STATES.ERROR,
      createdAt,
      startedAt: createdAt,
      finishedAt,
      userMessageId: record.user.id,
      reply: completed ? record.assistant.content : '',
      error: completed ? null : 'This accepted turn ended without a reply and will not be replayed automatically.',
      status: completed ? 200 : 409,
      usage: completed ? (record.assistant.usage || null) : null,
      tools: completed && Array.isArray(record.assistant.tools) ? record.assistant.tools : [],
      activity: completed ? 'Reply complete' : 'Turn safely closed',
      attachments: [],
      listeners: new Set(),
      abort: null,
      steering: [],
      durable: true,
    };
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
    live.steps = 0;
    live.toolCalls = 0;
    live.recentTools = [];
    live.latestError = '';
    live.lastError = null;
    job.activity = 'Qwen is deciding the next step';
    this._emit(job, 'status', { state: 'running', elapsedMs: 0 });
    this._broadcastQueue(job.model);

    const ac = new AbortController();
    job.abort = ac;
    const turnCap = Number(cfg.turnTimeoutMs) > 0
      ? setTimeout(() => ac.abort(new Error('turn cap exceeded')), cfg.turnTimeoutMs)
      : null;

    let userRow = null;
    let savedAttachments = [];
    try {
      // Persist before the provider call so accepted turns never disappear.
      savedAttachments = sessions.saveImages(cfg, job.attachments);
      job.savedAttachments = savedAttachments;
      userRow = sessions.appendMessage(cfg, job.model, 'main', {
        role: 'user', content: job.message, attachments: savedAttachments, pending: true,
        clientTurnId: job.clientTurnId, ownerKey: job.ownerKey,
      });
      job.userMessageId = userRow.id;
      const history = sessions.readMessages(cfg, job.model, 'main', cfg.historyContextMessages);
      const messages = [{ role: 'system', content: cfg.systemPrompt }];
      let chars = cfg.systemPrompt.length;
      const selected = [];
      // Keep the newest contiguous context. Iterating oldest-first could fill
      // the budget before reaching the current user turn.
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const m = history[index];
        if (m.failed) continue; // never re-answer turns that errored/aborted
        if (chars + m.content.length > cfg.historyContextMaxChars) break;
        selected.push(m);
        chars += m.content.length;
      }
      selected.reverse();
      const priorImageRow = [...selected].reverse().find((m) => (
        m.id !== userRow.id && m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length
      ));
      for (const m of selected) {
        let content = m.content;
        if (m.id === userRow.id && job.attachments.length) {
          content = [
            { type: 'text', text: m.content },
            ...job.attachments.map((attachment) => ({
              type: 'image_url',
              image_url: { url: `data:${attachment.mimeType};base64,${attachment.content}` },
            })),
          ];
        } else if (priorImageRow && m.id === priorImageRow.id) {
          let imageBytes = 0;
          const priorImages = [];
          for (const reference of m.attachments.slice(0, 4)) {
            const image = sessions.readImageData(cfg, reference.id);
            if (!image || imageBytes + image.size > 12 * 1024 * 1024) continue;
            imageBytes += image.size;
            priorImages.push({
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.content}` },
            });
          }
          if (priorImages.length) content = [{ type: 'text', text: m.content }, ...priorImages];
        }
        messages.push({ role: m.role, content });
      }
      // The provider message now owns copies of any base64 strings it needs;
      // release the queue payload before a potentially long model/tool turn.
      job.attachments = [];
      // Live token streaming: every pass streams its visible text (tool markup
      // is filtered out in modelclient), so the browser sees interstitial text
      // between tool rounds and the final answer token-by-token. onFinalDelta
      // still delivers the authoritative reply; it only emits when nothing was
      // streamed (edge case) so the browser never renders the answer twice.
      let streamedAny = false;
      const out = await this.agent.run({
        modelId: cfg.lanes[job.model].modelId,
        messages,
        signal: ac.signal,
        takeSteering: (meta) => {
          const steering = this._takeSteering(job, meta);
          if (steering.length) streamedAny = false;
          return steering;
        },
        onDelta: (text) => {
          streamedAny = true;
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
        onActivity: (event) => {
          live.lastActivityAt = Date.now();
          live.lastActivity = event.phase === 'tool' ? 'using tools' : event.status === 'retrying' ? 'retrying' : 'thinking';
          if (Number.isSafeInteger(event.round)) live.steps = Math.max(live.steps, event.round);
          if (Number.isSafeInteger(event.toolCount)) live.toolCalls = Math.max(live.toolCalls, event.toolCount);
          if (event.tool) {
            live.recentTools = [event.tool, ...live.recentTools.filter((item) => item !== event.tool)].slice(0, 8);
            const existing = job.tools.find((item) => item.label === event.tool && item.status === 'running');
            if (existing) existing.status = event.status;
            else if (event.status === 'running') {
              job.tools.push({ label: event.tool, status: 'running', time: new Date().toISOString() });
            }
            job.tools = job.tools.slice(-20);
          }
          job.activity = event.label || job.activity;
          this._emit(job, 'activity', event);
        },
        onFinalDelta: (text) => {
          live.lastActivity = 'writing';
          live.lastActivityAt = Date.now();
          job.reply = text;
          if (!streamedAny) this._emit(job, 'delta', { text });
        },
      });
      clearTimeout(turnCap);
      job.reply = out.reply;
      job.tools = out.tools || [];
      job.usage = out.usage || null;
      this._markPendingSteeringNotApplied(job, 'Turn completed before steering could be applied');
      job.state = JOB_STATES.DONE;
      job.finishedAt = Date.now();
      live.lastActivity = 'waiting';
      live.abortedLastRun = false;
      sessions.appendMessage(cfg, job.model, 'main', {
        role: 'assistant', content: out.reply, usage: out.usage || undefined, tools: job.tools,
        turnId: userRow.id,
      });
      sessions.markCompleted(cfg, job.model, 'main', userRow.id);
      this._emit(job, 'done', {
        reply: out.reply,
        usage: job.usage || undefined,
        tools: job.tools,
        elapsedMs: job.finishedAt - job.createdAt,
      });
    } catch (e) {
      clearTimeout(turnCap);
      const timedOut = ac.signal.aborted && ac.signal.reason && ac.signal.reason.message === 'turn cap exceeded';
      const aborted = !timedOut && (ac.signal.aborted || (e && e.status === 499));
      const clean = sanitizeError(timedOut ? 'Turn timed out' : aborted ? 'Turn aborted' : (e && e.message));
      job.error = clean;
      job.status = timedOut ? 504 : aborted ? 499 : classifyStatus(clean);
      this._markPendingSteeringNotApplied(job, clean);
      job.state = JOB_STATES.ERROR;
      job.finishedAt = Date.now();
      live.lastActivity = 'waiting';
      live.abortedLastRun = aborted || timedOut;
      live.lastError = { error: clean, at: new Date().toISOString() };
      // tag the unanswered user turn as failed so it is never re-answered by a later turn
      if (userRow) {
        try { sessions.markFailed(cfg, job.model, 'main', userRow.id); }
        catch (markError) { this.log(`failed to mark user turn ${userRow.id}: ${sanitizeError(markError.message)}`); }
      }
      if (!userRow && savedAttachments.length) sessions.deleteImages(cfg, savedAttachments);
      if (aborted && job.reply) {
        sessions.appendMessage(cfg, job.model, 'main', { role: 'assistant', content: job.reply + '\n\n[aborted]', failed: true });
      }
      this._emit(job, 'error', { error: clean, status: job.status });
    } finally {
      job.attachments = [];
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
      job.attachments = [];
      job.state = JOB_STATES.ERROR;
      job.error = 'Turn aborted';
      job.status = 499;
      job.finishedAt = Date.now();
      this.live[job.model].abortedLastRun = true;
      this._emit(job, 'error', { error: job.error, status: 499 });
      this._broadcastQueue(job.model);
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