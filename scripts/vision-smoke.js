#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const { AgentLoop } = require('../server/agentloop');
const { normalizeImages, sniffMime } = require('../server/images');

const file = process.argv[2];
const lane = process.argv[3] === 'preview' ? 'preview' : 'stable';
if (!file) {
  process.stderr.write('usage: vision-smoke.js <image-file> [stable|preview]\n');
  process.exit(2);
}

const data = fs.readFileSync(file);
const mimeType = sniffMime(data);
const image = normalizeImages([{
  fileName: path.basename(file), mimeType, content: data.toString('base64'),
}])[0];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), config.turnTimeoutMs);

(async () => {
  const loop = new AgentLoop(config, (message) => process.stderr.write(`[log] ${message}\n`));
  const result = await loop.run({
    modelId: config.lanes[lane].modelId,
    messages: [
      { role: 'system', content: config.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Do not use tools. Inspect this screenshot. What two short server labels are visible? Answer in one sentence.' },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.content}` } },
        ],
      },
    ],
    signal: controller.signal,
    onActivity(event) { process.stderr.write(`[${event.phase}:${event.status}] ${event.label}\n`); },
    onProviderError(provider, status, message) {
      process.stderr.write(`[provider:${provider}:${status}] ${message}\n`);
    },
  });
  if (!/\bsg1\b/i.test(result.reply) || !/\bsg2\b/i.test(result.reply)) {
    throw new Error(`vision answer did not identify both labels: ${result.reply.slice(0, 300)}`);
  }
  if (/<tool_call>/i.test(result.reply)) throw new Error('raw tool markup leaked into vision answer');
  process.stdout.write(JSON.stringify({
    ok: true, lane, provider: result.provider, rounds: result.rounds, reply: result.reply,
  }) + '\n');
})().catch((error) => {
  process.stderr.write(`vision smoke failed: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => clearTimeout(timer));
