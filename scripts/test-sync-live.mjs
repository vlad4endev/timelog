#!/usr/bin/env node
// Live probe: drives the REAL docker/auth-server.mjs over HTTP against a
// recording Postgres stub (scripts/test-support/pg-stub.mjs), so these are
// behavioural assertions, not source-text ones. It exists because the
// source-level suite happily passed while the 413 path was broken: it saw
// MAX_BODY_BYTES and "413" in the file and never noticed the server was
// destroying the socket before the response could be delivered.
//
// Covers, in order: FK-safe upsert ordering, cross-tenant write rejection,
// id-keyed deletes, the 413 path, and that a DB error yields a 500 instead
// of killing the process.
//
// Run: node --import ./scripts/test-support/pg-loader.mjs scripts/test-sync-live.mjs
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.AUTH_PORT = '31999';
process.env.AUTH_MAX_BODY_BYTES = '4096';

import pgstub from 'pg';
import { SignJWT } from 'jose';
await import('../docker/auth-server.mjs');
await new Promise(r => setTimeout(r, 300));

const key = new TextEncoder().encode(process.env.JWT_SECRET);
const tok = (login) => new SignJWT({ role: 'timelog_user', login, sub: login })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt()
  .setIssuer('timelog').setExpirationTime('1h').sign(key);

const B = 'http://127.0.0.1:31999';
async function push(login, body) {
  const r = await fetch(`${B}/auth/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok(login)}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let ok = 0, bad = [];
const t = (n, c, d = '') => c ? ok++ : bad.push(d ? `${n} — ${d}` : n);

// ── 1. Entries listed BEFORE their project must still land ──────────────
pgstub.__log.length = 0;
let r = await push('alice', { upserts: {
  time_entries: [{ id: 'e1', project_id: 'p1', task: 't', date: '2026-01-05', hours: 2 }],
  projects: [{ id: 'p1', name: 'P', rate: 100 }],
}});
t('out-of-order push succeeds', r.status === 200, JSON.stringify(r));
const inserts = pgstub.__log.filter(q => q.sql.startsWith('INSERT INTO')).map(q => /INSERT INTO (\w+)/.exec(q.sql)[1]);
t('projects inserted before time_entries', inserts.indexOf('projects') < inserts.indexOf('time_entries'), inserts.join(' → '));
t('alice owns p1', pgstub.__rows.get('projects:p1')?.user_login === 'alice');

// ── 2. Bob cannot claim alice's login, nor overwrite her row by id ──────
r = await push('bob', { upserts: {
  projects: [
    { id: 'p1', name: 'HIJACKED', user_login: 'alice' },
    { id: 'p2', name: 'bob-owned', user_login: 'alice' },
  ],
  user_settings: [{ id: 'alice', settings: { stolen: true } }],
  active_timer: [{ id: 'alice', running: true }],
}});
t('bob push accepted (no error leaked)', r.status === 200, JSON.stringify(r));
t("alice's p1 not overwritten", pgstub.__rows.get('projects:p1')?.params[1] === 'P',
  String(pgstub.__rows.get('projects:p1')?.params[1]));
t("bob's forged row is owned by bob", pgstub.__rows.get('projects:p2')?.user_login === 'bob',
  String(pgstub.__rows.get('projects:p2')?.user_login));
t("alice's user_settings untouched", pgstub.__rows.get('user_settings:bob') && !pgstub.__rows.get('user_settings:alice'),
  [...pgstub.__rows.keys()].filter(k => k.startsWith('user_settings')).join(','));
t("alice's timer untouched", pgstub.__rows.get('active_timer:bob') && !pgstub.__rows.get('active_timer:alice'),
  [...pgstub.__rows.keys()].filter(k => k.startsWith('active_timer')).join(','));

// ── 3. Deleting an id-keyed table must not reference user_login ─────────
pgstub.__log.length = 0;
r = await push('alice', { deletes: [{ table: 'user_settings', id: 'bob' }] });
t('id-keyed delete does not 500', r.status === 200, JSON.stringify(r));
const del = pgstub.__log.find(q => q.sql.startsWith('DELETE FROM user_settings'));
t('id-keyed delete scoped to session login', del && del.params[0] === 'alice' && !/user_login/.test(del.sql),
  JSON.stringify(del));

// ── 4. Oversized body → JSON 413, service still alive ──────────────────
const big = await fetch(`${B}/auth/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok('alice')}` },
  body: JSON.stringify({ upserts: { projects: [{ id: 'b', name: 'z'.repeat(9000) }] } }),
}).catch(e => ({ status: 'network:' + e.message }));
t('oversized body → 413', big.status === 413, String(big.status));
const alive = await fetch(`${B}/auth/health`).then(r => r.status).catch(() => 0);
t('service alive after 413', alive === 200, String(alive));

// ── 5. A DB error becomes a 500, not a dead process ────────────────────
// The server logs this one on purpose; muffle it so a passing run doesn't
// print a stack trace that reads like a failure.
const realError = console.error;
console.error = () => {};
r = await push('alice', { upserts: { time_entries: [{ id: 'e9', project_id: 'ghost', task: 't', date: '2026-01-01', hours: 1 }] } });
console.error = realError;
t('FK violation → 500, handled', r.status === 500, JSON.stringify(r));
t('process still running', (await fetch(`${B}/auth/health`)).status === 200);

console.log(`\n${bad.length ? '✕' : '✓'} live probe: ${ok} passed, ${bad.length} failed`);
bad.forEach(b => console.log('  ✕ ' + b));
process.exit(bad.length ? 1 : 0);
