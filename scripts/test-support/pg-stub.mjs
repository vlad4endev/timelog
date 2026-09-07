// Recording Postgres stub used by scripts/test-sync-live.mjs. Simulates the
// real schema's foreign keys, the ON CONFLICT ownership guards, and the
// missing-user_login-column error the id-keyed tables used to raise.
const log = [];
const rows = new Map();               // "table:pk" -> row object
const COLS = {
  projects: 15, time_entries: 14, payments: 11, board_tasks: 11,
  billing_reports: 13, schedule_blocks: 8,
};
const NO_USER_LOGIN = new Set(['active_timer', 'schedule_settings', 'user_settings']);

function tableOf(sql) {
  const m = /INSERT INTO (\w+)|DELETE FROM (\w+)|FROM (\w+)|UPDATE (\w+)/.exec(sql);
  return m ? (m[1] || m[2] || m[3] || m[4]) : null;
}

class Client {
  async query(sql, params = []) {
    const text = typeof sql === 'string' ? sql : sql.text;
    log.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    const table = tableOf(text);

    if (/^DELETE FROM/.test(text.trim())) {
      // Reproduce the real failure: these tables have no user_login column.
      if (NO_USER_LOGIN.has(table) && /user_login/.test(text)) {
        const e = new Error(`column "user_login" of relation "${table}" does not exist`);
        e.code = '42703';
        throw e;
      }
      return { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO/.test(text.trim())) {
      const owner = params[COLS[table] ? COLS[table] - 1 : 0];
      // Foreign keys the real schema enforces.
      const fks = {
        time_entries: [['project_id', 1, 'projects'], ['task_id', 9, 'board_tasks']],
        board_tasks: [['project_id', 1, 'projects']],
        billing_reports: [['project_id', 4, 'projects']],
        payments: [['project_id', 1, 'projects']],
      }[table] || [];
      for (const [col, idx, parent] of fks) {
        const v = params[idx];
        if (v != null && !rows.has(`${parent}:${v}`)) {
          const e = new Error(`insert or update on table "${table}" violates foreign key constraint "${table}_${col}_fkey"`);
          e.code = '23503';
          throw e;
        }
      }
      const pk = NO_USER_LOGIN.has(table) ? params[0] : params[0];
      const existing = rows.get(`${table}:${pk}`);
      if (existing && !NO_USER_LOGIN.has(table)) {
        // ON CONFLICT DO UPDATE ... WHERE <t>.user_login = $n
        const guard = new RegExp(`WHERE ${table}\\.user_login = \\$(\\d+)`).exec(text);
        if (guard && existing.user_login !== params[+guard[1] - 1]) {
          return { rows: [], rowCount: 0 };          // guarded: no-op
        }
      }
      rows.set(`${table}:${pk}`, { id: pk, user_login: owner, params });
      return { rows: [], rowCount: 1 };
    }

    if (/app_users/.test(text)) return { rows: [{ pw_hash: null }] };
    if (/COUNT\(\*\)/.test(text)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  }
  release() {}
}

class Pool {
  constructor() { this._h = {}; }
  on(ev, fn) { this._h[ev] = fn; return this; }
  async connect() { return new Client(); }
  async query(...a) { return new Client().query(...a); }
  async end() {}
}

export const types = { setTypeParser() {} };
export default { Pool, types, __log: log, __rows: rows };
export { Pool };
