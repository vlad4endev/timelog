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
  // Line comments must be skipped like scanBlock does: an apostrophe inside
  // one ("what's outstanding") otherwise opens a phantom string and the brace
  // count runs past the function's end, swallowing whatever follows it.
  let inLine = false;
  let i = braceStart;
  for (; i < html.length; i++) {
    const c = html[i];
    const prev = html[i - 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inString) {
      if (c === inString && prev !== '\\') inString = null;
      continue;
    }
    if (c === '/' && html[i + 1] === '/') { inLine = true; continue; }
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


// ── Страница «Оплата»: цифры в карточках и в «Статусе по проектам» ─────────
// Regression: строки статуса считались только по проектам со ставкой и только
// по платежам с projectId, поэтому их сумма не сходилась с карточкой
// «Получено оплат»; правка платежа по отчёту теряла reportId и backfill
// на следующей загрузке заводил второй платёж, удваивая деньги.
{
  const payNames = ['sum', 'getProject', 'calcSavedEntryAmount', 'getProjectEarned',
    'calcTotalEarned', 'dateOnly', 'toDateStr', 'pad', 'uid', 'groupEntriesByProject',
    'backfillPaidReportPayments', 'paymentStatusRows'];
  const mkPay = (st) => {
    const fn = new Function('state', 'sb', 'save',
      payNames.map(extractFunction).join('\n') +
      '; return { paymentStatusRows, calcTotalEarned, sum, backfillPaidReportPayments };');
    return fn(st, { isEnabled: () => false }, () => {});
  };

  {
    const st = {
      projects: [{ id: 'p1', name: 'Альфа', rate: 1000 }],
      entries: [{ id: 'e1', projectId: 'p1', hours: 10, rate: 1000 }],
      // «Все проекты» + платёж по проекту, удалённому ранее (projectId уже null)
      payments: [{ id: 'a', projectId: null, amount: 4000, date: '2026-01-10' },
                 { id: 'b', projectId: 'p1', amount: 6000, date: '2026-01-11' }],
      reports: []
    };
    const a = mkPay(st);
    const rows = a.paymentStatusRows();
    check('строки статуса сходятся с карточкой «Получено оплат»',
      a.sum(rows.map(r => r.paid)), a.sum(st.payments.map(p => p.amount)));
    check('платёж без проекта показан отдельной строкой',
      rows.map(r => [r.name, r.paid]), [['Альфа', 6000], ['Все проекты', 4000]]);
  }

  {
    // Проект без ставки, но с замороженной ставкой на записях, всё равно виден.
    const st = {
      projects: [{ id: 'p1', name: 'Архивный', rate: 0 }],
      entries: [{ id: 'e1', projectId: 'p1', hours: 2, rate: 1500 }],
      payments: [], reports: []
    };
    const a = mkPay(st);
    check('проект со снятой ставкой не исчезает из статуса',
      a.paymentStatusRows().map(r => [r.name, r.earned]), [['Архивный', 3000]]);
    check('строки статуса сходятся с карточкой «Заработано всего»',
      a.sum(a.paymentStatusRows().map(r => r.earned)), a.calcTotalEarned());
  }

  {
    // Правка платежа по отчёту (savePayment мержит на существующую запись).
    const st = {
      projects: [{ id: 'p1', name: 'Альфа', rate: 1000 }],
      entries: [{ id: 'e1', projectId: 'p1', hours: 10, rate: 1000, archived: true }],
      reports: [{ id: 'r1', title: 'Январь', status: 'paid', paidAt: Date.parse('2026-02-01'),
                  entryIds: ['e1'], from: '2026-01-01', to: '2026-01-31', totalAmount: 10000, projectId: 'p1' }],
      payments: [{ id: 'pay1', projectId: 'p1', amount: 10000, date: '2026-02-01',
                   note: 'Оплата по отчёту «Январь»', reportId: 'r1', createdAt: 1 }]
    };
    const a = mkPay(st);
    // savePayment пересобирает объект поверх существующего — reportId должен уцелеть
    st.payments[0] = { ...st.payments[0], id: 'pay1', projectId: 'p1', amount: 10000,
      date: '2026-02-01', from: '', to: '', note: 'на карту', createdAt: 1, updatedAt: 2 };
    check('правка платежа сохраняет связь с отчётом', st.payments[0].reportId, 'r1');
    a.backfillPaidReportPayments();
    check('перезагрузка не заводит второй платёж по тому же отчёту', st.payments.length, 1);
    check('сумма полученного не удваивается', a.sum(st.payments.map(p => p.amount)), 10000);
  }
}

// ── reconcilePaidReportEntries: записи оплаченного отчёта уходят в архив ──
// Regression: отчёт помечен «оплачено», а его записи остались активными
// (частично потерянная запись в БД либо старая версия markReportPaid) — и
// оплаченная работа продолжала висеть в «Записях времени» как неоплаченная.
{
  const state = {
    reports: [
      { id: 'r1', status: 'paid', entryIds: ['e1', 'e2'] },
      { id: 'r2', status: 'unpaid', entryIds: ['e4'] }
    ],
    entries: [
      { id: 'e1', taskId: 't1', reportId: 'r1', archived: false },   // связь с двух сторон
      { id: 'e2', taskId: null, reportId: null, archived: false },   // только entryIds отчёта
      { id: 'e3', taskId: 't2', reportId: 'r1', archived: false },   // только reportId записи
      { id: 'e4', taskId: 't3', reportId: 'r2', archived: false },   // отчёт не оплачен
      { id: 'e5', taskId: null, reportId: null, archived: false }    // вне отчётов
    ],
    boardTasks: [
      { id: 't1', archived: false, updatedAt: 1 },
      { id: 't2', archived: false, updatedAt: 1 },
      { id: 't3', archived: false, updatedAt: 1 }
    ]
  };
  const pushedEntries = [], pushedTasks = [];
  let saves = 0;
  const fn = new Function('state', 'sb', 'save',
    extractFunction('reconcilePaidReportEntries') + '; return reconcilePaidReportEntries;');
  const reconcile = fn(state, {
    isEnabled: () => true,
    upsertEntry: (e) => pushedEntries.push(e.id),
    upsertBoardTask: (t) => pushedTasks.push(t.id)
  }, () => { saves++; });

  reconcile();
  check('записи оплаченного отчёта уехали в архив',
    state.entries.filter(e => e.archived).map(e => e.id), ['e1', 'e2', 'e3']);
  check('запись неоплаченного отчёта не тронута', state.entries.find(e => e.id === 'e4').archived, false);
  check('запись вне отчётов не тронута', state.entries.find(e => e.id === 'e5').archived, false);
  check('задачи оплаченных записей закрыты',
    state.boardTasks.filter(t => t.archived).map(t => t.id), ['t1', 't2']);
  check('починенное улетает в БД', [pushedEntries, pushedTasks], [['e1', 'e2', 'e3'], ['t1', 't2']]);
  check('починка сохранена локально один раз', saves, 1);

  // Идемпотентность: второй проход ничего не делает и не пишет лишнего.
  reconcile();
  check('повторный проход ничего не меняет', [pushedEntries.length, saves], [3, 1]);
}

// ── saveBoardTask: правка задачи не должна воскрешать её из архива ─────────
// Regression: тот же класс бага, что у savePayment/saveEntry — объект задачи
// пересобирался из полей формы, а `archived` поля в форме нет. boardTaskToRow()
// эту колонку отправляет, так что правка задачи, закрытой оплаченным отчётом,
// вернула бы её на доску (archived=false).
{
  const names = ['saveBoardTask', 'getBoardTask', 'getNextBoardPosition', 'getProject', 'uid'];
  const fields = { 'board-task-title': 'Починить синк', 'board-task-project': 'p1',
    'board-task-edit-id': 't1', 'board-task-status': 'done',
    'board-task-desc': 'описание', 'board-task-priority': 'high' };
  const state = {
    projects: [{ id: 'p1', name: 'Альфа', rate: 1000 }],
    boardTasks: [{ id: 't1', projectId: 'p1', title: 'Старое название', desc: '', status: 'done',
                   position: 3, priority: 'medium', archived: true, createdAt: 111, updatedAt: 111 }]
  };
  const pushed = [];
  // Заглушки ровно того, что трогает функция — сама функция настоящая, из index.html.
  const env = {
    state,
    document: { getElementById: (id) => (id in fields ? { value: fields[id] } : null) },
    boardFilterProject: '',
    showToast: () => {}, save: () => {}, closeModal: () => {}, renderPage: () => {},
    sb: { isEnabled: () => true, upsertBoardTask: (t) => pushed.push(t) }
  };
  const fn = new Function(...Object.keys(env),
    names.map(extractFunction).join('\n') + '; return saveBoardTask;');
  fn(...Object.values(env))();

  const t = state.boardTasks[0];
  check('правка задачи не снимает архив', t.archived, true);
  check('то же уходит на сервер, а не archived=false', pushed[0].archived, true);
  check('правка из формы всё же применилась', [t.title, t.priority], ['Починить синк', 'high']);
  check('позиция и дата создания сохранены', [t.position, t.createdAt], [3, 111]);

  // новая задача архивной не рождается
  fields['board-task-edit-id'] = '';
  fn(...Object.values(env))();
  const created = state.boardTasks.find(x => x.id !== 't1');
  check('новая задача создаётся не архивной', !created.archived, true);
}

// ── saveEntry / saveProject: правка не должна терять поля вне формы ────────
// Обе раньше пересобирали объект литералом. saveEntry() из-за этого отвязывала
// запись от отчёта (исправлено ранее перечислением полей руками), saveProject()
// пока случайно перечисляет все колонки. Спред делает свойство структурным,
// поэтому тест проверяет именно его: поле, которого нет в форме, обязано выжить.
{
  const stub = (fields, extra) => ({
    document: { getElementById: (id) => (id in fields ? { value: fields[id] } : null) },
    showToast: () => {}, save: () => {}, closeModal: () => {}, renderPage: () => {},
    checkProjectHourLimit: () => {}, fmtDuration: () => '',
    ...extra
  });
  const call = (names, env) =>
    new Function(...Object.keys(env), names.map(extractFunction).join('\n') + `; return ${names[0]};`)
      (...Object.values(env))();

  {
    const state = {
      settings: { billableIncrement: 0.25, roundMode: 'up', minBillable: 0 },
      projects: [{ id: 'p1', name: 'Альфа', rate: 1000 }],
      boardTasks: [],
      entries: [{ id: 'e1', projectId: 'p1', task: 'Старое', date: '2026-01-05', hours: 1,
                  rate: 900, start: '', end: '', notes: '', taskId: null,
                  reportId: 'r1', archived: true, createdAt: 111, invoiceId: 'inv-9' }]
    };
    const pushed = [];
    call(['saveEntry', 'roundBillableHours', 'getBillingSettings', 'getProject', 'getBoardTask', 'uid'],
      stub({ 'entry-project': 'p1', 'entry-task': 'Новое название', 'entry-date': '2026-01-06',
             'entry-hours': '2', 'entry-edit-id': 'e1', 'entry-notes': '', 'entry-task-id': '',
             'entry-start': '', 'entry-end': '' },
        { state, sb: { isEnabled: () => true, upsertEntry: (e) => pushed.push(e), upsertBoardTask: () => {} } }));

    // reportId/archived уже закрыты проверками выше (см. "an edit keeps the
    // entry linked to its report") — здесь только то, чего они не ловят:
    // поле, которого в форме нет вовсе, то есть любая будущая колонка.
    const e = state.entries[0];
    check('правка записи сохраняет поле вне формы', e.invoiceId, 'inv-9');
    check('поле вне формы уходит и на сервер', pushed[0].invoiceId, 'inv-9');
  }

  {
    const state = {
      settings: { projectHourAlerts: {} },
      projects: [{ id: 'p1', name: 'Старое', client: '', rate: 500, color: '#000', desc: '',
                   status: 'active', maxHours: 0, specText: '', specFileName: '', specFileMime: '',
                   specFileData: '', createdAt: 222, updatedAt: 222, archivedAt: 'keep-me' }]
    };
    call(['saveProject', 'getProject', 'uid'],
      stub({ 'project-name': 'Новое', 'project-edit-id': 'p1', 'project-max-hours': '',
             'project-client': 'ООО', 'project-rate': '1500', 'project-color': '#fff',
             'project-desc': '', 'project-status': 'active', 'project-spec-text': '' },
        { state, projectSpecDraft: { fileName: '', fileMime: '', fileData: '' },
          sb: { isEnabled: () => false, upsertProject: () => {} } }));

    const p = state.projects[0];
    check('правка проекта сохраняет поле вне формы', p.archivedAt, 'keep-me');
    check('правка проекта применилась', [p.name, p.rate, p.createdAt], ['Новое', 1500, 222]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
