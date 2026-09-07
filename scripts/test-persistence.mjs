#!/usr/bin/env node
// Regression tests for the two ways TimeLog used to lose data:
//
//   1. save() scheduled a user-settings push, and that push called save()
//      again — an endless save↔push chain (~250 POSTs/s) that tripped the
//      server rate limiter, after which NOTHING saved.
//   2. Writes were fire-and-forget: one HTTP request per row, no retry, and
//      the next pull replaced local state wholesale — so any write the
//      server didn't take just vanished.
//
// Like test-calculations.mjs, this runs the *actual* source out of
// index.html, so a future edit that reintroduces either bug fails here.
//
// Run: node scripts/test-persistence.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** Slice out a balanced `{...}` block starting at the first brace after `anchor`. */
function extractBlock(anchor) {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  let depth = 0, inString = null, inLine = false, i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    const c = html[i], prev = html[i - 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inString) { if (c === inString && prev !== '\\') inString = null; continue; }
    if (c === '/' && html[i + 1] === '/') { inLine = true; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(html.indexOf('{', start), i);
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── Harness: real save() + scheduleUserSettingsSync() + the real sb outbox ──
function makeApp(opts = {}) {
  if (opts.sendOk === undefined) opts.sendOk = true;
  const stats = { saves: 0, sends: 0, bodies: [] };
  const state = {
    projects: [], entries: [], payments: [], boardTasks: [], reports: [],
    schedule: { blocks: [], overrides: {} }, timer: {}, tombstones: {},
    settings: {
      defaultRate: 0, currency: 'RUB', billableIncrement: 0.25, roundMode: 'up',
      minBillable: 0, aiPrompt: '', profile: {}, projectHourAlerts: {},
      openrouter: {}, supabase: { enabled: true, url: 'https://x', anonKey: 'k' },
    },
  };
  const store = new Map();
  const localStorage = {
    setItem(k, v) { if (k.startsWith('timelog_v1')) stats.saves++; store.set(k, v); },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    removeItem(k) { store.delete(k); },
  };
  const auth = {
    getLogin: () => 'u', dataKey: (l) => `timelog_v1_${l}`,
    useServerAuth: () => true, isLoggedIn: () => true, getApiToken: () => 'tok',
    authFetch: async (_p, body) => { stats.sends++; stats.bodies.push(body); return { ok: opts.sendOk, status: opts.sendOk ? 200 : (opts.status || 500) }; },
  };
  const src = [
    'function userSettingsForRemote()' , 'let userSettingsSyncTimer = null;', 'function save(opts = {}) {',
  ].map(a => {
    if (a.startsWith('let ')) {
      const from = html.indexOf(a);
      return html.slice(from, html.indexOf('let saveQuotaWarned', from));
    }
    return a.startsWith('function save') ? 'function save(opts = {}) ' + extractBlock(a) : a + ' ' + extractBlock(a);
  }).join('\n');
  const sbSrc = 'const sb = ' + extractBlock('const sb = {') + ';';
  const globals = { state, localStorage, auth, showToast() {}, clearTimeout, setTimeout, console, JSON, Date, Object, Number, encodeURIComponent, fetch: async () => ({ ok: false }) };
  const names = Object.keys(globals);
  const factory = new Function(...names,
    'let entityLocalEdits = {}; let saveQuotaWarned = false;\n' + src + '\n' + sbSrc +
    '\nreturn { save, sb, state, stats: null, scheduleUserSettingsSync };');
  const app = factory(...names.map(n => globals[n]));
  app.stats = stats;
  app.store = store;
  app.opts = opts;
  return app;
}

const tick = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\nsave() must not loop into an endless settings push');
{
  const app = makeApp();
  app.save();
  await tick(400);
  // Pre-fix this was ~250 localStorage writes and ~250 POSTs in 300ms, forever.
  check('one edit = a handful of local saves, not hundreds', app.stats.saves < 5, true);
  check('one edit = at most one settings push', app.stats.sends <= 1, true);
}

console.log('\noutbox batches a burst into ONE request');
{
  const app = makeApp();
  for (let i = 0; i < 40; i++) app.sb._queueUpsert('time_entries', 'e' + i, { id: 'e' + i });
  await tick(700);
  check('40 row writes → 1 POST', app.stats.sends, 1);
  const body = app.stats.bodies.find(b => b.upserts?.time_entries);
  check('all 40 rows in that one POST', body.upserts.time_entries.length, 40);
  check('nothing left pending after success', app.sb.hasPendingWrites(), false);
}

console.log('\na rejected write is kept, not dropped');
{
  const app = makeApp({ sendOk: false });
  app.sb._queueUpsert('projects', 'p1', { id: 'p1', name: 'Keep me' });
  await tick(700);
  check('write stays pending so a pull cannot overwrite it', app.sb.hasPendingWrites(), true);
  const persisted = JSON.parse(app.store.get(app.sb._outKey()) || 'null');
  check('and it survives a reload (persisted to localStorage)', persisted?.upserts?.projects?.p1?.name, 'Keep me');
}

console.log('\na delete cancels a queued upsert of the same row');
{
  const app = makeApp();
  app.sb._queueUpsert('projects', 'p1', { id: 'p1' });
  app.sb._queueDelete('projects', 'p1');
  await tick(700);
  const body = app.stats.bodies[0];
  check('no upsert for the deleted row', body.upserts.projects, undefined);
  check('delete is sent', body.deletes, [{ table: 'projects', id: 'p1' }]);
}

console.log('\nthe timer uses one slot, so the last action wins');
{
  const app = makeApp();
  app.state.timer = { running: true, startTime: 1, updatedAt: 2 };
  app.sb._queueClearTimer();                       // stop
  app.sb.upsertTimer({ running: true, startTime: 9, updatedAt: 9 });  // then start again
  await tick(700);
  const body = app.stats.bodies[0];
  check('one active_timer row, the newest', body.upserts.active_timer.length, 1);
  check('and it is the start, not the stop', body.upserts.active_timer[0].running, true);
}

console.log('\na failed write is retried and eventually drains');
{
  const app = makeApp({ sendOk: false });
  app.sb._queueUpsert('projects', 'p1', { id: 'p1' });
  await tick(700);
  check('still pending while the server is down', app.sb.hasPendingWrites(), true);
  app.opts.sendOk = true;
  await app.sb.flushWrites();
  check('drains once the server is back', app.sb.hasPendingWrites(), false);
  check('and the persisted copy is cleared', app.store.get(app.sb._outKey()), undefined);
}

console.log('\nthe service worker never answers an API GET from its cache');
{
  // A cached /auth/sync/pull was the third way data got lost: push succeeded,
  // then the next reload was handed the pre-edit dataset out of the SW cache
  // and persisted it over the real one — every edit "came back" on refresh.
  const swSrc = readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const listeners = {};
  const fakeSelf = {
    navigator: { userAgent: 'node' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: {}, clients: {},
    location: { origin: 'https://example.test' },
  };
  const fakeCaches = { open: async () => ({ put: async () => {}, addAll: async () => {} }), match: async () => null, keys: async () => [] };
  new Function('self', 'caches', 'indexedDB', 'fetch', swSrc)(
    fakeSelf, fakeCaches, { open: () => ({}) }, async () => null
  );

  const intercepted = (pathname, method = 'GET') => {
    let handled = false;
    listeners.fetch({
      request: { url: `https://example.test${pathname}`, method, mode: 'cors' },
      respondWith: () => { handled = true; },
    });
    return handled;
  };

  check('/auth/sync/pull is not intercepted', intercepted('/auth/sync/pull'), false);
  check('/rest/v1/time_entries is not intercepted', intercepted('/rest/v1/time_entries'), false);
  check('the app shell still is (offline boot)', intercepted('/index.html'), true);
  check('icons still are', intercepted('/icon-192.png'), true);
}

console.log('\na throttled write backs off instead of hammering');
{
  // 429 is the rate limiter, not a dead link. Retrying every 5s kept its
  // bucket empty, so every save stayed rejected and the app told the user
  // there was no connection — for as long as they kept working.
  const app = makeApp({ sendOk: false, status: 429 });
  app.sb._queueUpsert('projects', 'p1', { id: 'p1' });
  await tick(700);
  check('the write is still pending', app.sb.hasPendingWrites(), true);
  check('retry waits out the limiter window', app.sb._retryDelayFor(429), 60000);
  check('a plain failure still retries fast', app.sb._retryDelayFor(500), 5000);
  const sendsAfterFirstTry = app.stats.sends;
  await tick(600);
  check('and it does not retry in the meantime', app.stats.sends, sendsAfterFirstTry);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
