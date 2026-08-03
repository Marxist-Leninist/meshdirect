// shared helpers — no deps beyond node stdlib
'use strict';
const crypto = require('crypto');

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256b64url(s) {
  return crypto.createHash('sha256').update(s).digest('base64url');
}
// constant-time compare via sha256 digests (handles unequal length safely)
function secureEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
// strip anything that looks like a secret or absolute server path from error text
function sanitizeError(msg) {
  return String(msg || 'unknown error')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/\/(?:root|etc|home|opt|usr|var)\/[^\s"']*/g, '[path]')
    .slice(0, 500);
}
// map provider/transport failures to the legacy HTTP-ish status contract
function classifyStatus(msg) {
  const m = String(msg || '').toLowerCase();
  if (/(^|[^0-9])429|quota|rate limit/.test(m)) return 429;
  if (/session (file )?lock|already owns this chat/.test(m)) return 409;
  if (/timed out|timeout|stall/.test(m)) return 504;
  return 502;
}
module.exports = { randomToken, sha256b64url, secureEqual, parseCookies, sanitizeError, classifyStatus };
