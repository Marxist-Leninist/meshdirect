'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoalStore } = require('../server/goals.ts'.replace(/\.ts$/, '.js'));

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-test-'));
  return { dir, store: new GoalStore(dir) };
}

test('add/list/next honors priority then age', () => {
  const { store } = tmpStore();
  const a = store.add({ goal: 'low thing', priority: 1 });
  const b = store.add({ goal: 'urgent thing', why: 'matters', priority: 5 });
  const c = store.add({ goal: 'mid thing', priority: 3 });
  assert.equal(a.added, true);
  assert.equal(store.list().open, 3);
  const n = store.next();
  assert.equal(n.idle, false);
  assert.equal(n.id, b.id, 'highest priority wins');
  store.complete({ id: b.id });
  assert.equal(store.next().id, c.id, 'next is mid');
  store.complete({ id: c.id });
  store.complete({ id: a.id });
  assert.equal(store.next().idle, true, 'empty list idles cleanly');
});

test('notes append and persist across reopen', () => {
  const { dir, store } = tmpStore();
  const g = store.add({ goal: 'persist me', priority: 4 });
  store.note({ id: g.id, text: 'step one done' });
  const reopened = new GoalStore(dir);
  const n = reopened.next();
  assert.equal(n.lastNote, 'step one done');
});

test('complete/drop mutate status and open count', () => {
  const { store } = tmpStore();
  const g = store.add({ goal: 'x' });
  store.drop({ id: g.id });
  assert.equal(store.list().open, 0);
  assert.throws(() => store.note({ id: 'nope', text: 'y' }), /unknown goal id/);
});

test('goal ticker is idempotent', () => {
  const { store } = tmpStore();
  const fake = { items: [], _save() { this.saved = (this.saved || 0) + 1; } };
  const r1 = store.ensureGoalTicker(fake);
  const r2 = store.ensureGoalTicker(fake);
  assert.equal(r1.ensured, true);
  assert.equal(r2.already, true, 'second call finds existing ticker');
  assert.equal(fake.items.length, 1, 'exactly one ticker registered');
  assert.equal(fake.items[0].note, 'goal-ticker');
});
