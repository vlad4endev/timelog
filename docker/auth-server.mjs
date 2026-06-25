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
  return new SignJWT({ role: 'timelog_user', login })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('timelog')
    .setExpirationTime(TOKEN_TTL)
    .sign(key);
}

async function verifyBearerToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(authHeader.slice(7), key, { issuer: 'timelog' });
    if (payload.role !== 'timelog_user' || typeof payload.login !== 'string') return null;
    return payload.login;
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

async function migrateLogin(oldLogin, newLogin) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = [
      'projects', 'board_tasks', 'time_entries', 'billing_reports',
      'payments', 'schedule_overrides', 'schedule_blocks',
    ];
    for (const table of tables) {
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

const server = http.createServer(async (req, res) => {
  if (handleCors(req, res)) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isAuthRoute = url.pathname.startsWith('/auth/');

  if (isAuthRoute && !checkRateLimit(req)) {
    json(res, 429, { error: 'too many requests' }, req);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
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
    json(res, 200, { token, login }, req);
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
    json(res, 201, { token, login }, req);
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
      const tokenLogin = await verifyBearerToken(req.headers.authorization || '');
      if (tokenLogin !== oldLogin) {
        json(res, 401, { error: 'unauthorized' }, req);
        return;
      }
      const token = await signToken(newLogin);
      json(res, 200, { token, login: newLogin }, req);
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
    json(res, 200, { token, login: newLogin }, req);
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
    json(res, 200, { token, login }, req);
    return;
  }

  json(res, 404, { error: 'not found' }, req);
});

server.listen(PORT, () => {
  console.log(`TimeLog auth server listening on :${PORT}`);
});
