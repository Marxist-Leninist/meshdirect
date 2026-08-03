// express app: drop-in qwen38 API + SSE streaming + static dist serving
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { initAuth } = require('./auth');
const { makeLimiter, byIp, bySession } = require('./ratelimit');
const { JobManager } = require('./jobs');
const state = require('./state');
const sessions = require('./sessions');

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
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

function apiHeaders(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Cookie');
  next();
}

function createApp(config, log) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders(config));

  const auth = initAuth(config);
  const jobs = new JobManager(config, log);
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

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.get('/session', (req, res) => {
    if (!req.session) return res.json({ authenticated: false });
    res.json(auth.sessionPayload(req.session));
  });

  api.post('/login', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }), async (req, res) => {
    if (loginLimiter.count(byIp(req)) >= 8) return res.status(429).json({ error: 'Too many login attempts' });
    const { username, password } = req.body || {};
    const ok = await auth.verifyCredentials(username, password);
    if (!ok) {
      loginLimiter.record(byIp(req));
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    auth.login(req, res);
  });

  api.post('/logout', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, (req, res) => auth.logout(req, res));

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
      id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, tools: [],
    }));
    res.json({ model, label: config.lanes[model].label, sessionId: 'main', messages });
  });

  api.get('/state', auth.requireAuth, stateLimiter, (_req, res) => {
    res.json(state.buildState(config, jobs, startedAt));
  });

  function validChatBody(body) {
    if (!body || typeof body !== 'object') return false;
    const { message, model, sessionId } = body;
    if (typeof message !== 'string' || message.length < 1 || message.length > 12000) return false;
    if (message.indexOf('\\0') !== -1) return false;
    if (model !== 'preview' && model !== 'stable') return false;
    if (sessionId !== undefined && sessionId !== null && sessionId !== '' && sessionId !== 'main') return false;
    return true;
  }

  api.post('/chat', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, chatLimiter, (req, res) => {
      if (!validChatBody(req.body)) return res.status(400).json({ error: 'Invalid chat request' });
      try {
        const job = jobs.enqueue({ ownerKey: req.sessionKey, model: req.body.model, message: req.body.message });
        res.status(202).json({ ...jobs.publicView(job), attached: false });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
    });

  const jobIdRe = /^[A-Za-z0-9_-]{32}$/;

  api.get('/chat/:jobId', auth.requireAuth, pollLimiter, (req, res) => {
    if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
    const job = jobs.getOwned(req.params.jobId, req.sessionKey);
    if (!job) return res.status(404).json({ error: 'That turn is no longer tracked' });
    res.json(jobs.publicView(job));
  });

  // NEW: SSE token stream
  api.get('/chat/:jobId/stream', auth.requireAuth, pollLimiter, (req, res) => {
    if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
    const job = jobs.getOwned(req.params.jobId, req.sessionKey);
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
    send('status', {
      state: job.state === 'running' ? 'running' : 'queued',
      queuePosition: jobs.queuePosition(job) || undefined,
      elapsedMs: Date.now() - job.createdAt,
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsub();
      res.end();
    };
    const unsub = jobs.subscribe(job, (event, data) => {
      send(event, data);
      if (event === 'done' || event === 'error') close();
    });
    const ping = setInterval(() => res.write(': ping\n\n'), config.ssePingMs);
    req.on('close', close);
  });

  // NEW: abort a queued/running turn
  api.post('/chat/:jobId/abort', auth.requireOrigin, auth.requireJson, express.json({ limit: '32kb', strict: true }),
    auth.requireAuth, auth.requireCsrf, (req, res) => {
      if (!jobIdRe.test(req.params.jobId)) return res.status(404).json({ error: 'That turn is no longer tracked' });
      const job = jobs.getOwned(req.params.jobId, req.sessionKey);
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
  app.get(`${config.basePath}/*`, (req, res) => serveStatic(req, res, '')); // SPA fallback

  return { app, jobs, auth };
}

module.exports = { createApp };
