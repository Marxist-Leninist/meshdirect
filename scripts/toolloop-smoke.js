// Smoke test: drive one real turn through modelclient + agentloop, exactly as
// jobs.js does, and confirm tools actually execute instead of being narrated.
'use strict';

const cfg = require('../server/config');
const modelclient = require('../server/modelclient');
const agentloop = require('../server/agentloop');

const lane = process.argv[2] || 'preview';
const task = process.argv[3]
  || 'Run `uname -r` on this box, then use sg_find_tools to search for "vast" and tell me how many matched. Be brief.';

(async () => {
  const started = Date.now();
  const out = await agentloop.runAgentTurn({
    messages: [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'user', content: task },
    ],
    shouldStop: () => false,
    onProgress: (p) => {
      process.stderr.write(`  … step ${p.step} · ${p.toolCalls} tools${p.lastTool ? ' · ' + p.lastTool : ''}\n`);
    },
    callModel: (thread, opts) => modelclient.runChat(cfg, cfg.lanes[lane].modelId, thread, {
      tools: opts.tools,
      onDelta: () => {},
      onProviderError: (provider, status, msg) => {
        process.stderr.write(`  ! provider ${provider} HTTP ${status}: ${String(msg).slice(0, 120)}\n`);
      },
    }),
  });

  console.log('\n=== REPLY ===');
  console.log(out.reply);
  console.log('\n=== STATS ===');
  console.log(`lane=${lane} steps=${out.steps} toolCalls=${out.toolCalls} tokens=${out.tokens} stopped=${out.stopped}`);
  console.log(`tools used: ${out.activity.map((a) => a.tool).join(', ') || 'NONE'}`);
  console.log(`wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\ncontains literal <tool_call>? ${out.reply.includes('<tool_call>') ? 'YES (still broken)' : 'no (fixed)'}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
