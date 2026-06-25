#!/usr/bin/env node
/**
 * TimeLog auth service — verifies credentials and issues per-user PostgREST JWTs.
 */
import http from 'node:http';
import pg from 'pg';
import { SignJWT } from 'jose';

const PORT = Number(process.env.AUTH_PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

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

async function signToken(login) {
  return new SignJWT({ role: 'timelog_user', login })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('timelog')
    .setExpirationTime('30d')
    .sign(key);
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
  if (req?.headers?.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
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
  if (!origin) return false;
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
    const login = (url.searchParams.get('login') || '').trim();
    if (!login) {
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
    const login = (body.login || '').trim();
    const pwHash = body.pwHash || '';
    if (!login || !pwHash) {
      json(res, 400, { error: 'login and pwHash required' }, req);
      return;
    }
    const stored = await getUserHash(login);
    if (!stored || stored !== pwHash) {
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
    const login = (body.login || '').trim();
    const pwHash = body.pwHash || '';
    if (!login || !pwHash) {
      json(res, 400, { error: 'login and pwHash required' }, req);
      return;
    }
    const existing = await getUserHash(login);
    if (existing) {
      json(res, 409, { error: 'login taken' }, req);
      return;
    }
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
    const oldLogin = (body.oldLogin || '').trim();
    const newLogin = (body.newLogin || '').trim();
    const pwHash = body.pwHash || '';
    if (!oldLogin || !newLogin || !pwHash) {
      json(res, 400, { error: 'oldLogin, newLogin and pwHash required' }, req);
      return;
    }
    if (oldLogin === newLogin) {
      const token = await signToken(newLogin);
      json(res, 200, { token, login: newLogin }, req);
      return;
    }
    const stored = await getUserHash(oldLogin);
    if (!stored || stored !== pwHash) {
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

  if (req.method === 'POST' && url.pathname === '/auth/sync-password') {
    const body = await readBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid json' }, req);
      return;
    }
    const login = (body.login || '').trim();
    const pwHash = body.pwHash || '';
    if (!login || !pwHash) {
      json(res, 400, { error: 'login and pwHash required' }, req);
      return;
    }
    await pool.query(
      `INSERT INTO app_users (login, pw_hash, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (login) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, updated_at = NOW()`,
      [login, pwHash]
    );
    json(res, 200, { ok: true }, req);
    return;
  }

  json(res, 404, { error: 'not found' }, req);
});

server.listen(PORT, () => {
  console.log(`TimeLog auth server listening on :${PORT}`);
});
