import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const crc = (b) => {
  let n = 0xffffffff;
  for (const x of b) {
    n ^= x;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const h = Buffer.alloc(4),
    c = Buffer.alloc(4);
  h.writeUInt32BE(data.length);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([h, t, data, c]);
};
function distance(x, y, a, b, c, d) {
  const t = Math.max(
    0,
    Math.min(1, ((x - a) * (c - a) + (y - b) * (d - b)) / ((c - a) ** 2 + (d - b) ** 2)),
  );
  return Math.hypot(x - a - t * (c - a), y - b - t * (d - b));
}
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let red = 0,
        green = 0,
        blue = 0,
        alpha = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = ((x + (sx + 0.5) / 4) / size) * 128,
            py = ((y + (sy + 0.5) / 4) / size) * 128;
          const dx = Math.max(20 - px, px - 108, 0),
            dy = Math.max(20 - py, py - 108, 0);
          if (Math.hypot(dx, dy) > 20) continue;
          const letter =
            Math.min(
              distance(px, py, 39, 91, 39, 37),
              distance(px, py, 39, 37, 89, 91),
              distance(px, py, 89, 91, 89, 37),
            ) < 7;
          red += letter ? 246 : 52;
          green += letter ? 248 : 116;
          blue += letter ? 237 : 88;
          alpha += 255;
        }
      const pos = y * (1 + size * 4) + 1 + x * 4;
      raw[pos] = alpha ? Math.round((red * 255) / alpha) : 0;
      raw[pos + 1] = alpha ? Math.round((green * 255) / alpha) : 0;
      raw[pos + 2] = alpha ? Math.round((blue * 255) / alpha) : 0;
      raw[pos + 3] = Math.round(alpha / 16);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  await writeFile(
    resolve(import.meta.dirname, '../public/icon' + size + '.png'),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
