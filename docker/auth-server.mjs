#!/usr/bin/env node
/**
 * TimeLog auth service — verifies credentials and issues per-user PostgREST JWTs.
 */
import http from 'node:http';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import {
  hashPassword,
  isLegacyHash,
  validateLogin,
  validateNewPassword,
  verifyLegacyPwHash,
  verifyPassword,
} from './auth-crypto.mjs';

const PORT = Number(process.env.AUTH_PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN_TTL = process.env.AUTH_TOKEN_TTL || '14d';
const SESSION_COOKIE = 'tl_token';
const RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.AUTH_RATE_MAX || 30);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const key = new TextEncoder().encode(JWT_SECRET);
const rateBuckets = new Map();

function parseTokenTtlSeconds(ttl) {
  const m = /^(\d+)([smhd])$/.exec(String(ttl || '14d'));
  if (!m) return 14 * 86400;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]] || 86400;
  return n * mult;
}

const SESSION_COOKIE_MAX_AGE = parseTokenTtlSeconds(TOKEN_TTL);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function isSecureRequest(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return false;
}

function sessionCookieAttrs(req, maxAge = SESSION_COOKIE_MAX_AGE) {
  const parts = [`Path=/`, `Max-Age=${maxAge}`, 'SameSite=Lax', 'HttpOnly'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(res, token, req) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${sessionCookieAttrs(req)}`
  );
}

function clearSessionCookie(res, req) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${sessionCookieAttrs(req, 0)}`
  );
}

function normalizeLogin(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.includes('@')) return s.toLowerCase();
  if (/^\d/.test(s) || s.startsWith('+')) {
    let d = s.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
    else if (d.length === 10 && d.startsWith('9')) d = '7' + d;
    return '+' + d;
  }
  return s.toLowerCase();
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) return false;
  return true;
}

function isAllowedOrigin(origin, req) {
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers.host || '';
    if (!host) return false;
    if (o.host === host) return true;
    const allowed = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return allowed.includes(origin);
  } catch {
    return false;
  }
}

async function signToken(login) {
  return new SignJWT({ role: 'timelog_user', login, sub: login })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('timelog')
    .setExpirationTime(TOKEN_TTL)
    .sign(key);
}

async function verifyBearerToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const { payload } = await jwtVerify(token, key, { issuer: 'timelog' });
    if (payload.role !== 'timelog_user' || typeof payload.login !== 'string') return null;
    return { login: payload.login, token };
  } catch {
    return null;
  }
}

async function verifyRequestSession(req) {
  const fromBearer = await verifyBearerToken(req.headers.authorization || '');
  if (fromBearer) return fromBearer;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: 'timelog' });
    if (payload.role !== 'timelog_user' || typeof payload.login !== 'string') return null;
    return { login: payload.login, token };
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function json(res, status, data, req) {
  const origin = req?.headers?.origin;
  if (origin && isAllowedOrigin(origin, req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin, req)) {
    if (req.method === 'OPTIONS') {
      res.writeHead(403);
      res.end();
      return true;
    }
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, Prefer');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

async function getUserHash(login) {
  const r = await pool.query(
    'SELECT pw_hash FROM app_users WHERE login = $1 LIMIT 1',
    [login]
  );
  return r.rows[0]?.pw_hash || null;
}

async function setUserHash(login, pwHash) {
  await pool.query(
    `INSERT INTO app_users (login, pw_hash, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (login) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, updated_at = NOW()`,
    [login, pwHash]
  );
}

async function upgradeLegacyHash(login, password) {
  const stored = await getUserHash(login);
  if (!stored || !isLegacyHash(stored)) return;
  const next = await hashPassword(password);
  await setUserHash(login, next);
}

async function authenticateCredentials(login, body) {
  const stored = await getUserHash(login);
  if (!stored) return { ok: false, reason: 'invalid' };

  if (body.password) {
    const valid = await verifyPassword(login, body.password, stored);
    if (!valid) return { ok: false, reason: 'invalid' };
    if (isLegacyHash(stored)) await upgradeLegacyHash(login, body.password);
    return { ok: true };
  }

  if (body.pwHash && (await verifyLegacyPwHash(login, body.pwHash, stored))) {
    return { ok: true, legacy: true };
  }

  return { ok: false, reason: 'invalid' };
}

const USER_DATA_TABLES = [
  'projects', 'board_tasks', 'time_entries', 'billing_reports',
  'payments', 'schedule_overrides', 'schedule_blocks',
];

async function reassignUserData(client, oldLogin, newLogin) {
  for (const table of USER_DATA_TABLES) {
    await client.query(
      `UPDATE ${table} SET user_login = $1 WHERE user_login = $2`,
      [newLogin, oldLogin]
    );
  }
  await client.query(
    'UPDATE active_timer SET id = $1 WHERE id = $2',
    [newLogin, oldLogin]
  );
  await client.query(
    'UPDATE schedule_settings SET id = $1 WHERE id = $2',
    [newLogin, oldLogin]
  );
  await client.query(
    'UPDATE user_settings SET id = $1 WHERE id = $2',
    [newLogin, oldLogin]
  );
}

async function migrateLogin(oldLogin, newLogin) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reassignUserData(client, oldLogin, newLogin);
    const hash = await getUserHash(oldLogin);
    if (!hash) throw new Error('User not found');
    await client.query(
      'INSERT INTO app_users (login, pw_hash, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (login) DO NOTHING',
      [newLogin, hash]
    );
    await client.query('DELETE FROM app_users WHERE login = $1', [oldLogin]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function pullUserData(login) {
  const [
    projects,
    entries,
    payments,
    boardTasks,
    reports,
    timerRow,
    scheduleSettings,
    scheduleOverrides,
    scheduleBlocks,
    userSettings,
  ] = await Promise.all([
    pool.query(
      'SELECT * FROM projects WHERE user_login = $1 ORDER BY created_at ASC',
      [login]
    ),
    pool.query(
      'SELECT * FROM time_entries WHERE user_login = $1 ORDER BY created_at DESC',
      [login]
    ),
    pool.query(
      'SELECT * FROM payments WHERE user_login = $1 ORDER BY created_at DESC',
      [login]
    ),
    pool.query(
      'SELECT * FROM board_tasks WHERE user_login = $1 ORDER BY position ASC',
      [login]
    ),
    pool.query(
      'SELECT * FROM billing_reports WHERE user_login = $1 ORDER BY created_at DESC',
      [login]
    ),
    pool.query('SELECT * FROM active_timer WHERE id = $1 LIMIT 1', [login]),
    pool.query('SELECT * FROM schedule_settings WHERE id = $1 LIMIT 1', [login]),
    pool.query(
      'SELECT * FROM schedule_overrides WHERE user_login = $1 ORDER BY date ASC',
      [login]
    ),
    pool.query(
      'SELECT * FROM schedule_blocks WHERE user_login = $1 ORDER BY date ASC',
      [login]
    ),
    pool.query('SELECT * FROM user_settings WHERE id = $1 LIMIT 1', [login]),
  ]);
  return {
    projects: projects.rows,
    time_entries: entries.rows,
    payments: payments.rows,
    board_tasks: boardTasks.rows,
    billing_reports: reports.rows,
    active_timer: timerRow.rows[0] || null,
    schedule_settings: scheduleSettings.rows[0] || null,
    schedule_overrides: scheduleOverrides.rows,
    schedule_blocks: scheduleBlocks.rows,
    user_settings: userSettings.rows[0] || null,
  };
}

async function upsertProjectRow(client, login, r) {
  await client.query(
    `INSERT INTO projects (
      id, name, client, rate, color, status, description, max_hours,
      spec_text, spec_file_name, spec_file_mime, spec_file_data, created_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, client = EXCLUDED.client, rate = EXCLUDED.rate,
      color = EXCLUDED.color, status = EXCLUDED.status, description = EXCLUDED.description,
      max_hours = EXCLUDED.max_hours, spec_text = EXCLUDED.spec_text,
      spec_file_name = EXCLUDED.spec_file_name, spec_file_mime = EXCLUDED.spec_file_mime,
      spec_file_data = EXCLUDED.spec_file_data, user_login = EXCLUDED.user_login`,
    [
      r.id, r.name, r.client ?? null, r.rate ?? 0, r.color ?? '#059669',
      r.status ?? 'active', r.description ?? null, r.max_hours ?? null,
      r.spec_text ?? null, r.spec_file_name ?? null, r.spec_file_mime ?? null,
      r.spec_file_data ?? null, r.created_at ?? new Date().toISOString(),
      r.user_login || login,
    ]
  );
}

async function upsertEntryRow(client, login, r) {
  await client.query(
    `INSERT INTO time_entries (
      id, project_id, task, date, hours, start_time, end_time, notes,
      task_id, report_id, archived, created_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id, task = EXCLUDED.task, date = EXCLUDED.date,
      hours = EXCLUDED.hours, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
      notes = EXCLUDED.notes, task_id = EXCLUDED.task_id, report_id = EXCLUDED.report_id,
      archived = EXCLUDED.archived, user_login = EXCLUDED.user_login`,
    [
      r.id, r.project_id, r.task, r.date, r.hours, r.start_time ?? null,
      r.end_time ?? null, r.notes ?? null, r.task_id ?? null, r.report_id ?? null,
      !!r.archived, r.created_at ?? new Date().toISOString(), r.user_login || login,
    ]
  );
}

async function upsertPaymentRow(client, login, r) {
  await client.query(
    `INSERT INTO payments (
      id, project_id, amount, date, period_from, period_to, note, created_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id, amount = EXCLUDED.amount, date = EXCLUDED.date,
      period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
      note = EXCLUDED.note, user_login = EXCLUDED.user_login`,
    [
      r.id, r.project_id ?? null, r.amount, r.date, r.period_from ?? null,
      r.period_to ?? null, r.note ?? null, r.created_at ?? new Date().toISOString(),
      r.user_login || login,
    ]
  );
}

async function upsertBoardTaskRow(client, login, r) {
  await client.query(
    `INSERT INTO board_tasks (
      id, project_id, title, description, status, position, priority, archived,
      created_at, updated_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id, title = EXCLUDED.title, description = EXCLUDED.description,
      status = EXCLUDED.status, position = EXCLUDED.position, priority = EXCLUDED.priority,
      archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at, user_login = EXCLUDED.user_login`,
    [
      r.id, r.project_id, r.title, r.description ?? null, r.status ?? 'todo',
      r.position ?? 0, r.priority ?? 'medium', !!r.archived,
      r.created_at ?? new Date().toISOString(), r.updated_at ?? new Date().toISOString(),
      r.user_login || login,
    ]
  );
}

async function upsertReportRow(client, login, r) {
  await client.query(
    `INSERT INTO billing_reports (
      id, title, period_from, period_to, project_id, entry_ids, text,
      total_hours, total_amount, status, paid_at, created_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
      project_id = EXCLUDED.project_id, entry_ids = EXCLUDED.entry_ids, text = EXCLUDED.text,
      total_hours = EXCLUDED.total_hours, total_amount = EXCLUDED.total_amount,
      status = EXCLUDED.status, paid_at = EXCLUDED.paid_at, user_login = EXCLUDED.user_login`,
    [
      r.id, r.title ?? null, r.period_from, r.period_to, r.project_id ?? null,
      r.entry_ids ?? [], r.text, r.total_hours ?? 0, r.total_amount ?? 0,
      r.status ?? 'unpaid', r.paid_at ?? null, r.created_at ?? new Date().toISOString(),
      r.user_login || login,
    ]
  );
}

async function upsertScheduleSettingsRow(client, login, r) {
  await client.query(
    `INSERT INTO schedule_settings (id, week_template, updated_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET
       week_template = EXCLUDED.week_template, updated_at = EXCLUDED.updated_at`,
    [r.id || login, JSON.stringify(r.week_template || {}), r.updated_at ?? new Date().toISOString()]
  );
}

async function upsertUserSettingsRow(client, login, r) {
  await client.query(
    `INSERT INTO user_settings (id, settings, updated_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
    [r.id || login, JSON.stringify(r.settings || {}), r.updated_at ?? new Date().toISOString()]
  );
}

async function upsertScheduleOverrideRow(client, login, r) {
  await client.query(
    `INSERT INTO schedule_overrides (date, type, hours, note, user_login)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_login, date) DO UPDATE SET
       type = EXCLUDED.type, hours = EXCLUDED.hours, note = EXCLUDED.note`,
    [r.date, r.type, r.hours ?? null, r.note ?? null, r.user_login || login]
  );
}

async function upsertScheduleBlockRow(client, login, r) {
  await client.query(
    `INSERT INTO schedule_blocks (
      id, date, start_time, end_time, title, note, created_at, user_login
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
      title = EXCLUDED.title, note = EXCLUDED.note, user_login = EXCLUDED.user_login`,
    [
      r.id, r.date, r.start_time, r.end_time, r.title ?? null, r.note ?? null,
      r.created_at ?? new Date().toISOString(), r.user_login || login,
    ]
  );
}

async function upsertTimerRow(client, login, r) {
  await client.query(
    `INSERT INTO active_timer (
      id, running, start_time, project_id, task, task_id, paused, paused_ms, pause_start, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      running = EXCLUDED.running, start_time = EXCLUDED.start_time, project_id = EXCLUDED.project_id,
      task = EXCLUDED.task, task_id = EXCLUDED.task_id, paused = EXCLUDED.paused,
      paused_ms = EXCLUDED.paused_ms, pause_start = EXCLUDED.pause_start, updated_at = EXCLUDED.updated_at`,
    [
      r.id || login, !!r.running, r.start_time ?? null, r.project_id ?? null,
      r.task ?? '', r.task_id ?? null, !!r.paused, r.paused_ms ?? 0,
      r.pause_start ?? null, r.updated_at ?? new Date().toISOString(),
    ]
  );
}

const UPSERT_HANDLERS = {
  projects: upsertProjectRow,
  time_entries: upsertEntryRow,
  payments: upsertPaymentRow,
  board_tasks: upsertBoardTaskRow,
  billing_reports: upsertReportRow,
  schedule_settings: upsertScheduleSettingsRow,
  user_settings: upsertUserSettingsRow,
  schedule_overrides: upsertScheduleOverrideRow,
  schedule_blocks: upsertScheduleBlockRow,
  active_timer: upsertTimerRow,
};

async function applySyncPush(login, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [table, rows] of Object.entries(body.upserts || {})) {
      const handler = UPSERT_HANDLERS[table];
      if (!handler || !Array.isArray(rows)) continue;
      for (const row of rows) {
        await handler(client, login, row);
      }
    }
    if (body.timer) {
      // Also covers the "clear timer" case: the client now sends the
      // already-stopped row (running: false) with a fresh updated_at instead
      // of relying on a bare delete, so other devices can tell a genuine stop
      // apart from a stale cached "still running" state by timestamp alone.
      await upsertTimerRow(client, login, body.timer);
    } else if (body.clearTimer) {
      // Fallback for older clients that send clearTimer without a row.
      await upsertTimerRow(client, login, { id: login, running: false, updated_at: new Date().toISOString() });
    }
    for (const del of body.deletes || []) {
      if (!del?.table || !UPSERT_HANDLERS[del.table]) continue;
      if (del.table === 'schedule_overrides' && del.date) {
        await client.query(
          'DELETE FROM schedule_overrides WHERE user_login = $1 AND date = $2',
          [login, del.date]
        );
      } else if (del.id) {
        await client.query(
          `DELETE FROM ${del.table} WHERE id = $1 AND user_login = $2`,
          [del.id, login]
        );
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function claimLegacyData(login, legacyLogin = 'default') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent claims against the same legacy account: without
    // this, two callers can both pass the "not claimed yet" checks below
    // before either commits, and the second one gets told it succeeded even
    // though the first already reassigned everything. The lock blocks the
    // second transaction here until the first commits, so its checks below
    // then correctly see the post-claim state.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [legacyLogin]);
    const hasOwn = await client.query(
      'SELECT 1 FROM projects WHERE user_login = $1 LIMIT 1',
      [login]
    );
    if (hasOwn.rows.length) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'already_has_data' };
    }
    const legacy = await client.query(
      'SELECT COUNT(*)::int AS n FROM projects WHERE user_login = $1',
      [legacyLogin]
    );
    if ((legacy.rows[0]?.n ?? 0) === 0) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'no_legacy_data' };
    }
    await reassignUserData(client, legacyLogin, login);
    await client.query('COMMIT');
    return { claimed: true, from: legacyLogin, projects: legacy.rows[0].n };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const server = http.createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isAuthRoute = url.pathname.startsWith('/auth/')
    && url.pathname !== '/auth/health';

  if (isAuthRoute && !checkRateLimit(req)) {
    json(res, 429, { error: 'too many requests' }, req);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/auth/health')) {
    json(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/has-users') {
    const r = await pool.query('SELECT 1 FROM app_users LIMIT 1');
    json(res, 200, { hasUsers: r.rows.length > 0 }, req);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/exists') {
    const login = normalizeLogin(url.searchParams.get('login') || '');
    const err = validateLogin(login);
    if (err) {
      json(res, 400, { error: 'login required' }, req);
      return;
    }
    const hash = await getUserHash(login);
    json(res, 200, { exists: !!hash }, req);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/token') {
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const login = normalizeLogin(body.login || '');
    const loginErr = validateLogin(login);
    if (loginErr) {
      json(res, 400, { error: loginErr }, req);
      return;
    }
    if (!body.password && !body.pwHash) {
      json(res, 400, { error: 'password required' }, req);
      return;
    }
    const auth = await authenticateCredentials(login, body);
    if (!auth.ok) {
      json(res, 401, { error: 'invalid credentials' }, req);
      return;
    }
    const token = await signToken(login);
    setSessionCookie(res, token, req);
    json(res, 200, { ok: true, token, login }, req);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/session') {
    const session = await verifyRequestSession(req);
    if (!session) {
      clearSessionCookie(res, req);
      json(res, 401, { ok: false, error: 'no session' }, req);
      return;
    }
    json(res, 200, { ok: true, login: session.login, token: session.token }, req);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    clearSessionCookie(res, req);
    json(res, 200, { ok: true }, req);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/register') {
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const login = normalizeLogin(body.login || '');
    const loginErr = validateLogin(login);
    if (loginErr) {
      json(res, 400, { error: loginErr }, req);
      return;
    }
    const password = body.password || '';
    const passErr = validateNewPassword(password);
    if (passErr) {
      json(res, 400, { error: passErr }, req);
      return;
    }
    const existing = await getUserHash(login);
    if (existing) {
      json(res, 409, { error: 'login taken' }, req);
      return;
    }
    const pwHash = await hashPassword(password);
    await pool.query(
      'INSERT INTO app_users (login, pw_hash, updated_at) VALUES ($1, $2, NOW())',
      [login, pwHash]
    );
    const token = await signToken(login);
    setSessionCookie(res, token, req);
    json(res, 201, { ok: true, token, login }, req);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/change-login') {
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const oldLogin = normalizeLogin(body.oldLogin || '');
    const newLogin = normalizeLogin(body.newLogin || '');
    const loginErr = validateLogin(oldLogin) || validateLogin(newLogin);
    if (loginErr) {
      json(res, 400, { error: loginErr }, req);
      return;
    }
    if (oldLogin === newLogin) {
      const session = await verifyRequestSession(req);
      if (!session || session.login !== oldLogin) {
        json(res, 401, { error: 'unauthorized' }, req);
        return;
      }
      const token = await signToken(newLogin);
      setSessionCookie(res, token, req);
      json(res, 200, { ok: true, token, login: newLogin }, req);
      return;
    }
    const auth = await authenticateCredentials(oldLogin, body);
    if (!auth.ok) {
      json(res, 401, { error: 'invalid credentials' }, req);
      return;
    }
    const taken = await getUserHash(newLogin);
    if (taken) {
      json(res, 409, { error: 'login taken' }, req);
      return;
    }
    try {
      await migrateLogin(oldLogin, newLogin);
    } catch (e) {
      console.error('change-login failed:', e);
      json(res, 500, { error: 'migration failed' }, req);
      return;
    }
    const token = await signToken(newLogin);
    setSessionCookie(res, token, req);
    json(res, 200, { ok: true, token, login: newLogin }, req);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/claim-legacy') {
    const session = await verifyRequestSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthorized' }, req);
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const legacyLogin = normalizeLogin(body.from || 'default');
    try {
      const result = await claimLegacyData(session.login, legacyLogin);
      json(res, 200, result, req);
    } catch (e) {
      console.error('claim-legacy failed:', e);
      json(res, 500, { error: 'claim failed' }, req);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/me') {
    const session = await verifyRequestSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthorized' }, req);
      return;
    }
    const [pr, en] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM projects WHERE user_login = $1', [session.login]),
      pool.query('SELECT COUNT(*)::int AS n FROM time_entries WHERE user_login = $1', [session.login]),
    ]);
    json(res, 200, {
      login: session.login,
      projectsInDb: pr.rows[0]?.n ?? 0,
      entriesInDb: en.rows[0]?.n ?? 0,
    }, req);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/sync/pull') {
    const session = await verifyRequestSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthorized' }, req);
      return;
    }
    try {
      const data = await pullUserData(session.login);
      json(res, 200, { ok: true, ...data }, req);
    } catch (e) {
      console.error('sync/pull failed:', e);
      json(res, 500, { error: 'pull failed' }, req);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/sync/push') {
    const session = await verifyRequestSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthorized' }, req);
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    try {
      const result = await applySyncPush(session.login, body);
      json(res, 200, result, req);
    } catch (e) {
      console.error('sync/push failed:', e);
      json(res, 500, { error: 'push failed' }, req);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/auth/change-password') {
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const login = normalizeLogin(body.login || '');
    const loginErr = validateLogin(login);
    if (loginErr) {
      json(res, 400, { error: loginErr }, req);
      return;
    }
    const newPassErr = validateNewPassword(body.newPassword || '');
    if (newPassErr) {
      json(res, 400, { error: newPassErr }, req);
      return;
    }
    const auth = await authenticateCredentials(login, {
      password: body.currentPassword,
      pwHash: body.currentPwHash,
    });
    if (!auth.ok) {
      json(res, 401, { error: 'invalid credentials' }, req);
      return;
    }
    const pwHash = await hashPassword(body.newPassword);
    await setUserHash(login, pwHash);
    const token = await signToken(login);
    setSessionCookie(res, token, req);
    json(res, 200, { ok: true, token, login }, req);
    return;
  }

  json(res, 404, { error: 'not found' }, req);
});

server.listen(PORT, () => {
  console.log(`TimeLog auth server listening on :${PORT}`);
});
