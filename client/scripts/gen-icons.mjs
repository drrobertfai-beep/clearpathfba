// Generates ClearPathFBA PWA icons (192x192 + 512x512) with zero image deps.
// Pure Node: RGBA buffer → zlib deflate → PNG chunks. Run:
//   node scripts/gen-icons.mjs
// Produces client/public/icon-192.png and icon-512.png.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const THEME = [25, 125, 107];      // #197d6b — app primary
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Rounded square in theme green with a white "C" (annulus open on the right).
function draw(size) {
  const cx = size / 2, cy = size / 2;
  const corner = size * 0.22;
  const r1 = size * 0.24, r2 = size * 0.40;
  const gap = 0.40; // radians — opening of the C on the right side
  return (x, y) => {
    // rounded-rect distance (approx): clamp point to inner rect, measure dist
    const hx = Math.max(Math.abs(x - cx) - (cx - corner), 0);
    const hy = Math.max(Math.abs(y - cy) - (cy - corner), 0);
    const inside = Math.hypot(hx, hy) <= corner;
    if (!inside) return [0, 0, 0, 0];
    const d = Math.hypot(x - cx, y - cy);
    let ang = Math.atan2(y - cy, x - cx);
    const ring = d >= r1 && d <= r2 && Math.abs(ang) > gap;
    return ring ? [...WHITE, 255] : [...THEME, 255];
  };
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, draw(size)));
  console.log(`wrote ${file} (${size}x${size})`);
}
