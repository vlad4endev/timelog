#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('www', { recursive: true });

await build({
  entryPoints: ['capacitor/entry.js'],
  bundle: true,
  format: 'iife',
  globalName: 'TimeLogNative',
  outfile: 'www/native-bridge.js',
  platform: 'browser',
  target: ['es2020'],
  minify: false,
});

console.log('built www/native-bridge.js');
