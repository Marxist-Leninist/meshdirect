// Bridges the standalone agentcaps checks into `npm test` so a future change
// to memory / skills / subagent / schedule / mcp_servers cannot break them
// silently. The detail lives in test_agentcaps.js, which runs its own harness
// against a temp state dir and exits non-zero on any failure.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('agent capabilities: memory, skills, subagent, schedule, mcp_servers', () => {
  const script = path.join(__dirname, 'test_agentcaps.js');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 180000 });
  if (run.status !== 0) {
    const failures = String(run.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join('\n');
    assert.fail(`agentcaps checks failed:\n${failures || run.stdout}\n${run.stderr || ''}`);
  }
  assert.match(String(run.stdout), /ALL AGENTCAPS TESTS PASSED/);
});
