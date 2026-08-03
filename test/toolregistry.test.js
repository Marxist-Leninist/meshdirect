'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeTool, getToolDefinitions } = require('../server/toolregistry');

const root = '/tmp/meshdirect-tool-test';
const config = {
  workspaceRoot: root,
  tmpDir: path.join(root, 'tmp'),
  toolTimeoutMs: 5000,
  toolOutputMaxChars: 10000,
  maxWriteChars: 100000,
  sgMcpCli: '/usr/local/bin/qwen38-mcp',
};
fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
fs.mkdirSync(config.tmpDir, { recursive: true });

test('registry exposes owned tools including SG1/SG2 bridge', () => {
  const names = getToolDefinitions().map((tool) => tool.function.name);
  assert.deepEqual(names, ['exec', 'read_file', 'write_file', 'list_files', 'web_fetch', 'sg_mcp']);
});

test('exec runs exact Bash in model workspace', async () => {
  const result = await executeTool(config, 'preview', { function: { name: 'exec', arguments: JSON.stringify({ command: "printf 'mesh-ok'" }) } });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.stdout, 'mesh-ok');
  assert.equal(parsed.exitCode, 0);
});

test('write_file and read_file round trip', async () => {
  const write = await executeTool(config, 'preview', { function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hello mesh' }) } });
  assert.equal(write.ok, true);
  const read = await executeTool(config, 'preview', { function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } });
  assert.equal(read.ok, true);
  assert.equal(JSON.parse(read.content).content, 'hello mesh');
});
