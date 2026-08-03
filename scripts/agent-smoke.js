#!/usr/bin/env node
'use strict';

const config = require('../server/config');
const { AgentLoop } = require('../server/agentloop');

const lane = process.argv[2] === 'preview' ? 'preview' : 'stable';
const prompt = process.argv.slice(3).join(' ') || [
  "Use the sg1 function with action='search' to find mcp_reliability_status.",
  "Then use sg1 with action='call' to invoke that exact tool with empty arguments.",
  'Reply in one short sentence with the SG health you observed.',
].join(' ');

const controller = new AbortController();
const timer = Number(config.turnTimeoutMs) > 0
  ? setTimeout(() => controller.abort(), config.turnTimeoutMs)
  : null;

(async () => {
  const events = [];
  const loop = new AgentLoop(config, (message) => process.stderr.write(`[log] ${message}\n`));
  const result = await loop.run({
    modelId: config.lanes[lane].modelId,
    messages: [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: prompt },
    ],
    signal: controller.signal,
    onActivity(event) {
      events.push(event);
      process.stderr.write(`[${event.phase}:${event.status}] ${event.label}\n`);
    },
    onProviderError(provider, status, message) {
      process.stderr.write(`[provider:${provider}:${status}] ${message}\n`);
    },
  });
  if (!result.tools.length) throw new Error('model completed without using SG1/SG2');
  if (/<tool_call>/i.test(result.reply)) throw new Error('raw tool markup leaked into final reply');
  process.stdout.write(JSON.stringify({
    ok: true,
    lane,
    provider: result.provider,
    rounds: result.rounds,
    toolCalls: result.tools.length,
    tools: result.tools.map((tool) => tool.label),
    reply: result.reply,
  }) + '\n');
})().catch((error) => {
  process.stderr.write(`smoke failed: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => { if (timer) clearTimeout(timer); });
