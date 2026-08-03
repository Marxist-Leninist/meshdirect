// JSONL session storage + one-time OpenClaw transcript import
'use strict';
const fs = require('fs');
const path = require('path');
const { randomToken } = require('./util');

function sessionFile(config, model, sessionId) {
  return path.join(config.sessionsDir, `${model}-${sessionId || 'main'}.jsonl`);
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
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') msgs.push(m);
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
  if (msg.imported) row.imported = true;
  if (msg.failed) row.failed = true;
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

// tag a stored message as failed (turn errored) — excluded from future model context,
// but still shown in history. JSONL is append-only, so rewrite in place (files are small
// and per-model lanes serialize writers).
function markFailed(config, model, sessionId, id) {
  if (!id) return;
  const file = sessionFile(config, model, sessionId);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return; }
  let changed = false;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const m = JSON.parse(line);
      if (m && m.id === id && !m.failed) { m.failed = true; changed = true; return JSON.stringify(m); }
    } catch { /* keep line as-is */ }
    return line;
  });
  if (changed) fs.writeFileSync(file, out.join('\n'), { mode: 0o600 });
}

function statsFor(config, model, sessionId) {
  const msgs = readMessages(config, model, sessionId, 0);
  let totalTokens = 0, inputTokens = 0, outputTokens = 0, lastActivityAt = null;
  for (const m of msgs) {
    if (m.usage) {
      totalTokens += m.usage.total_tokens || 0;
      inputTokens += m.usage.prompt_tokens || 0;
      outputTokens += m.usage.completion_tokens || 0;
    }
    const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
    if (Number.isFinite(t) && (!lastActivityAt || t > lastActivityAt)) lastActivityAt = t;
  }
  return { messageCount: msgs.length, totalTokens, inputTokens, outputTokens, lastActivityAt };
}

// --- one-time OpenClaw import -------------------------------------------------
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function importOpenClaw(config, log) {
  const marker = path.join(config.sessionsDir, '.imported');
  if (fs.existsSync(marker)) { log('import: marker present, skipping'); return; }
  const map = { preview: 'qwen38-preview', stable: 'qwen38-stable' };
  for (const [model, agent] of Object.entries(map)) {
    const dir = path.join(config.importDir, agent, 'sessions');
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
        .map((x) => x.f);
    } catch (e) { log(`import: ${agent}: ${e.message}`); continue; }
    const seen = new Set();
    const rows = [];
    for (const f of files) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line.includes('"type":"message"')) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const msg = row && row.message;
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
        const content = flattenContent(msg.content);
        if (!content) continue;
        const id = row.id || randomToken(6);
        if (seen.has(id)) continue;
        seen.add(id);
        const ts = Date.parse(row.timestamp) || msg.timestamp || Date.now();
        rows.push({ id, role: msg.role, content, timestamp: ts, imported: true });
      }
    }
    rows.sort((a, b) => a.timestamp - b.timestamp);
    if (rows.length) {
      const file = sessionFile(config, model, 'main');
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    }
    log(`import: ${model} <- ${agent}: ${rows.length} messages`);
  }
  fs.writeFileSync(marker, new Date().toISOString() + '\n', { mode: 0o600 });
}

module.exports = { readMessages, appendMessage, markFailed, statsFor, importOpenClaw };
