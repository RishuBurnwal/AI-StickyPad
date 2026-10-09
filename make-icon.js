'use strict';
/*
 * Generates icon.ico (a yellow sticky note with a folded corner) with no image
 * dependencies - just a hand-rolled PNG encoder over zlib, wrapped in an ICO
 * container. Run with: node make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const PAPER = [0xf5, 0xc5, 0x42];
const FOLD  = [0xc9, 0x96, 0x22];
const INK   = [0x3a, 0x33, 0x27];

/** Rounded-rect coverage test, in float pixel space. */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Distance from a point to a capsule (thick line with round caps). */
function inCapsule(px, py, ax, ay, bx, by, half) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2)) : 0;
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return dx * dx + dy * dy <= half * half;
}

function sample(px, py, size) {
  const m = size * 0.075;
  const x0 = m, y0 = m, x1 = size - m, y1 = size - m;
  const w = x1 - x0;
  const r = size * 0.09;
  const f = w * 0.34;                 // folded corner, bottom-right
  const bevel = size * 0.035;

  if (!inRoundRect(px, py, x0, y0, x1, y1, r)) return null;

  // Cut the bottom-right corner away along a 45-degree line.
  const dx = px - (x1 - f);
  const dy = py - (y1 - f);
  if (dx > 0 && dy > 0) {
    const d = dx + dy;
    if (d > f) return null;
    if (d > f - bevel) return FOLD;   // shaded lip where the paper folds back
  }

  // Three ruled lines of text.
  const half = size * 0.036;
  const lx0 = x0 + w * 0.17;
  const rows = [
    { y: y0 + w * 0.30, x1: x1 - w * 0.17 },
    { y: y0 + w * 0.50, x1: x1 - w * 0.17 },
    { y: y0 + w * 0.70, x1: x1 - w * 0.42 },
  ];
  for (const row of rows) {
    if (inCapsule(px, py, lx0 + half, row.y, row.x1 - half, row.y, half)) return INK;
  }

  return PAPER;
}

function render(size) {
  const SS = 4; // 4x4 supersampling for clean edges at small sizes
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const i = (y * size + x) * 4;
      const total = SS * SS;
      if (!hits) continue;                       // fully transparent
      out[i] = Math.round(r / hits);
      out[i + 1] = Math.round(g / hits);
      out[i + 2] = Math.round(b / hits);
      out[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ICO container
// ---------------------------------------------------------------------------

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;     // 0 means 256
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);                 // colour planes
    d.writeUInt16LE(32, 6);                // bits per pixel
    d.writeUInt32LE(e.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.buf.length;
    dir.push(d);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((size) => ({ size, buf: encodePng(size, render(size)) }));
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, buildIco(entries));
console.log(`wrote ${out} (${SIZES.join(', ')} px)`);
