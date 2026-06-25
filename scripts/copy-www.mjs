#!/usr/bin/env node
import { copyFileSync, mkdirSync, existsSync } from 'fs';

const root = new URL('..', import.meta.url).pathname;
const www = `${root}/www`;

const files = [
  'index.html',
  'sw.js',
  'manifest.json',
  'config.js',
  'icon-192.png',
  'icon-512.png',
];

mkdirSync(www, { recursive: true });

for (const file of files) {
  const src = `${root}/${file}`;
  if (!existsSync(src)) {
    console.warn(`skip missing: ${file}`);
    continue;
  }
  copyFileSync(src, `${www}/${file}`);
  console.log(`copied ${file}`);
}
