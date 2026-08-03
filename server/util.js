// shared helpers — no deps beyond node stdlib
'use strict';
const crypto = require('crypto');

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256b64url(s) {
  return crypto.createHash('sha256').update(String(s)).digest('base64url');
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
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function redactSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\bsk-(?:sp|ws|proj|live|test)?-?[A-Za-z0-9._-]{12,}\b/g, 'sk-REDACTED')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh_REDACTED')
    .replace(/\bam_[A-Za-z0-9_]{20,}\b/g, 'am_REDACTED')
    .replace(/\btp-[A-Za-z0-9_-]{20,}\b/g, 'tp-REDACTED')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1REDACTED')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?)[^,\s"'}]{8,}/gi, '$1REDACTED');
}

// Error text sent to clients should not reveal credentials or sensitive host paths.
function sanitizeError(msg) {
  return redactSecrets(msg || 'unknown error')
    .replace(/\/(?:root|etc|home)\/[^\s"']*/g, '[protected-path]')
    .slice(0, 700);
}

// Tool output remains operationally useful while credentials are stripped and size bounded.
function sanitizeToolOutput(value, maxChars = 60000) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  text = redactSecrets(text).replace(/\u0000/g, '');
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + `\n\n[output truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

function compactOneLine(value, maxChars = 280) {
  const clean = redactSecrets(typeof value === 'string' ? value : JSON.stringify(value || {}))
    .replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? clean.slice(0, maxChars - 1) + '…' : clean;
}

// map provider/transport failures to the HTTP-ish job status contract
function classifyStatus(msg) {
  const m = String(msg || '').toLowerCase();
  if (/(^|[^0-9])429|quota|rate limit/.test(m)) return 429;
  if (/session (file )?lock|already owns this chat/.test(m)) return 409;
  if (/timed out|timeout|stall/.test(m)) return 504;
  return 502;
}

module.exports = {
  randomToken, sha256b64url, secureEqual, parseCookies,
  redactSecrets, sanitizeError, sanitizeToolOutput, compactOneLine, classifyStatus,
};
