// Renders the extension icons (128x128 PNG) without any image library: a small supersampling
// rasteriser plus a PNG encoder. Run with `npm run icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 6; // samples per axis and pixel

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// a database cylinder: top face, body, two separating arcs
const CX = 64, RX = 30, RY = 11, TOP = 40, BOTTOM = 88, BANDS = [58, 73];
const ell = (x, y, cy) => ((x - CX) / RX) ** 2 + ((y - cy) / RY) ** 2;

function sample(x, y, theme) {
  // rounded square, 4px inset, radius 26
  const R = 26, lo = 4, hi = SIZE - 4;
  const dx = Math.max(lo + R - x, 0, x - (hi - R));
  const dy = Math.max(lo + R - y, 0, y - (hi - R));
  if (x < lo || x > hi || y < lo || y > hi || dx * dx + dy * dy > R * R) return null;
  const bg = lerp(theme.top, theme.bottom, (y - lo) / (hi - lo));

  const inTop = ell(x, y, TOP) <= 1;
  const inBody = Math.abs(x - CX) <= RX && y >= TOP && y <= BOTTOM;
  const inBottom = y >= BOTTOM && ell(x, y, BOTTOM) <= 1;
  if (!inTop && !inBody && !inBottom) return bg;
  if (inTop) return [255, 255, 255];
  for (const by of BANDS) {
    if (y >= by) {
      const f = ell(x, y, by);
      const grad = 2 * Math.sqrt(((x - CX) / RX / RX) ** 2 + ((y - by) / RY / RY) ** 2);
      if (grad > 0 && Math.abs(f - 1) / grad < 1.7) return bg;
    }
  }
  return theme.body;
}

function render(theme) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, theme);
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
      }
      const o = (py * SIZE + px) * 4;
      if (n) {
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
        out[o + 3] = Math.round((255 * n) / (SS * SS));
      }
    }
  }
  return encodePng(SIZE, SIZE, out);
}

const themes = {
  'media/icon.png': { top: hex('#4da3ff'), bottom: hex('#1d4fd7'), body: hex('#d6e6ff') },
  'drivers/sqlite/media/icon.png': { top: hex('#1fa2e8'), bottom: hex('#0a5d96'), body: hex('#d3ecfb') },
};
for (const [file, theme] of Object.entries(themes)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(theme));
  console.log('wrote', file);
}
