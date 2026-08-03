// Smoke test: sign-ins survive a restart and slide forward while in use.
'use strict';
const fs = require('node:fs');
const { initAuth } = require('../server/auth');

const store = '/tmp/md-sess-smoke.json';
fs.rmSync(store, { force: true });

const cfg = {
  sessionTtlMs: 24000,            // 24s -> renew gate is 1s, so sliding is observable
  sessionStorePath: store,
  cookieName: 't', cookiePath: '/', cookieSecure: false,
  username: 'u', passwordHash: 'x', originAllow: [],
  modelLabel: '', planLabel: '', workspaceLabel: '',
  lanes: { preview: { label: 'p', detail: 'd' }, stable: { label: 's', detail: 'd' } },
};

(async () => {
  const a = initAuth(cfg);
  const { token, key } = a.store.create('tester');
  await new Promise((r) => setTimeout(r, 500));

  console.log('file written:      ', fs.existsSync(store));
  const disk = JSON.parse(fs.readFileSync(store, 'utf8'));
  console.log('sessions on disk:  ', disk.sessions.length);
  console.log('raw token on disk? ', JSON.stringify(disk).includes(token) ? 'YES (BAD)' : 'no (good, digest only)');
  console.log('file mode:         ', (fs.statSync(store).mode & 0o777).toString(8));

  // A fresh store reading the same file is exactly what a restart looks like.
  const b = initAuth(cfg);
  const revived = b.store.get(key);
  console.log('survives restart:  ', revived ? 'PASS' : 'FAIL');
  if (!revived) process.exit(1);

  const before = revived.expiresAt;
  await new Promise((r) => setTimeout(r, 1200));
  const after = b.store.get(key).expiresAt;
  console.log('sliding renewal:   ', after > before ? `PASS (+${after - before}ms)` : 'FAIL');

  b.store.destroy(key);
  await new Promise((r) => setTimeout(r, 400));
  const c = initAuth(cfg);
  console.log('logout revokes:    ', c.store.get(key) ? 'FAIL' : 'PASS');

  fs.rmSync(store, { force: true });
  process.exit(0);
})();
