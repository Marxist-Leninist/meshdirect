#!/usr/bin/env node
'use strict';
const fs = require('fs');
for (const line of fs.readFileSync('/etc/meshdirect-dev.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue;
  const index = line.indexOf('=');
  process.env[line.slice(0, index)] = line.slice(index + 1);
}
const config = require('../server/config');
const modelclient = require('../server/modelclient');
const { runAgent } = require('../server/agentloop');

const log = () => {};
modelclient.loadFallbackKey(config, log);
const toolEvents = [];
const statusEvents = [];
let streamed = '';

(async () => {
  const output = await runAgent(config, 'stable', [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: 'Verify that both SG1 and SG2 are reachable. You must use sg_mcp with action health and server all, then answer with the two live tool counts. Do not guess.' },
  ], {
    onDelta: (text) => { streamed += text; },
    onTool: (event) => { toolEvents.push({ name: event.name, status: event.status, phase: event.phase, summary: event.summary || '' }); },
    onProgress: (event) => { statusEvents.push({ phase: event.phase, activity: event.activity, step: event.step, totalToolCalls: event.totalToolCalls }); },
    onProviderError: () => {},
  });
  const result = {
    ok: true,
    reply: output.reply,
    streamedMatchesReply: streamed.trim() === output.reply.trim(),
    steps: output.steps,
    toolCalls: output.toolCalls,
    tools: toolEvents,
    finalStatus: statusEvents.slice(-3),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
})().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error) }) + '\n');
  process.exitCode = 1;
});
