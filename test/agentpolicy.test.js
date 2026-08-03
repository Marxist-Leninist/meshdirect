'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_SYSTEM_PROMPT } = require('../server/agentpolicy');

test('default policy owns broad goals through execution and verification', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /fully autonomous/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Own every requested outcome end to end/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /safe, reversible, in-scope work/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Do not wait for step-by-step instructions/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Do not stop at a plan, diagnosis/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /keep going until the goal is complete/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /verify the live result/i);
});

test('default policy keeps explicit authority and safety boundaries', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /destructive or irreversible action/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /using new credentials/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /acquiring new authority/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /never bypass access controls/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /never .* expose secrets/i);
});

test('default policy retains concrete SG tool routing instructions', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /sg1 remote_exec tool with server="geth"/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /action='search'/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /action='call'/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never print <tool_call> markup/i);
  assert.ok(DEFAULT_SYSTEM_PROMPT.length < 5000);
});
