#!/usr/bin/env node
/** Print scrypt hash for a password (used by reset-user-password.sh). */
import { hashPassword, validateNewPassword } from '../docker/auth-crypto.mjs';

const pass = process.argv[2];
if (!pass) {
  console.error('Usage: node scripts/reset-user-password.mjs <password>');
  process.exit(1);
}
const err = validateNewPassword(pass);
if (err) {
  console.error(err);
  process.exit(1);
}
process.stdout.write(await hashPassword(pass));
