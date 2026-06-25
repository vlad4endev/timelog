#!/usr/bin/env node
/**
 * Ensure branded PWA icons exist at project root.
 * Copies from icons/ when missing; never generates placeholder assets.
 */
import { existsSync, statSync, copyFileSync } from 'fs';

const BRANDED_MIN_BYTES = 2000;

function hasBrandedIcons() {
  for (const file of ['icon-192.png', 'icon-512.png']) {
    if (!existsSync(file)) return false;
    if (statSync(file).size < BRANDED_MIN_BYTES) return false;
  }
  return true;
}

function copyFromSource() {
  if (!existsSync('icons/icon-192.png') || !existsSync('icons/icon-512.png')) return false;
  copyFileSync('icons/icon-192.png', 'icon-192.png');
  copyFileSync('icons/icon-512.png', 'icon-512.png');
  console.log('Restored icon-192.png and icon-512.png from icons/');
  return true;
}

if (hasBrandedIcons()) {
  console.log('PWA icons OK.');
  process.exit(0);
}

if (copyFromSource()) {
  process.exit(0);
}

console.error('Missing branded PWA icons. Add icon-192.png and icon-512.png to the project root or icons/.');
process.exit(1);
