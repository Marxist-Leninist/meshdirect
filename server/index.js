// MeshDirect entry point.
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const modelclient = require('./modelclient');
const { createApp } = require('./app');

const log = (message) => console.log(`[meshdirect ${new Date().toISOString()}] ${message}`);

for (const dir of [
  config.sessionsDir,
  config.tmpDir,
  path.join(config.workspaceRoot, 'preview'),
  path.join(config.workspaceRoot, 'stable'),
  '/opt/meshdirect/logs',
]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

modelclient.loadFallbackKey(config, log);

const { app } = createApp(config, log);
const server = app.listen(config.port, config.host, () => {
  log(`MeshDirect 2.0 listening on http://${config.host}:${config.port} (base ${config.basePath}, cookie ${config.cookieName})`);
});

function shutdown(signal) {
  log(`${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error && error.stack ? error.stack : error}`);
});
