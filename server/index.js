// meshdirect entry point
'use strict';
const fs = require('fs');
const config = require('./config');
const modelclient = require('./modelclient');
const sessions = require('./sessions');
const { createApp } = require('./app');

const log = (msg) => console.log(`[meshdirect ${new Date().toISOString()}] ${msg}`);

fs.mkdirSync(config.sessionsDir, { recursive: true, mode: 0o700 });
sessions.failPending(config, log);

modelclient.loadFallbackKey(config, log);

const { app } = createApp(config, log);
const server = app.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (base ${config.basePath}, cookie ${config.cookieName})`);
});

process.on('SIGTERM', () => { log('SIGTERM, shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
process.on('SIGINT', () => process.kill(process.pid, 'SIGTERM'));
