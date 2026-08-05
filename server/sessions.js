// Private JSONL session storage.
'use strict';
const fs = require('fs');
const path = require('path');
const { randomToken } = require('./util');

const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const IMAGE_MIMES = Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([mime, ext]) => [ext, mime]));
const IMAGE_ID_RE = /^[A-Za-z0-9_-]{24}\.(?:png|jpg|webp|gif)$/;

function sessionFile(config, model, sessionId) {
  return path.join(config.sessionsDir, `${model}-${sessionId || 'main'}.jsonl`);
}

function mediaDir(config) {
  return path.join(config.sessionsDir, 'media');
}

function saveImages(config, images) {
  if (!Array.isArray(images) || !images.length) return [];
  const directory = mediaDir(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const saved = [];
  try {
    for (const image of images) {
      const extension = IMAGE_EXTENSIONS[image.mimeType];
      if (!extension) throw new Error('unsupported image type');
      const id = `${randomToken(18)}${extension}`;
      const data = Buffer.from(image.content, 'base64');
      fs.writeFileSync(path.join(directory, id), data, { mode: 0o600, flag: 'wx' });
      saved.push({
        id,
        mimeType: image.mimeType,
        fileName: String(image.fileName || 'image').slice(0, 160),
        size: data.length,
      });
    }
    return saved;
  } catch (error) {
    for (const image of saved) {
      try { fs.unlinkSync(path.join(directory, image.id)); } catch { /* best effort */ }
    }
    throw error;
  }
}

function deleteImages(config, images) {
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || !IMAGE_ID_RE.test(image.id || '')) continue;
    try { fs.unlinkSync(path.join(mediaDir(config), image.id)); } catch { /* best effort */ }
  }
}

function imageInfo(config, id) {
  if (!IMAGE_ID_RE.test(String(id || ''))) return null;
  const extension = path.extname(id).toLowerCase();
  const file = path.join(mediaDir(config), id);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { file, mimeType: IMAGE_MIMES[extension], size: stat.size };
  } catch { return null; }
}

function readImageData(config, id) {
  const image = imageInfo(config, id);
  if (!image || image.size > 5 * 1024 * 1024) return null;
  try {
    return { ...image, content: fs.readFileSync(image.file).toString('base64') };
  } catch { return null; }
}

function readMessages(config, model, sessionId, limit) {
  const file = sessionFile(config, model, sessionId);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  const msgs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
        // Hide the one class of corrupt legacy response that motivated the
        // native loop: executable tool markup must never be chat content.
        if (m.role === 'assistant' && /<tool_call>\s*\{[\s\S]*?"name"\s*:/i.test(m.content)) continue;
        msgs.push(m);
      }
    } catch { /* skip corrupt line */ }
  }
  return limit ? msgs.slice(-limit) : msgs;
}

function appendMessage(config, model, sessionId, msg) {
  const file = sessionFile(config, model, sessionId);
  const row = {
    id: msg.id || randomToken(6),
    role: msg.role,
    content: String(msg.content || ''),
    timestamp: msg.timestamp || Date.now(),
  };
  if (msg.usage) row.usage = msg.usage;
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    row.attachments = msg.attachments.slice(0, 4).flatMap((image) => {
      if (!image || !IMAGE_ID_RE.test(image.id || '') || !IMAGE_EXTENSIONS[image.mimeType]) return [];
      return [{
        id: image.id,
        mimeType: image.mimeType,
        fileName: String(image.fileName || 'image').slice(0, 160),
        size: Number.isSafeInteger(image.size) ? image.size : undefined,
      }];
    });
  }
  if (Array.isArray(msg.tools) && msg.tools.length) {
    row.tools = msg.tools.slice(-20).flatMap((tool) => {
      if (!tool || typeof tool !== 'object' || typeof tool.label !== 'string') return [];
      return [{
        label: tool.label.slice(0, 160),
        status: ['running', 'complete', 'error'].includes(tool.status) ? tool.status : 'complete',
        ...(typeof tool.time === 'string' ? { time: tool.time.slice(0, 40) } : {}),
      }];
    });
  }
  if (msg.imported) row.imported = true;
  if (msg.failed) row.failed = true;
  if (msg.pending) row.pending = true;
  if (typeof msg.turnId === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(msg.turnId)) row.turnId = msg.turnId;
  if (typeof msg.clientTurnId === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(msg.clientTurnId)) {
    row.clientTurnId = msg.clientTurnId;
  }
  if (typeof msg.ownerKey === 'string' && msg.ownerKey.length <= 256) row.ownerKey = msg.ownerKey;
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort for existing files */ }
  return row;
}

// tag a stored message as failed (turn errored) — excluded from future model context,
// but still shown in history. JSONL is append-only, so rewrite in place (files are small
// and per-model lanes serialize writers).
function rewriteMessages(config, model, sessionId, transform) {
  const file = sessionFile(config, model, sessionId);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return 0; }
  let changed = false;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const m = JSON.parse(line);
      if (m && transform(m)) { changed = true; return JSON.stringify(m); }
    } catch { /* keep line as-is */ }
    return line;
  });
  if (changed) {
    const temporary = `${file}.tmp-${process.pid}-${randomToken(4)}`;
    fs.writeFileSync(temporary, out.join('\n'), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  return changed ? 1 : 0;
}

function markFailed(config, model, sessionId, id) {
  if (!id) return;
  rewriteMessages(config, model, sessionId, (m) => {
    if (m.id !== id || (m.failed && !m.pending)) return false;
    m.failed = true;
    delete m.pending;
    return true;
  });
}

function markCompleted(config, model, sessionId, id) {
  if (!id) return;
  rewriteMessages(config, model, sessionId, (m) => {
    if (m.id !== id || !m.pending) return false;
    delete m.pending;
    return true;
  });
}

// A process restart loses in-memory jobs. Any accepted user row left pending is
// therefore made non-runnable before the service starts. If its assistant row
// was durably appended first, complete it instead of displaying a false failure.
function failPending(config, log = () => {}) {
  let recovered = 0;
  let failed = 0;
  for (const model of ['preview', 'stable']) {
    const rows = readMessages(config, model, 'main', 0);
    const completedTurns = new Set(rows.filter((m) => m.role === 'assistant' && m.turnId).map((m) => m.turnId));
    rewriteMessages(config, model, 'main', (m) => {
      if (!m.pending) return false;
      delete m.pending;
      if (completedTurns.has(m.id)) recovered += 1;
      else { m.failed = true; failed += 1; }
      return true;
    });
  }
  if (recovered || failed) log(`startup reconciled pending turns: ${recovered} completed, ${failed} failed safely`);
  return { recovered, failed };
}

function findTurnByClient(config, clientTurnId, ownerKey) {
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(String(clientTurnId || ''))) return null;
  for (const model of ['preview', 'stable']) {
    const rows = readMessages(config, model, 'main', 0);
    const user = [...rows].reverse().find((m) => (
      m.role === 'user' && m.clientTurnId === clientTurnId && m.ownerKey === ownerKey
    ));
    if (!user) continue;
    const assistant = [...rows].reverse().find((m) => m.role === 'assistant' && m.turnId === user.id) || null;
    return { model, user, assistant };
  }
  return null;
}

function statsFor(config, model, sessionId) {
  const msgs = readMessages(config, model, sessionId, 0);
  let totalTokens = 0, inputTokens = 0, outputTokens = 0, lastActivityAt = null;
  let lastPromptTokens = 0, lastCompletionTokens = 0, lastTurnTokens = 0;
  for (const m of msgs) {
    if (m.usage) {
      const prompt = Number(m.usage.prompt_tokens) || 0;
      const completion = Number(m.usage.completion_tokens) || 0;
      const total = Number(m.usage.total_tokens) || (prompt + completion);
      totalTokens += total;
      inputTokens += prompt;
      outputTokens += completion;
      lastPromptTokens = prompt;
      lastCompletionTokens = completion;
      lastTurnTokens = total;
    }
    const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
    if (Number.isFinite(t) && (!lastActivityAt || t > lastActivityAt)) lastActivityAt = t;
  }
  return {
    messageCount: msgs.length,
    totalTokens,
    inputTokens,
    outputTokens,
    lastPromptTokens,
    lastCompletionTokens,
    lastTurnTokens,
    lastActivityAt,
  };
}

module.exports = {
  readMessages, appendMessage, markFailed, markCompleted, failPending, findTurnByClient, statsFor,
  saveImages, deleteImages, imageInfo, readImageData,
};
