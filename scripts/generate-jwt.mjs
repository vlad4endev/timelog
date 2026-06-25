#!/usr/bin/env node
/**
 * Generate PostgREST-compatible anon JWT for the Docker stack.
 * Usage: JWT_SECRET=... node scripts/generate-jwt.mjs
 */
import { SignJWT } from 'jose';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

const key = new TextEncoder().encode(secret);
const token = await new SignJWT({ role: 'anon' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuedAt()
  .setIssuer('timelog')
  .setExpirationTime('365d')
  .sign(key);

process.stdout.write(token);
