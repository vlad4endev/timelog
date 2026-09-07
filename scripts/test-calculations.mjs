#!/usr/bin/env node
// Regression tests for TimeLog's core money/date/timer calculations.
//
// These extract the *actual* function source straight out of index.html (not
// a hand-copied duplicate), so a future edit that changes behavior there
// makes this test fail instead of silently drifting out of sync.
//
// Run: node scripts/test-calculations.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extract `function NAME(...) { ... }` by counting braces, skipping braces
// that appear inside string/template literals so the depth count stays correct.
function extractFunction(name) {
  const startMatch = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!startMatch) throw new Error(`Could not find function ${name} in index.html`);
  const braceStart = html.indexOf('{', startMatch.index);
  let depth = 0;
  let inString = null; // ', ", or `
  let i = braceStart;
  for (; i < html.length; i++) {
    const c = html[i];
    const prev = html[i - 1];
    if (inString) {
      if (c === inString && prev !== '\\') inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(startMatch.index, i);
}

const fnNames = ['pad', 'toDateStr', 'getWeekDates', 'getDateRange', 'roundBillableHours', 'getBillingSettings', 'mergeTimers'];
const source = fnNames.map(extractFunction).join('\n\n');

// Minimal stand-ins for the app-global `state` these functions read.
const harness = `
let state = { settings: { billableIncrement: 0.25, roundMode: 'up', minBillable: 0 } };
${source}
globalThis.__test = { toDateStr, getWeekDates, getDateRange, roundBillableHours, mergeTimers, setSettings: (s) => Object.assign(state.settings, s) };
`;
// eslint-disable-next-line no-eval
(0, eval)(harness);
const t = globalThis.__test;

let pass = 0, fail = 0;
function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.error(`FAIL: ${desc}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// ── toDateStr: local calendar date, not UTC ────────────────────────────────
check('toDateStr formats a known local date', t.toDateStr(new Date(2026, 6, 4)), '2026-07-04');
check('toDateStr pads single-digit month/day', t.toDateStr(new Date(2026, 0, 5)), '2026-01-05');

// ── getDateRange: inclusive local-date range, no UTC drift ─────────────────
check('getDateRange single day', t.getDateRange('2026-07-01', '2026-07-01'), ['2026-07-01']);
check('getDateRange three days', t.getDateRange('2026-07-01', '2026-07-03'), ['2026-07-01', '2026-07-02', '2026-07-03']);

// ── getWeekDates: Monday-start week containing "now" ───────────────────────
{
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(2026, 6, 4); } }; // Saturday
  check('getWeekDates spans Mon–Sun for a Saturday "now"', t.getWeekDates(), { start: '2026-06-29', end: '2026-07-05' });
  global.Date = RealDate;
}

// ── roundBillableHours: increment/mode/minimum interactions ────────────────
t.setSettings({ billableIncrement: 0.25, roundMode: 'up', minBillable: 0 });
check('rounds up to the next increment', t.roundBillableHours(0.9), 1);
check('exact multiple stays put (no float drift)', t.roundBillableHours(1.0), 1);

t.setSettings({ billableIncrement: 0.25, roundMode: 'nearest', minBillable: 0.5 });
check('minBillable floors a short session rounded to exactly 0', t.roundBillableHours(2 / 60), 0.5);

t.setSettings({ billableIncrement: 0.25, roundMode: 'nearest', minBillable: 0 });
check('nearest-mode can legitimately round down to 0 with no minimum', t.roundBillableHours(5 / 60), 0);

check('no time logged bills nothing', t.roundBillableHours(0), 0);

// ── mergeTimers: freshest updatedAt wins regardless of running state ───────
{
  const staleRunning = { running: true, updatedAt: 1000 };
  const freshStopped = { running: false, updatedAt: 2000 };
  check('a fresh stop overrides a stale cached "still running" state', t.mergeTimers(staleRunning, freshStopped), freshStopped);

  const freshRunning = { running: true, updatedAt: 5000 };
  const staleStopped = { running: false, updatedAt: 1000 };
  check('a fresh start overrides a stale cached "stopped" state', t.mergeTimers(freshRunning, staleStopped), freshRunning);

  check('missing remote keeps local', t.mergeTimers(freshRunning, null), freshRunning);
  check('missing local takes remote', t.mergeTimers(null, freshRunning), freshRunning);
}

// ── saveEntry: an edit must not silently unlink a billed entry ─────────────
// sb.entryToRow() maps every column on every write (report_id, archived
// included), so any field saveEntry forgets to carry over from the existing
// entry gets pushed to the server as its falsy default. Editing an entry that
// belongs to a paid report would then hand it back as unbilled and deletable.
{
  const saveEntrySource = ['getBillingSettings', 'roundBillableHours', 'saveEntry'].map(extractFunction).join('\n\n');
  const fields = {
    'entry-project': 'p1', 'entry-task': 'Reworded task', 'entry-date': '2026-07-04',
    'entry-hours': '3', 'entry-edit-id': 'e1', 'entry-notes': 'edited',
    'entry-task-id': '', 'entry-start': '', 'entry-end': ''
  };
  const billed = {
    id: 'e1', projectId: 'p1', task: 'Original task', date: '2026-07-01', hours: 2,
    rate: 50, start: '', end: '', notes: '', taskId: null,
    reportId: 'r1', archived: true, createdAt: 1700000000000
  };
  const pushed = [];
  const saveEntryHarness = `
let state = { entries: [${JSON.stringify(billed)}], settings: { billableIncrement: 0.25, roundMode: 'up', minBillable: 0 } };
const document = { getElementById: (id) => (${JSON.stringify(fields)}).hasOwnProperty(id) ? { value: ${JSON.stringify(fields)}[id] } : null };
const sb = { isEnabled: () => true, upsertEntry: (e) => globalThis.__pushed.push(e), upsertBoardTask: () => {} };
const getProject = () => ({ rate: 99 });
const getBoardTask = () => null;
const uid = () => 'new-id';
const fmtDuration = (h) => String(h);
const showToast = () => {}, save = () => {}, closeModal = () => {}, renderPage = () => {}, checkProjectHourLimit = () => {};
${saveEntrySource}
globalThis.__saveEntry = saveEntry;
globalThis.__state = state;
`;
  globalThis.__pushed = pushed;
  // eslint-disable-next-line no-eval
  (0, eval)(saveEntryHarness);
  globalThis.__saveEntry();

  const saved = globalThis.__state.entries.find(e => e.id === 'e1');
  check('an edit keeps the entry linked to its report', saved.reportId, 'r1');
  check('an edit keeps a paid entry archived', saved.archived, true);
  check('the edit actually applied', [saved.task, saved.hours], ['Reworded task', 3]);
  check('the row pushed to the server still carries the report link', [pushed.length, pushed[0]?.reportId, pushed[0]?.archived], [1, 'r1', true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
