// Generates resources/icon.png (128x128) with no dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const BG = [217, 119, 87]; // terracotta
const FG = [255, 251, 247];

function roundedSquareAlpha(x, y) {
  const r = 26;
  const inset = 6;
  const min = inset;
  const max = SIZE - 1 - inset;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

// A person glyph: head circle above a shoulders dome, with a gap between them.
function glyphAlpha(x, y) {
  const headDist = Math.hypot(x - 64, y - 46);
  const head = Math.max(0, Math.min(1, 19 - headDist));

  const shoulderDist = Math.hypot((x - 64) / 1.15, y - 116);
  const dome = Math.max(0, Math.min(1, 41 - shoulderDist));
  const shoulders = y > 79 ? dome : 0;

  return Math.max(head, shoulders);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const bgA = roundedSquareAlpha(x, y);
    const fgA = glyphAlpha(x, y) * bgA;
    for (let c = 0; c < 3; c++) {
      raw[offset++] = Math.round(BG[c] * (1 - fgA) + FG[c] * fgA);
    }
    raw[offset++] = Math.round(bgA * 255);
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
