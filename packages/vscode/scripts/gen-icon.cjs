'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Generate a crisp 256x256 RGBA PNG extension icon with 2 diagonal orbital nodes and a Gravity Core center.
const W = 256;
const H = 256;
const raw = Buffer.alloc((W * 4 + 1) * H);

function blendPixel(buf, x, y, r, g, b, a) {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const idx = y * (W * 4 + 1) + 1 + x * 4;
  const srcA = a / 255;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

function drawRoundedRectGradient(radius) {
  const rimStart = radius - 1.5;
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const cx = Math.max(0, radius - 0.5 - x, x - (W - 0.5 - radius));
      const cy = Math.max(0, radius - 0.5 - y, y - (H - 0.5 - radius));
      const dist = Math.hypot(cx, cy);
      if (dist > radius + 0.7) continue;
      const alpha = dist > radius - 0.7 ? Math.round(((radius + 0.7 - dist) / 1.4) * 255) : 255;
      const t = (x + y) / (W + H);
      const r = Math.round(36 + (46 - 36) * t);
      const g = Math.round(41 + (52 - 41) * t);
      const b = Math.round(51 + (65 - 51) * t);
      blendPixel(raw, x, y, r, g, b, alpha);
      if (dist > rimStart && dist <= radius + 0.7) {
        const rimT = Math.min(1, (dist - rimStart) / 0.8);
        blendPixel(raw, x, y, 255, 255, 255, Math.round(20 * rimT * (alpha / 255)));
      }
    }
  }
}

function drawFilledCircle(cx, cy, radius, r, g, b) {
  const minX = Math.max(0, Math.floor(cx - radius - 2));
  const maxX = Math.min(W - 1, Math.ceil(cx + radius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - 2));
  const maxY = Math.min(H - 1, Math.ceil(cy + radius + 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius + 0.7) {
        const cov = d <= radius - 0.7 ? 1 : Math.max(0, (radius + 0.7 - d) / 1.4);
        blendPixel(raw, x, y, r, g, b, Math.round(255 * cov));
      }
    }
  }
}

function drawStrokeCircle(cx, cy, radius, strokeRadius, r, g, b) {
  const minX = Math.max(0, Math.floor(cx - radius - strokeRadius - 2));
  const maxX = Math.min(W - 1, Math.ceil(cx + radius + strokeRadius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - strokeRadius - 2));
  const maxY = Math.min(H - 1, Math.ceil(cy + radius + strokeRadius + 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
      if (d <= strokeRadius + 0.8) {
        const cov = d <= strokeRadius - 0.6 ? 1 : Math.max(0, (strokeRadius + 0.8 - d) / 1.4);
        blendPixel(raw, x, y, r, g, b, Math.round(255 * cov));
      }
    }
  }
}

function normalizeAngle(a) {
  let res = a % (Math.PI * 2);
  if (res < 0) res += Math.PI * 2;
  return res;
}

function angleInClockwiseSweep(a, start, end) {
  const na = normalizeAngle(a);
  const ns = normalizeAngle(start);
  const ne = normalizeAngle(end);
  if (ns <= ne) return na >= ns && na <= ne;
  return na >= ns || na <= ne;
}

function drawStrokeArc(cx, cy, radius, startX, startY, endX, endY, strokeRadius, r, g, b) {
  const startAngle = Math.atan2(startY - cy, startX - cx);
  const endAngle = Math.atan2(endY - cy, endX - cx);
  const minX = Math.max(0, Math.floor(cx - radius - strokeRadius - 2));
  const maxX = Math.min(W - 1, Math.ceil(cx + radius + strokeRadius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - strokeRadius - 2));
  const maxY = Math.min(H - 1, Math.ceil(cy + radius + strokeRadius + 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = Math.atan2(y - cy, x - cx);
      let d;
      if (angleInClockwiseSweep(a, startAngle, endAngle)) {
        d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
      } else {
        d = Math.min(Math.hypot(x - startX, y - startY), Math.hypot(x - endX, y - endY));
      }
      if (d <= strokeRadius + 0.8) {
        const cov = d <= strokeRadius - 0.6 ? 1 : Math.max(0, (strokeRadius + 0.8 - d) / 1.4);
        blendPixel(raw, x, y, r, g, b, Math.round(255 * cov));
      }
    }
  }
}

// Dark slate rounded badge with subtle diagonal gradient and inner rim highlight.
drawRoundedRectGradient(46);

// Map 24x24 2-node diagonal Gravity Core orbital geometry into 256x256.
const pad = 40;
const scale = (W - pad * 2) / 24;
const px = (v) => pad + v * scale;
const strokeR = 0.85 * scale;
const ringStrokeR = 0.58 * scale;
const [ir, ig, ib] = [214, 219, 228];
const [ar, ag, ab] = [122, 162, 247];

const R = 9.5;
const rad = (deg) => (deg * Math.PI) / 180;
const cx = px(12);
const cy = px(12);

for (const [degStart, degEnd] of [
  [-15, 105],
  [165, 285],
]) {
  const a1 = rad(degStart);
  const a2 = rad(degEnd);
  drawStrokeArc(
    cx,
    cy,
    R * scale,
    px(12 + R * Math.cos(a1)),
    px(12 + R * Math.sin(a1)),
    px(12 + R * Math.cos(a2)),
    px(12 + R * Math.sin(a2)),
    strokeR,
    ir,
    ig,
    ib
  );
}

for (const deg of [-45, 135]) {
  const a = rad(deg);
  drawStrokeCircle(
    px(12 + R * Math.cos(a)),
    px(12 + R * Math.sin(a)),
    2.0 * scale,
    strokeR,
    ir,
    ig,
    ib
  );
}

// Gravity Core center: thinner concentric ring + ice-blue core dot.
drawStrokeCircle(cx, cy, 4.2 * scale, ringStrokeR, 178, 192, 214);
drawFilledCircle(cx, cy, 1.9 * scale, ar, ag, ab);

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log('Generated', outPath, png.length, 'bytes');
