#!/usr/bin/env node
// Regression tests for the /auth/sync/push path — the three ways it could
// lose or leak data:
//
//   1. Ownership was taken from the request body (`r.user_login || login`,
//      `r.id || login`), so any valid token could write into another
//      account. RLS does not cover this path: the auth service connects as
//      the Postgres superuser owner, and superusers bypass RLS entirely.
//   2. Upserts ran in the client's JSON key order, so a batch that listed
//      time_entries before projects hit a foreign-key violation, rolled the
//      whole transaction back, and the client retried it forever.
//   3. Deletes for the id-keyed tables were scoped with `AND user_login`,
//      a column those tables don't have — one such delete aborted the
//      entire push.
//
// The FK order check derives its expectations from the SQL schema, so a new
// migration that adds a reference fails here rather than in production.
//
// Run: node scripts/test-sync-server.mjs

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(root, 'docker/auth-server.mjs'), 'utf8');
const initDir = path.join(root, 'docker/postgres/init');
const schema = readdirSync(initDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(initDir, f), 'utf8'))
  .join('\n');

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
}

// ─── 1. Ownership comes from the session, never the payload ──────────────
// match[0] is the whole match, so the capture groups start at index 1.
for (const [, name, body] of server.matchAll(
  /async function (upsert\w+Row)\(client, login, r\) \{([\s\S]*?)\n\}\n/g
)) {
  check(
    `${name}: owner not read from the request body`,
    !/r\.user_login/.test(body) && !/r\.id\s*\|\|\s*login/.test(body),
    'found r.user_login or `r.id || login` — a client can claim another account'
  );
  check(
    `${name}: DO UPDATE does not rewrite user_login from EXCLUDED`,
    !/user_login = EXCLUDED\.user_login/.test(body),
    'lets a colliding id move a row between accounts'
  );
}

// Every user_login-scoped upsert must refuse to update a row it does not own.
const ownedTables = {
  upsertProjectRow: 'projects',
  upsertEntryRow: 'time_entries',
  upsertPaymentRow: 'payments',
  upsertBoardTaskRow: 'board_tasks',
  upsertReportRow: 'billing_reports',
  upsertScheduleBlockRow: 'schedule_blocks',
};
for (const [fn, table] of Object.entries(ownedTables)) {
  const m = server.match(
    new RegExp(`async function ${fn}\\(client, login, r\\) \\{([\\s\\S]*?)\\n\\}\\n`)
  );
  check(`${fn}: exists`, !!m);
  if (!m) continue;
  const body = m[1];
  const guard = body.match(new RegExp(`WHERE ${table}\\.user_login = \\$(\\d+)`));
  check(
    `${fn}: ON CONFLICT guarded by owner`,
    !!guard,
    `no "WHERE ${table}.user_login = $n" — a guessed id overwrites another user's row`
  );
  if (!guard) continue;
  const maxParam = Math.max(...[...body.matchAll(/\$(\d+)/g)].map((x) => +x[1]));
  check(
    `${fn}: owner guard uses the session login parameter`,
    +guard[1] === maxParam,
    `guard is $${guard[1]} but the last parameter is $${maxParam}`
  );
}

// ─── 2. Upsert order satisfies the schema's foreign keys ─────────────────
const order = (server.match(/const UPSERT_ORDER = \[([\s\S]*?)\];/) || [, ''])[1]
  .split(',')
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);
check('UPSERT_ORDER is defined', order.length > 0);

const handlers = (server.match(/const UPSERT_HANDLERS = \{([\s\S]*?)\n\};/) || [, ''])[1];
const handled = [...handlers.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
check(
  'UPSERT_ORDER covers every handler',
  handled.every((t) => order.includes(t)),
  `missing from order: ${handled.filter((t) => !order.includes(t)).join(', ')}`
);

// Pull the real FK edges (child -> parent) out of the CREATE TABLE bodies.
const edges = [];
for (const m of schema.matchAll(
  /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g
)) {
  const child = m[1];
  for (const ref of m[2].matchAll(/REFERENCES\s+(\w+)\s*\(/g)) {
    if (ref[1] !== child) edges.push([child, ref[1]]);
  }
}
check('schema FK edges were found', edges.length >= 4, `only ${edges.length} parsed`);
for (const [child, parent] of edges) {
  if (!order.includes(child) || !order.includes(parent)) continue;
  check(
    `FK order: ${parent} inserted before ${child}`,
    order.indexOf(parent) < order.indexOf(child),
    'the whole push transaction rolls back on this FK and the client retries it forever'
  );
}

// ─── 3. id-keyed tables are deleted by login, not by client id ───────────
const idKeyed = (server.match(/const ID_KEYED_TABLES = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1];
for (const t of ['active_timer', 'schedule_settings', 'user_settings']) {
  check(`${t} is treated as id-keyed on delete`, idKeyed.includes(t));
  check(
    `${t} has no user_login column in the schema (so the guard is required)`,
    !new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS user_login`).test(schema)
  );
}
check(
  'id-keyed delete uses the session login as the id',
  /DELETE FROM \$\{del\.table\} WHERE id = \$1`, \[login\]\)/.test(server),
  'must be [login], never [del.id]'
);

// ─── 3b. Bulk pull must not carry the unbounded attachment column ────────
const pullFn = (server.match(/async function pullUserData\(login\) \{([\s\S]*?)\n\}\n/) || [, ''])[1];
check('pullUserData exists', pullFn.length > 0);
check(
  'projects are not SELECT *-ed in the pull',
  !/SELECT \* FROM projects/.test(pullFn),
  'SELECT * drags spec_file_data (base64 attachments) into every sync'
);
check(
  'the pull still reports that an attachment exists',
  /spec_file_name/.test(pullFn),
  'the client needs the name to show the attachment at all'
);
check(
  'attachment bytes are served by their own owner-scoped endpoint',
  /\/auth\/sync\/spec/.test(server) &&
    /FROM projects WHERE id = \$1 AND user_login = \$2/.test(server),
  'must be scoped to the session login, or a guessed id leaks another account\'s file'
);

// ─── 4. Crash-safety and resource bounds ─────────────────────────────────
check(
  'request handler has a catch-all (an async throw here kills the process)',
  /handleRequest\(req, res\)\.catch\(/.test(server)
);
check(
  "pool has an 'error' listener (idle-client errors are fatal without one)",
  /pool\.on\('error'/.test(server)
);
check('request bodies are capped', /MAX_BODY_BYTES/.test(server) && /413/.test(server));
check(
  'pull runs on one client, not Promise.all across the pool',
  !/const \[\s*\n?\s*projects,/.test(server) &&
    /BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY/.test(server)
);
check(
  'rate limiter is not keyed on the client-controlled first XFF hop',
  /x-real-ip/.test(server) && /hops\[hops\.length - 1\]/.test(server)
);

console.log(`\n${failures.length ? '✕' : '✓'} sync server: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✕ ${f}`);
process.exit(failures.length ? 1 : 0);
