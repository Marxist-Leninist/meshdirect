// in-memory sliding-window rate limiter (dependency-free, express-rate-limit parity)
'use strict';

function makeLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> number[] timestamps
  // periodic prune so the map cannot grow unbounded
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, Math.min(windowMs, 60000));
  timer.unref();

  function record(key) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(key) || []).filter((t) => t > cutoff);
    arr.push(now);
    hits.set(key, arr);
    return arr.length;
  }
  function count(key) {
    const cutoff = Date.now() - windowMs;
    return (hits.get(key) || []).filter((t) => t > cutoff).length;
  }

  const middleware = (req, res, next) => {
    const key = keyFn(req);
    const n = record(key);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - n)));
    if (n > max) return res.status(429).json({ error: message });
    next();
  };
  middleware.record = record;
  middleware.count = count;
  return middleware;
}

const byIp = (req) => `ip:${req.ip || req.socket.remoteAddress || '?'}`;
const bySession = (req) => `sess:${req.sessionKey || 'anon'}`;

module.exports = { makeLimiter, byIp, bySession };
