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
function extractConst(name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(html);
  if (!m) throw new Error(`Could not find const ${name} in index.html`);
  return `const ${name} = ${scanBlock(html.indexOf('{', m.index))};`;
}

function scanBlock(braceStart) {
  let depth = 0, inString = null, inLine = false, i = braceStart;
  for (; i < html.length; i++) {
    const c = html[i], prev = html[i - 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inString) { if (c === inString && prev !== '\\') inString = null; continue; }
    if (c === '/' && html[i + 1] === '/') { inLine = true; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(braceStart, i);
}

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

// ── commitTimerEntry: what actually lands in the time log ─────────────────
// Guards the three ways the recorded interval used to be wrong: a paused
// session inventing a start time, a second "stop" writing a duplicate entry,
// and a corrected duration not being honoured.
{
  const src = ['commitTimerEntry'].map(extractFunction).join('\n');
  const START = new Date(2026, 6, 4, 9, 0, 0).getTime();
  const mk = (extra = {}) => {
    const st = {
      entries: [], projects: [{ id: 'p1', name: 'P', rate: 100 }],
      settings: { billableIncrement: 0.25, roundMode: 'up', minBillable: 0, currency: 'RUB' },
      timer: { running: true, startTime: START, projectId: 'p1', task: 'Работа', taskId: null,
               paused: false, pausedMs: 0, pauseStart: null, updatedAt: START, ...extra },
    };
    const calls = { reset: 0 };
    const env = `
      let state = ${JSON.stringify(st)};
      const calls = { reset: 0 };
      ${extractFunction('pad')}
      ${extractFunction('toDateStr')}
      ${extractFunction('getBillingSettings')}
      ${extractFunction('roundBillableHours')}
      function uid() { return 'fixed-id'; }
      function getProject(id) { return state.projects.find(p => p.id === id); }
      function calcEntryAmount() { return 0; }
      function fmtHours() { return ''; } function fmtMoney() { return ''; } function fmtDuration() { return ''; }
      function save() {} function renderPage() {} function checkProjectHourLimit() {}
      function showToast() {} function resetTimerState() { calls.reset++; state.timer.running = false; }
      const sb = { isEnabled: () => false, upsertEntry() {} };
      ${src}
      ({ commitTimerEntry, state, calls });
    `;
    return (0, eval)(env);
  };

  {
    const app = mk();
    const ok = app.commitTimerEntry(2);            // 2 фактических часа
    check('commitTimerEntry saves one entry', [ok, app.state.entries.length], [true, 1]);
    const e = app.state.entries[0];
    check('start is the real timer start, not end-minus-worked', e.start, '09:00');
    check('end is start + the recorded duration', e.end, '11:00');
    check('date comes from the start, not "now"', e.date, '2026-07-04');
    check('hours are the billable, rounded value', e.hours, 2);
    check('timer is reset exactly once', app.calls.reset, 1);
  }
  {
    // A paused session used to record end=now / start=now-worked, describing
    // an interval that never happened.
    const app = mk({ paused: true, pauseStart: START + 3600000, pausedMs: 1800000 });
    app.commitTimerEntry(1);
    check('a paused session still starts at the real start time', app.state.entries[0].start, '09:00');
  }
  {
    const app = mk();
    app.commitTimerEntry(1);
    const again = app.commitTimerEntry(1);          // e.g. notification "stop" after the dialog
    check('a second stop cannot write a duplicate entry', [again, app.state.entries.length], [false, 1]);
  }
  {
    const app = mk();
    app.commitTimerEntry(0.4);                       // corrected down from a forgotten timer
    check('a corrected duration is what gets billed', app.state.entries[0].hours, 0.5);
  }
}

// ── idleWatch: сколько времени вычесть за отсутствие за компьютером ───────
{
  const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime();
  const mkIdle = (timer = {}) => {
    const st = {
      settings: { idleDetection: true, idleThresholdMin: 10 },
      timer: { running: true, startTime: NOW - 3 * 3600000, paused: false, idleMs: 0, idleSince: null, ...timer },
    };
    const env = `
      const window = { IdleDetector: function () {} };
      let state = ${JSON.stringify(st)};
      const NOW = ${NOW};
      function save() {} function touchTimer() {} function updateTimerUI() {}
      function persistTimerBackground() {} function showToast() {} function fmtDuration() { return ''; }
      const Date = { now: () => NOW };
      ${extractConst('idleWatch')}
      ({ idleWatch, state });
    `;
    return (0, eval)(env);
  };

  {
    const a = mkIdle();
    a.idleWatch.markAway();
    // Порог уже истёк к моменту сигнала — значит отсутствие началось раньше,
    // ровно на величину порога, а не «сейчас».
    check('idle start is backdated by the threshold', a.state.timer.idleSince, NOW - 10 * 60000);
  }
  {
    // Таймер запущен 5 минут назад — простой не может начаться до старта.
    const a = mkIdle({ startTime: NOW - 5 * 60000 });
    a.idleWatch.markAway();
    check('idle start never precedes the timer start', a.state.timer.idleSince, NOW - 5 * 60000);
  }
  {
    const a = mkIdle({ paused: true });
    a.idleWatch.markAway();
    check('a paused timer accrues no idle (already not counting)', a.state.timer.idleSince, null);
  }
  {
    const a = mkIdle({ running: false });
    a.idleWatch.markAway();
    check('a stopped timer accrues no idle', a.state.timer.idleSince, null);
  }
  {
    const a = mkIdle({ idleSince: NOW - 25 * 60000, idleMs: 5 * 60000 });
    const away = a.idleWatch.settle();
    check('settle folds the open stretch into the total', [away, a.state.timer.idleMs, a.state.timer.idleSince],
      [25 * 60000, 30 * 60000, null]);
  }
  {
    const a = mkIdle({ idleSince: NOW - 20 * 1000 });
    check('a sub-minute blip is not counted as idle', [a.idleWatch.settle(), a.state.timer.idleMs], [0, 0]);
  }
  {
    const a = mkIdle({ idleMs: 6 * 60000, idleSince: NOW - 4 * 60000 });
    check('totalMs includes the stretch still in progress', a.idleWatch.totalMs(), 10 * 60000);
  }
}

// ── dates from the server are 'YYYY-MM-DD', never ISO timestamps ──────────
// pg parses a DATE column into a JS Date, which JSON-serializes as
// "2026-09-30T00:00:00.000Z". Dates are compared lexically here, and that
// string is NOT <= "2026-09-30" — entries on a period's end date vanished
// from reports and day stats while still rendering correctly (the formatters
// slice the tail off). dateOnly() normalizes at the boundary.
{
  const src = ['dateOnly', 'toDateStr', 'pad', 'isActiveEntry', 'getReportableEntries']
    .map(extractFunction).join('\n\n');
  // eslint-disable-next-line no-eval
  const d = (0, eval)(`(() => { let state = { entries: [] };\n${src}\n`
    + `return { dateOnly, reportable: (entries, from, to) => { state.entries = entries; `
    + `return getReportableEntries(from, to, null).map(e => e.id); } }; })()`);

  check('ISO timestamp collapses to a plain date', d.dateOnly('2026-09-30T00:00:00.000Z'), '2026-09-30');
  check('a plain date passes through', d.dateOnly('2026-09-30'), '2026-09-30');
  check('empty stays empty', d.dateOnly(null), '');

  const entry = (id, date) => ({ id, date, projectId: 'p1', hours: 1, archived: false, reportId: null });
  check('an entry on the period end date is reportable',
    d.reportable([entry('e1', '2026-09-30')], '2026-09-01', '2026-09-30'), ['e1']);
  check('...and so is one whose date arrived as a timestamp',
    d.reportable([entry('e2', d.dateOnly('2026-09-30T00:00:00.000Z'))], '2026-09-01', '2026-09-30'), ['e2']);
  check('an entry outside the period still is not',
    d.reportable([entry('e3', '2026-10-01')], '2026-09-01', '2026-09-30'), []);
}

// ── buildTelegramReportText: что реально уходит в Telegram ───────────────
// Держит четыре формы, в которых текст отчёта был кривым: продублированный
// заголовок, двойная пустая строка, разные маркеры у одной и у нескольких
// записей, и потерянный итог.
{
  const src = ['pluralRu', 'fmtHoursTelegram', 'groupEntriesByProject',
               'getDefaultReportTitle', 'buildTelegramReportText'].map(extractFunction).join('\n');
  const mk = (projects) => {
    const ctx = `
      let reportFrom = '2026-09-01', reportTo = '2026-09-07', reportProject = '';
      let state = { projects: ${JSON.stringify(projects)}, settings: { currency: 'RUB' } };
      const getProject = id => state.projects.find(p => p.id === id);
      const sum = arr => arr.reduce((a,b)=>a+b,0);
      const parseDateOnly = d => { const [y,m,dd]=String(d).split('-').map(Number); return new Date(y,m-1,dd); };
      const fmtDate = d => { const dt=parseDateOnly(d); return dt?dt.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}):''; };
      const fmtMoney = n => new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',minimumFractionDigits:0}).format(Math.round(n));
      const calcSavedEntryAmount = e => (e.rate != null ? e.rate : (getProject(e.projectId)?.rate || 0)) * (e.hours || 0);
      ${src}
      ({ buildTelegramReportText, getDefaultReportTitle })`;
    // eslint-disable-next-line no-eval
    return (0, eval)(ctx);
  };

  const nbsp = str => str.replace(/[\u00a0\u202f]/g, ' ');
  const P = [{ id: 'p1', name: 'Skypath', rate: 3000 }, { id: 'p2', name: 'Acme', rate: 2000 }];
  const e1 = { id: 'e1', projectId: 'p1', task: 'Настроил CI', date: '2026-09-02', hours: 2, rate: 3000, createdAt: 1 };
  const e2 = { id: 'e2', projectId: 'p1', task: 'Починил синк', date: '2026-09-03', hours: 3, rate: 3000, createdAt: 2 };
  const e3 = { id: 'e3', projectId: 'p2', task: 'Правки по макету', date: '2026-09-04', hours: 1, rate: 2000, createdAt: 3 };

  {
    const a = mk(P);
    const out = a.buildTelegramReportText([e1, e2], a.getDefaultReportTitle('p1')).split('\n');
    check('отчёт по одному проекту не дублирует заголовок', out[0] === out[1], false);
    check('заголовок один и с часами', out[0], 'Skypath (5 часов)');
    check('записи идут единым маркером', out.filter(l => l.startsWith('• ')),
      ['• Настроил CI', '• Починил синк']);
    check('итог с суммой в конце', nbsp(out[out.length - 1]), 'Итого: 5 часов · 15 000 ₽');
  }
  {
    const a = mk(P);
    const out = a.buildTelegramReportText([e1], a.getDefaultReportTitle('p1')).split('\n');
    check('одна запись — тот же маркер, что и у нескольких', out.filter(l => l.trim().length && !l.includes('(') && !l.startsWith('Итого'))[0], '• Настроил CI');
  }
  {
    const a = mk(P);
    const out = a.buildTelegramReportText([e1, e2, e3], a.getDefaultReportTitle(null)).split('\n');
    check('нет двойных пустых строк подряд',
      out.some((l, i) => l === '' && out[i + 1] === ''), false);
    check('оглавление перечисляет оба проекта',
      out.filter(l => l.startsWith('• ') && l.includes('(')),
      ['• Skypath (5 часов)', '• Acme (1 час)']);
    check('у каждого проекта свой блок', [out.includes('Skypath (5 часов)'), out.includes('Acme (1 час)')], [true, true]);
    check('итог суммирует оба проекта', nbsp(out[out.length - 1]), 'Итого: 6 часов · 17 000 ₽');
  }
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
