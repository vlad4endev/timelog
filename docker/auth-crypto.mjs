/**
 * Password hashing and verification for TimeLog auth service.
 * Supports scrypt (current) and legacy client-side SHA-256 hex hashes.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export const MIN_PASSWORD_LENGTH = 8;
const LEGACY_SALT = 'timelog_salt_2024';
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function validateLogin(login) {
  if (!login || typeof login !== 'string') return 'login required';
  const s = login.trim();
  if (!s) return 'login required';
  if (s.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'invalid email';
    return null;
  }
  if (s.startsWith('+')) {
    if (!/^\+\d{10,15}$/.test(s)) return 'invalid phone';
    return null;
  }
  if (!/^[a-z0-9._-]{3,64}$/.test(s)) return 'invalid login';
  return null;
}

export function validateNewPassword(password) {
  if (!password || typeof password !== 'string') return 'password required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function legacyClientHash(login, password) {
  return crypto
    .createHash('sha256')
    .update(`${login}:${LEGACY_SALT}:${password}`)
    .digest('hex');
}

/** Oldest client hashes: SHA-256(password + salt) without login prefix. */
export function legacyPassOnlyHash(password) {
  return crypto
    .createHash('sha256')
    .update(`${password}${LEGACY_SALT}`)
    .digest('hex');
}

export function isLegacyHash(stored) {
  return typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, SCRYPT_OPTS);
  return `$scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyScrypt(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[1] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scryptAsync(password, salt, expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(expected, Buffer.from(derived));
}

export async function verifyPassword(login, password, stored) {
  if (!stored || !password) return false;
  if (stored.startsWith('$scrypt$')) {
    return verifyScrypt(password, stored);
  }
  if (isLegacyHash(stored)) {
    const candidates = [legacyClientHash(login, password), legacyPassOnlyHash(password)];
    for (const h of candidates) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(stored, 'hex'))) {
          return true;
        }
      } catch {
        /* try next */
      }
    }
    return false;
  }
  return false;
}

export async function verifyLegacyPwHash(login, pwHash, stored) {
  if (!pwHash || !stored || !isLegacyHash(stored) || !isLegacyHash(pwHash)) return false;
  if (pwHash !== stored) return false;
  return true;
}
