'use strict';
// Generates assets/iconTemplate.png and iconTemplate@2x.png at postinstall.
// Pure Node.js, no external deps — uses built-in zlib for PNG encoding.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG encoder ─────────────────────────────────────────────────────────────
function buildPNG(w, h, pixels) {
  // pixels: Uint8Array of length w*h, 0 = transparent, 1 = black opaque (RGBA)

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = (crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0); // filter byte = None
    for (let x = 0; x < w; x++) {
      if (pixels[y * w + x]) raw.push(0, 0, 0, 255);
      else                    raw.push(0, 0, 0,   0);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon pixel art 16×16 ────────────────────────────────────────────────────
// Up-arrow entering a tray = "upload / share"
// prettier-ignore
const px16 = Uint8Array.from([
  0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,  // row 0  – arrowhead tip
  0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,  // row 1
  0,0,0,0,0,1,0,1,0,1,0,0,0,0,0,0,  // row 2
  0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,  // row 3  – shaft
  0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,  // row 4
  0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,  // row 5
  0,0,1,1,1,1,1,0,1,1,1,1,1,0,0,0,  // row 6  – tray top (gap for shaft)
  0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,  // row 7
  0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,  // row 8
  0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,  // row 9
  0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,  // row 10
  0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,  // row 11
  0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,  // row 12 – tray bottom
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  // row 13
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  // row 14
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  // row 15
]);

// Scale to 32×32 by doubling each pixel (2×2 block)
function scale2x(src, w, h) {
  const dst = new Uint8Array(w * 2 * h * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      dst[(y * 2)     * (w * 2) + (x * 2)    ] = v;
      dst[(y * 2)     * (w * 2) + (x * 2 + 1)] = v;
      dst[(y * 2 + 1) * (w * 2) + (x * 2)    ] = v;
      dst[(y * 2 + 1) * (w * 2) + (x * 2 + 1)] = v;
    }
  return dst;
}

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

fs.writeFileSync(path.join(assetsDir, 'iconTemplate.png'),    buildPNG(16, 16, px16));
fs.writeFileSync(path.join(assetsDir, 'iconTemplate@2x.png'), buildPNG(32, 32, scale2x(px16, 16, 16)));
console.log('✓ assets/iconTemplate.png generated');
