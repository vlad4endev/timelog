#!/usr/bin/env node
/**
 * Restore PWA icons from icons/ or skip if branded assets already exist.
 * Placeholder generation only when no source icons are available.
 */
import { writeFileSync, existsSync, statSync, copyFileSync } from 'fs';
import { PNG } from 'pngjs';

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
  console.log('Branded PWA icons already present, skipping.');
  process.exit(0);
}

if (copyFromSource()) {
  process.exit(0);
}

function createIcon(size) {
  const png = new PNG({ width: size, height: size });
  const r = 0x6c, g = 0x63, b = 0xff;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (size * y + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }

  const scale = size / 192;
  const bar = Math.max(2, Math.round(14 * scale));
  const gap = Math.round(8 * scale);
  const letterW = Math.round(44 * scale);
  const letterH = Math.round(72 * scale);
  const startX = Math.round((size - letterW * 2 - gap) / 2);
  const startY = Math.round((size - letterH) / 2);

  function fillRect(x, y, w, h) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const i = (size * py + px) << 2;
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }

  fillRect(startX, startY, letterW, bar);
  fillRect(startX + Math.round(letterW / 2 - bar / 2), startY, bar, letterH);
  const lx = startX + letterW + gap;
  fillRect(lx, startY, bar, letterH);
  fillRect(lx, startY + letterH - bar, letterW, bar);

  return PNG.sync.write(png);
}

writeFileSync('icon-192.png', createIcon(192));
writeFileSync('icon-512.png', createIcon(512));
console.warn('Created placeholder icon-192.png and icon-512.png (add branded files to icons/)');
