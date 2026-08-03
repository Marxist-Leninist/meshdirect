// auth: env creds + bcrypt, in-memory session store, cookie + CSRF + Origin parity
'use strict';
const bcrypt = require('bcryptjs');
const { randomToken, sha256b64url, secureEqual, parseCookies } = require('./util');

class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map(); // sha256(token) -> {username, csrfToken, expiresAt}
    const t = setInterval(() => this.prune(), Math.min(5 * 60 * 1000, ttlMs));
    t.unref();
  }
  prune() {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
  }
  create(username) {
    const token = randomToken(32);
    const key = sha256b64url(token);
    this.sessions.set(key, {
      username,
      csrfToken: randomToken(24),
      expiresAt: Date.now() + this.ttlMs,
    });
    return { token, key };
  }
  get(key) {
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(key); return null; }
    return s;
  }
  destroy(key) { this.sessions.delete(key); }
}

function cookieFlags(config, maxAgeMs) {
  const parts = [
    `HttpOnly`, `SameSite=Strict`, `Path=${config.cookiePath}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function initAuth(config) {
  const store = new SessionStore(config.sessionTtlMs);

  function sessionPayload(sess) {
    return {
      authenticated: true,
      username: sess.username,
      csrfToken: sess.csrfToken,
      model: config.modelLabel,
      plan: config.planLabel,
      workspace: config.workspaceLabel,
      defaultModel: 'preview',
      models: [
        { id: 'preview', label: config.lanes.preview.label, detail: config.lanes.preview.detail },
        { id: 'stable', label: config.lanes.stable.label, detail: config.lanes.stable.detail },
      ],
    };
  }

  // attach req.session (nullable) + req.sessionKey from cookie
  function attachSession(req, _res, next) {
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
    // rotate: destroy any pre-existing session carried by the request (fixation)
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
