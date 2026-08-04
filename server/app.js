// express app: drop-in qwen38 API + SSE streaming + static dist serving
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { initAuth } = require('./auth');
const { initWebAuthn } = require('./webauthn');
const { makeLimiter, byIp, bySession } = require('./ratelimit');
const { JobManager } = require('./jobs');
const state = require('./state');
const sessions = require('./sessions');
const { ImageValidationError, normalizeImages } = require('./images');
const { randomToken } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function securityHeaders(config) {
  const csp = [
    "default-src 'self'", "base-uri 'self'", "font-src 'self' https: data:",
    "form-action 'self'", "frame-ancestors 'self'", "img-src 'self' data:",
    "object-src 'none'", "script-src 'self'", "script-src-attr 'none'",
    "style-src 'self' https: 'unsafe-inline'",
  ];
  if (config.cookieSecure) csp.push('upgrade-insecure-requests');
  return (_req, res, next) => {
    res.set('Content-Security-Policy', csp.join('; '));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-DNS-Prefetch-Control', 'off');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)');
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

function apiHeaders(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Cookie');
  next();
}

function createApp(config, log, dependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders(config));

  const auth = initAuth(config);
  const jobs = new JobManager(config, log, dependencies);
  const startedAt = Date.now();

  // --- API router (mounted at /qwen38/api and /api) ----------------------------
  const api = express.Router();
  api.use(apiHeaders);
  api.use(makeLimiter({ windowMs: 60000, max: 1200, keyFn: byIp, message: 'Too many requests' }));
  api.use(auth.attachSession);

  const loginLimiter = makeLimiter({ windowMs: 15 * 60000, max: 8, keyFn: byIp, message: 'Too many login attempts' });
  const chatLimiter = makeLimiter({ windowMs: 60000, max: 30, keyFn: bySession, message: 'Too many turns' });
  const historyLimiter = makeLimiter({ windowMs: 60000, max: 120, keyFn: bySession, message: 'Too many requests' });
  const pollLimiter = makeLimiter({ windowMs: 60000, max: 300, keyFn: bySession, message: 'Too many requests' });
  const stateLimiter = makeLimiter({ windowMs: 60000, max: 90, keyFn: bySession, message: 'Too many requests' });
  const ownerKey = (req) => req.session.username;

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.get('/session', (req, res) => {
    if (!req.session) return res.json({ authenticated: false });
    res.json(auth.sessionPayload(req.session));
  });

  api.post('/login', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }), async (req, res) => {
    const loginKey = byIp(req);
    if (loginLimiter.count(loginKey) >= 8) return res.status(429).json({ error: 'Too many login attempts' });
    // Reserve the attempt before bcrypt yields so parallel requests cannot all
    // slip through the same pre-check.
    loginLimiter.record(loginKey);
    const { username, password } = req.body || {};
    const ok = await auth.verifyCredentials(username, password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    auth.login(req, res);
  });

  api.post('/logout', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, (req, res) => auth.logout(req, res));

  // --- passkeys / WebAuthn ---------------------------------------------------
  // Registration is gated behind an existing session: only someone already
  // signed in may enrol a new authenticator. Login is open but rate limited on
  // the same bucket as password login, so passkeys are not a bypass around it.
  const webauthn = config.webauthnEnabled ? initWebAuthn(config) : null;
  const jsonBody = [auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true })];
  const waFail = (res, e, status) => res.status(status || 400).json({ error: e.message || 'Passkey error' });

  api.get('/webauthn/support', (req, res) => {
    res.json({
      enabled: !!webauthn,
      rpId: webauthn ? webauthn.rpId : null,
      registered: webauthn && req.session ? webauthn.list(req.session.username).length : 0,
      anyRegistered: webauthn ? webauthn.hasAny() : false,
    });
  });

  api.post('/webauthn/register/options', ...jsonBody, auth.requireAuth, auth.requireCsrf, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    try { res.json(webauthn.registrationOptions(req.session.username)); }
    catch (e) { waFail(res, e); }
  });

  api.post('/webauthn/register/verify', ...jsonBody, auth.requireAuth, auth.requireCsrf, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    try {
      const cred = webauthn.verifyRegistration(req.session.username, req.body);
      log.info(`[passkey] registered ${cred.id.slice(0, 12)}... for ${req.session.username}`);
      res.json({ ok: true, credential: cred, credentials: webauthn.list(req.session.username) });
    } catch (e) { waFail(res, e); }
  });

  api.post('/webauthn/login/options', ...jsonBody, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    if (!webauthn.hasAny()) return res.status(404).json({ error: 'No passkey is registered yet' });
    try { res.json(webauthn.loginOptions()); }
    catch (e) { waFail(res, e); }
  });

  api.post('/webauthn/login/verify', ...jsonBody, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    const loginKey = byIp(req);
    if (loginLimiter.count(loginKey) >= 8) return res.status(429).json({ error: 'Too many login attempts' });
    loginLimiter.record(loginKey);
    try {
      const result = webauthn.verifyAssertion(req.body);
      log.info(`[passkey] login as ${result.username} via ${result.credential.label}`);
      req.body = { username: result.username };
      auth.login(req, res);
    } catch (e) {
      log.warn(`[passkey] assertion rejected: ${e.message}`);
      res.status(401).json({ error: 'Passkey was not accepted' });
    }
  });

  api.get('/webauthn/credentials', auth.requireAuth, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    res.json({ credentials: webauthn.list(req.session.username) });
  });

  api.post('/webauthn/credentials/remove', ...jsonBody, auth.requireAuth, auth.requireCsrf, (req, res) => {
    if (!webauthn) return res.status(404).json({ error: 'Passkeys are disabled' });
    const id = req.body && req.body.id;
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Missing credential id' });
    const ok = webauthn.remove(req.session.username, id);
    if (!ok) return res.status(404).json({ error: 'Unknown passkey' });
    res.json({ ok: true, credentials: webauthn.list(req.session.username) });
  });

  api.get('/history', auth.requireAuth, historyLimiter, (req, res) => {
    const { model, sessionId } = req.query;
    if (model !== 'preview' && model !== 'stable') return res.status(400).json({ error: 'Invalid model' });
    if (sessionId !== undefined && sessionId !== '' && sessionId !== 'main') {
      return res.status(400).json({ error: 'Unknown session' });
    }
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 80;
    limit = Math.min(200, Math.max(1, limit));
    const messages = sessions.readMessages(config, model, 'main', limit).map((m) => ({
      id: m.id, role: m.role, content: m.content, timestamp: m.timestamp,
      tools: Array.isArray(m.tools) ? m.tools : [],
      attachments: Array.isArray(m.attachments) ? m.attachments.map((image) => ({
        id: image.id,
        mimeType: image.mimeType,
        fileName: image.fileName,
        size: image.size,
        url: `${config.basePath}/api/media/${encodeURIComponent(image.id)}`,
      })) : [],
    }));
    res.json({ model, label: config.lanes[model].label, sessionId: 'main', messages });
  });

  api.get('/state', auth.requireAuth, stateLimiter, (_req, res) => {
    res.json(state.buildState(config, jobs, startedAt));
  });

  api.get('/media/:imageId', auth.requireAuth, historyLimiter, (req, res) => {
    const image = sessions.imageInfo(config, req.params.imageId);
    if (!image) return res.status(404).json({ error: 'Image not found' });
    res.set('Content-Type', image.mimeType);
    res.set('Content-Length', String(image.size));
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', 'inline');
    fs.createReadStream(image.file).pipe(res);
  });

  const clientTurnIdRe = /^[A-Za-z0-9_-]{12,80}$/;

  function validChatBody(body) {
    if (!body || typeof body !== 'object') return false;
    const { message, model, sessionId, clientTurnId } = body;
    if (typeof message !== 'string' || message.length > 12000) return false;
    if (message.indexOf('\0') !== -1) return false;
    if (model !== 'preview' && model !== 'stable') return false;
    if (sessionId !== undefined && sessionId !== null && sessionId !== '' && sessionId !== 'main') return false;
    // Frontends opened before the durability rollout did not send a client turn
    // id. Keep those already-open tabs working, while still rejecting malformed
    // non-empty ids from newer clients.
    if (clientTurnId !== undefined && clientTurnId !== null && clientTurnId !== ''
      && (typeof clientTurnId !== 'string' || !clientTurnIdRe.test(clientTurnId))) return false;
    if (!message.trim() && (!Array.isArray(body.attachments) || body.attachments.length === 0)) return false;
    return true;
  }

  function steeringRequestId(body) {
    if (!body || typeof body !== 'object') return '';
    const canonical = typeof body.clientSteerId === 'string' ? body.clientSteerId.trim() : '';
    const alias = typeof body.clientSteeringId === 'string' ? body.clientSteeringId.trim() : '';
    if (canonical && alias && canonical !== alias) return null;
    return canonical || alias || '';
  }

  function validSteeringBody(body) {
    if (!body || typeof body !== 'object') return false;
    if (typeof body.message !== 'string' || !body.message.trim()) return false;
    if (body.message.length > 12000 || body.message.indexOf('\0') !== -1) return false;
    const requestId = steeringRequestId(body);
    return requestId !== null && (!requestId || clientTurnIdRe.test(requestId));
  }

  function sendSteering(job, req, res) {
    if (!validSteeringBody(req.body)) return res.status(400).json({ error: 'Invalid steering message' });
    try {
      const steering = jobs.steerJob(job, req.body.message, steeringRequestId(req.body));
      const view = jobs.publicView(job);
      const instruction = {
        id: steering.id,
        clientSteerId: steering.clientSteerId,
        clientSteeringId: steering.clientSteerId,
        state: steering.state,
        createdAt: steering.createdAt,
        appliedAt: steering.appliedAt || null,
        duplicate: !!steering.duplicate,
        interrupted: !!steering.interrupted,
      };
      return res.status(steering.duplicate ? 200 : 202).json({
        ...view,
        accepted: true,
        steering: view.steering,
        instruction,
        steeringInstruction: instruction,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'Could not steer that turn' });
    }
  }

  function normalizedClientTurnId(body) {
    return typeof body.clientTurnId === 'string' && body.clientTurnId
      ? body.clientTurnId
      : `legacy_${randomToken(18)}`;
  }

  api.post('/chat', auth.requireOrigin, auth.requireJson, auth.requireAuth, auth.requireCsrf, chatLimiter,
    express.json({ limit: '18mb', strict: true }), (req, res) => {
      if (!validChatBody(req.body)) return res.status(400).json({ error: 'Invalid chat request' });
      try {
        const attachments = normalizeImages(req.body.attachments);
        const message = req.body.message.trim() || 'Please analyse the attached image or images.';
        const job = jobs.enqueue({
          ownerKey: ownerKey(req),
          model: req.body.model,
          message,
          attachments,
          clientTurnId: normalizedClientTurnId(req.body),
        });
        res.status(202).json({ ...jobs.publicView(job), attached: false });
      } catch (e) {
        if (e instanceof ImageValidationError) return res.status(e.status).json({ error: e.message });
        res.status(e.status || 500).json({ error: e.message });
      }
    });

  const jobIdRe = /^[A-Za-z0-9_-]{32}$/;

  api.get('/chat/by-client/:clientTurnId', auth.requireAuth, pollLimiter, (req, res) => {
    if (!clientTurnIdRe.test(req.params.clientTurnId)) {
      return res.status(404).json({ error: 'That turn is no longer tracked' });
    }
    const job = jobs.getByClient(req.params.clientTurnId, ownerKey(req));
    if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
    res.json(jobs.publicView(job));
  });

  api.post('/chat/by-client/:clientTurnId/steer', auth.requireOrigin, auth.requireJson,
    express.json({ limit: '32kb', strict: true }), auth.requireAuth, auth.requireCsrf, chatLimiter, (req, res) => {
      if (!clientTurnIdRe.test(req.params.clientTurnId)) {
        return res.status(404).json({ error: 'That turn is no longer tracked' });
      }
      const job = jobs.getByClient(req.params.clientTurnId, ownerKey(req));
      if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
      return sendSteering(job, req, res);
    });

  api.post('/chat/by-client/:clientTurnId/abort', auth.requireOrigin, auth.requireJson,
    express.json({ limit: '32kb', strict: true }), auth.requireAuth, auth.requireCsrf, (req, res) => {
      if (!clientTurnIdRe.test(req.params.clientTurnId)) {
        return res.status(404).json({ error: 'That turn is no longer tracked' });
      }
      const job = jobs.getByClient(req.params.clientTurnId, ownerKey(req));
      if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
      res.json({ aborted: jobs.abortJob(job), ...jobs.publicView(job) });
    });

  api.get('/chat/:jobId', auth.requireAuth, pollLimiter, (req, res) => {
    if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
    const job = jobs.getOwned(req.params.jobId, ownerKey(req));
    if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
    res.json(jobs.publicView(job));
  });

  // NEW: SSE token stream
  api.get('/chat/:jobId/stream', auth.requireAuth, pollLimiter, (req, res) => {
    if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
    const job = jobs.getOwned(req.params.jobId, ownerKey(req));
    if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    let unsub = () => {};
    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, config.ssePingMs);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsub();
      res.end();
    };
    // Subscribe before taking the initial snapshot. Since this block is
    // synchronous, a completion can no longer land between snapshot and
    // subscription and disappear forever.
    unsub = jobs.subscribe(job, (event, data) => {
      send(event, data);
      if (event === 'done' || event === 'error') close();
    });
    req.on('close', close);
    if (job.state === 'done') {
      send('done', {
        reply: job.reply,
        usage: job.usage || undefined,
        tools: job.tools,
        elapsedMs: job.finishedAt - job.createdAt,
      });
      close();
      return;
    }
    if (job.state === 'error') {
      send('error', { error: job.error, status: job.status });
      close();
      return;
    }
    const initialView = jobs.publicView(job);
    send('status', {
      state: job.state,
      queuePosition: jobs.queuePosition(job) || undefined,
      elapsedMs: Date.now() - job.createdAt,
      steering: initialView.steering,
    });
  });

  api.post('/chat/:jobId/steer', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, chatLimiter, (req, res) => {
      if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
      const job = jobs.getOwned(req.params.jobId, ownerKey(req));
      if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
      return sendSteering(job, req, res);
    });

  // NEW: abort a queued/running turn
  api.post('/chat/:jobId/abort', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, (req, res) => {
      if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
      const job = jobs.getOwned(req.params.jobId, ownerKey(req));
      if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
      res.json({ aborted: jobs.abortJob(job) });
    });

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // JSON parse errors
  api.use((err, _req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    next(err);
  });

  app.use(`${config.basePath}/api`, api);
  app.use('/api', api); // dev convenience mount

  // --- static: /qwen38/ and / from dist (frontend arrives separately) ----------
  const dist = config.distDir;
  function safeJoin(p) {
    const full = path.normalize(path.join(dist, p));
    return full.startsWith(path.normalize(dist) + path.sep) ? full : null;
  }
  function serveStatic(req, res, rel) {
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) {
      return res.status(404).type('text/plain').send('meshdirect backend up - frontend dist/ not deployed yet\n');
    }
    let file = rel ? safeJoin(rel) : null;
    if (file && (!fs.existsSync(file) || !fs.statSync(file).isFile())) file = null;
    const isAsset = rel && rel.startsWith('assets/');
    if (!file && rel && isAsset) return res.status(404).type('text/plain').send('not found\n');
    const target = file || index;
    const ext = path.extname(target).toLowerCase();
    res.set('Content-Type', MIME[ext] || 'application/octet-stream');
    res.set('Cache-Control', file && isAsset ? 'public, max-age=31536000, immutable' : 'no-store');
    fs.createReadStream(target).pipe(res);
  }
  app.get('/', (req, res) => serveStatic(req, res, ''));
  // favicon lives at dist root (not under assets/)
  const favicon = (req, res) => {
    const f = safeJoin('favicon.svg');
    if (!f || !fs.existsSync(f)) return res.status(404).type('text/plain').send('not found\n');
    res.set('Content-Type', MIME['.svg']);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(f).pipe(res);
  };
  app.get('/favicon.svg', favicon);
  app.get(`${config.basePath}/favicon.svg`, favicon);
  // exact '/qwen38' (no trailing slash) -> single 302 to '/qwen38/' (canonical URL).
  // NB: non-strict routing also matches '/qwen38/' here, so check req.path exactly
  // and fall through — otherwise the redirect shadows the index route (302 loop).
  app.get(`${config.basePath}`, (req, res, next) => {
    if (req.path !== config.basePath) return next();
    res.redirect(302, `${config.basePath}/`);
  });
  app.get([`${config.basePath}/`, `${config.basePath}/index.html`], (req, res) => serveStatic(req, res, ''));
  app.get(`${config.basePath}/assets/*`, (req, res) => serveStatic(req, res, `assets/${req.params[0]}`));
  app.get('/assets/*', (req, res) => serveStatic(req, res, `assets/${req.params[0]}`));
  app.get(`${config.basePath}/*`, (req, res) => {
    const extension = path.extname(req.path).toLowerCase();
    if (extension && extension !== '.html') return res.status(404).type('text/plain').send('not found\n');
    serveStatic(req, res, '');
  }); // SPA fallback

  return { app, jobs, auth };
}

module.exports = { createApp };
