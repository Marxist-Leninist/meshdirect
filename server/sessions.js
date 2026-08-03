// JSONL transcript storage for MeshDirect.
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
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
  catch { return []; }
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') {
        messages.push(message);
      }
    } catch { /* skip a damaged row without losing the session */ }
  }
  return limit ? messages.slice(-limit) : messages;
}

function appendMessage(config, model, sessionId, message) {
  const file = sessionFile(config, model, sessionId);
  const row = {
    id: message.id || randomToken(6),
    role: message.role,
    content: String(message.content || ''),
    timestamp: message.timestamp || Date.now(),
  };
  if (message.usage) row.usage = message.usage;
  if (Array.isArray(message.tools) && message.tools.length) row.tools = message.tools.slice(0, 100);
  if (message.agent && typeof message.agent === 'object') row.agent = message.agent;
  if (message.imported) row.imported = true;
  if (message.failed) row.failed = true;
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  return row;
}

function markFailed(config, model, sessionId, id) {
  if (!id) return;
  const file = sessionFile(config, model, sessionId);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
  catch { return; }
  let changed = false;
  const output = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const message = JSON.parse(line);
      if (message && message.id === id && !message.failed) {
        message.failed = true;
        changed = true;
        return JSON.stringify(message);
      }
    } catch { /* preserve the original row */ }
    return line;
  });
  if (!changed) return;
  const temporary = `${file}.rewrite-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, output.join('\n'), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function statsFor(config, model, sessionId) {
  const messages = readMessages(config, model, sessionId, 0);
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastActivityAt = null;
  let toolCalls = 0;
  let agentSteps = 0;
  for (const message of messages) {
    if (message.usage) {
      totalTokens += message.usage.total_tokens || 0;
      inputTokens += message.usage.prompt_tokens || 0;
      outputTokens += message.usage.completion_tokens || 0;
    }
    if (Array.isArray(message.tools)) toolCalls += message.tools.length;
    if (message.agent && Number.isFinite(message.agent.steps)) agentSteps += message.agent.steps;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
    if (Number.isFinite(timestamp) && (!lastActivityAt || timestamp > lastActivityAt)) lastActivityAt = timestamp;
  }
  return { messageCount: messages.length, totalTokens, inputTokens, outputTokens, lastActivityAt, toolCalls, agentSteps };
}

module.exports = { readMessages, appendMessage, markFailed, statsFor, sessionFile };
