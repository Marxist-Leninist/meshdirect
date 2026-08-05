'use strict';

/* GoalStore: the agent's own durable goal list (kimi 2026-08-05).
 *
 * The agent picks its own goals here and follows them: a recurring
 * "goal ticker" wake (registered with the SelfScheduler) nudges it to
 * take the top open goal and work it for a bounded burst, noting progress.
 * Survives restarts via goals.json in the agentcaps state dir.
 */

const fs = require('fs');
const path = require('path');

const GOAL_TICKER_NOTE = 'goal-ticker';
const GOAL_TICKER_EVERY_MS = 30 * 60 * 1000;
const GOAL_TICKER_PROMPT = [
  'Goal ticker wake. Call goals action=next, pick the top open goal, and work it',
  'for one bounded burst (a few tool calls, not an epic). Then goals action=note',
  'with what moved. If a goal is genuinely done, goals action=complete. If nothing',
  'is open, finish with a one-line idle report.',
].join(' ');

function nowMs() { return Date.now(); }
function rid(prefix) { return `${prefix}_${nowMs().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function str(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

class GoalStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'goals.json');
    this.items = readJson(this.file, []);
    if (!Array.isArray(this.items)) this.items = [];
  }

  _save() { writeJson(this.file, this.items); }

  _find(id) {
    const goal = this.items.find((g) => g.id === id);
    if (!goal) throw new Error(`unknown goal id ${id}`);
    return goal;
  }

  add({ goal, why = '', priority = 3 }) {
    const body = str(goal, 2000).trim();
    if (!body) throw new Error('goals.add needs the goal text');
    const item = {
      id: rid('goal'),
      goal: body,
      why: str(why, 1000),
      priority: clampInt(priority, 3, 1, 5),
      status: 'open',
      createdAt: nowMs(),
      updatedAt: nowMs(),
      notes: [],
    };
    this.items.push(item);
    this._save();
    return { added: true, id: item.id, priority: item.priority, open: this.items.filter((g) => g.status === 'open').length };
  }

  list() {
    const open = this.items.filter((g) => g.status === 'open');
    return {
      total: this.items.length,
      open: open.length,
      goals: this.items.slice(-50).map((g) => ({
        id: g.id, goal: g.goal, why: g.why, priority: g.priority, status: g.status,
        notes: g.notes.length,
        createdAt: new Date(g.createdAt).toISOString(),
        updatedAt: new Date(g.updatedAt).toISOString(),
      })),
    };
  }

  next() {
    const open = this.items.filter((g) => g.status === 'open');
    if (!open.length) return { idle: true, message: 'No open goals. Either finish something or pick a goal worth having.' };
    open.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
    const g = open[0];
    return {
      idle: false,
      id: g.id,
      goal: g.goal,
      why: g.why,
      priority: g.priority,
      lastNote: g.notes.length ? g.notes[g.notes.length - 1].text : null,
      instruction: 'Work this goal for one bounded burst, then goals action=note the progress.',
    };
  }

  note({ id, text }) {
    const g = this._find(id);
    const body = str(text, 2000).trim();
    if (!body) throw new Error('goals.note needs the progress text');
    g.notes.push({ at: nowMs(), text: body });
    if (g.notes.length > 50) g.notes = g.notes.slice(-50);
    g.updatedAt = nowMs();
    this._save();
    return { noted: true, id: g.id, notes: g.notes.length };
  }

  complete({ id }) {
    const g = this._find(id);
    g.status = 'done';
    g.updatedAt = nowMs();
    this._save();
    return { completed: true, id: g.id, open: this.items.filter((x) => x.status === 'open').length };
  }

  drop({ id }) {
    const g = this._find(id);
    g.status = 'dropped';
    g.updatedAt = nowMs();
    this._save();
    return { dropped: true, id: g.id };
  }

  digest(max = 5) {
    const open = this.items.filter((g) => g.status === 'open')
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))
      .slice(0, max);
    if (!open.length) return '';
    return open.map((g) => `- [p${g.priority}] ${g.goal} (${g.id})`).join('\n');
  }

  /* Ensure one recurring goal-ticker wake exists in the SelfScheduler's store.
     Idempotent: looks for an enabled item with the marker note. */
  ensureGoalTicker(scheduler) {
    if (!scheduler || !Array.isArray(scheduler.items)) return { ensured: false, reason: 'no scheduler' };
    const existing = scheduler.items.find((s) => s.note === GOAL_TICKER_NOTE && s.enabled);
    if (existing) return { ensured: true, id: existing.id, already: true };
    const item = {
      id: rid('wake'),
      prompt: GOAL_TICKER_PROMPT,
      note: GOAL_TICKER_NOTE,
      model: 'preview',
      everyMs: GOAL_TICKER_EVERY_MS,
      nextRunAt: nowMs() + GOAL_TICKER_EVERY_MS,
      enabled: true,
      createdAt: nowMs(),
      lastRunAt: null,
      runs: 0,
      lastError: null,
    };
    scheduler.items.push(item);
    scheduler._save();
    return { ensured: true, id: item.id, everySeconds: GOAL_TICKER_EVERY_MS / 1000 };
  }
}

module.exports = { GoalStore, GOAL_TICKER_NOTE };
