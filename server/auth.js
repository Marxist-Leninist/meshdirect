// auth: env creds + bcrypt, persisted session store, cookie + CSRF + Origin parity
'use strict';
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomToken, sha256b64url, secureEqual, parseCookies } = require('./util');

class SessionStore {
  // Sessions are keyed by sha256 of the cookie token, so the on-disk copy can
  // never be replayed as a credential. Persisting it is what stops a restart
  // from signing every device out.
  constructor(ttlMs, storePath) {
    this.ttlMs = ttlMs;
    this.storePath = storePath || '';
    this.sessions = new Map(); // sha256(token) -> {username, csrfToken, expiresAt}
    // Renew at most hourly, but stay proportional for tiny TTLs in tests.
    this.renewAfterMs = Math.min(ttlMs / 24, 60 * 60 * 1000);
    this.saveTimer = null;
    if (this.storePath) this.load();
    const t = setInterval(() => this.prune(), Math.min(5 * 60 * 1000, ttlMs));
    t.unref();
  }
  load() {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8')); } catch { return; }
    if (!parsed || !Array.isArray(parsed.sessions)) return;
    const now = Date.now();
    for (const row of parsed.sessions) {
      if (!row || typeof row.key !== 'string' || typeof row.username !== 'string') continue;
      if (typeof row.csrfToken !== 'string' || typeof row.expiresAt !== 'number') continue;
      if (row.expiresAt <= now) continue;
      this.sessions.set(row.key, {
        username: row.username, csrfToken: row.csrfToken, expiresAt: row.expiresAt,
      });
    }
  }
  scheduleSave() {
    if (!this.storePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 250);
    this.saveTimer.unref();
  }
  save() {
    if (!this.storePath) return;
    const payload = { version: 1, sessions: [] };
    for (const [key, s] of this.sessions) {
      payload.sessions.push({ key, username: s.username, csrfToken: s.csrfToken, expiresAt: s.expiresAt });
    }
    const tmp = this.storePath + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      console.error('[meshdirect] session store write failed:', e.message);
    }
  }
  prune() {
    const now = Date.now();
    let removed = false;
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) { this.sessions.delete(k); removed = true; }
    if (removed) this.scheduleSave();
  }
  create(username) {
    const token = randomToken(32);
    const key = sha256b64url(token);
    this.sessions.set(key, {
      username,
      csrfToken: randomToken(24),
      expiresAt: Date.now() + this.ttlMs,
    });
    this.scheduleSave();
    return { token, key };
  }
  get(key) {
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(key); this.scheduleSave(); return null; }
    // Sliding expiry: a session in active use never lapses. The gate keeps a
    // poll every few seconds from becoming a disk write every few seconds.
    const renewed = Date.now() + this.ttlMs;
    if (renewed - s.expiresAt >= this.renewAfterMs) { s.expiresAt = renewed; this.scheduleSave(); }
    return s;
  }
  destroy(key) { if (this.sessions.delete(key)) this.scheduleSave(); }
}

function cookieFlags(config, maxAgeMs) {
  const parts = [
    `HttpOnly`, `SameSite=Strict`, `Path=${config.cookiePath}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

// Resolved here rather than read straight off config, so that losing the
// config key again silently downgrades nothing.
function resolveStorePath(config) {
  if (config.sessionStorePath) return config.sessionStorePath;
  return path.join(config.sessionsDir || '/opt/meshdirect/sessions', 'auth-sessions.json');
}

function initAuth(config) {
  const store = new SessionStore(config.sessionTtlMs, resolveStorePath(config));

  function sessionPayload(sess) {
    return {
      authenticated: true,
      username: sess.username,
      csrfToken: sess.csrfToken,
      model: config.modelLabel,
      plan: config.planLabel,
      workspace: config.workspaceLabel,
      defaultModel: 'preview',
      models: Object.entries(config.lanes)
        .filter(([, lane]) => lane && lane.enabled !== false)
        .map(([id, lane]) => ({ id, label: lane.label, detail: lane.detail })),
    };
  }

  // attach req.session (nullable) + req.sessionKey from cookie
  function attachSession(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.cookieName];
    req.sessionToken = null;
    req.session = null;
    req.sessionKey = 'anon';
    if (token) {
      const key = sha256b64url(token);
      const sess = store.get(key);
      if (sess) {
        req.sessionToken = token;
        req.sessionKey = key;
        req.session = sess;
        // The store slid the session forward; push the same window to the
        // browser so the cookie cannot expire underneath a live session.
        const now = Date.now();
        if (!sess.cookieAt || now - sess.cookieAt >= 60 * 60 * 1000) {
          sess.cookieAt = now;
          res.set('Set-Cookie', `${config.cookieName}=${encodeURIComponent(token)}; ${cookieFlags(config, config.sessionTtlMs)}`);
        }
      }
    }
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'Authentication required' });
    next();
  }

  function requireCsrf(req, res, next) {
    const tok = req.get('X-CSRF-Token') || '';
    if (!req.session || !tok || !secureEqual(tok, req.session.csrfToken)) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
  }

  function requireOrigin(req, res, next) {
    const origin = req.get('Origin') || '';
    if (!origin || !config.originAllow.some((o) => o === origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
  }

  function requireJson(req, res, next) {
    const ct = req.get('Content-Type') || '';
    if (!/^application\/json\b/i.test(ct)) {
      return res.status(415).json({ error: 'Expected application/json' });
    }
    next();
  }

  async function verifyCredentials(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') return false;
    if (password.length > 1024 || username.length > 256) return false;
    const userOk = secureEqual(username, config.username);
    let passOk = false;
    try { passOk = await bcrypt.compare(password, config.passwordHash); } catch { passOk = false; }
    return userOk && passOk;
  }

  function login(req, res) {
    // rotate: destroy any pre-existing session carried by the request (fixation).
    // Only this browser's own session is dropped; other signed-in devices keep theirs.
    if (req.sessionKey && req.sessionKey !== 'anon') store.destroy(req.sessionKey);
    const { token } = store.create(req.body.username);
    const sess = store.get(sha256b64url(token));
    res.set('Set-Cookie', `${config.cookieName}=${encodeURIComponent(token)}; ${cookieFlags(config, config.sessionTtlMs)}`);
    res.json(sessionPayload(sess));
  }

  function logout(req, res) {
    if (req.sessionKey && req.sessionKey !== 'anon') store.destroy(req.sessionKey);
    res.set('Set-Cookie', `${config.cookieName}=; ${cookieFlags(config, 0)}`);
    res.status(204).end();
  }

  return { store, attachSession, requireAuth, requireCsrf, requireOrigin, requireJson, verifyCredentials, login, logout, sessionPayload };
}

module.exports = { initAuth };
