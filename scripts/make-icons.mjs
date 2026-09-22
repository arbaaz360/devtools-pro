#!/usr/bin/env node
// Draws the application icon and writes the set Tauri bundles on Windows.
//
// The mark is drawn from geometry rather than a font or an image editor, so the
// icon is reproducible from source and legible at 16 px: a dark rounded tile in
// the shell's own surface colour, with a bracket pair and slash in its accent.
// Run after changing the palette or the mark:
//
//   node scripts/make-icons.mjs
//
// It rewrites apps/desktop/src-tauri/icons/. Shapes are sampled 4x and averaged,
// which is what gives the strokes clean edges at the small sizes Explorer uses.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = resolve(root, "apps", "desktop", "src-tauri", "icons");

// The shell's palette (apps/desktop/src/styles.css): surface, accent, accent-strong.
const TILE = [0x15, 0x17, 0x1a, 0xff];
const EDGE = [0x2b, 0x31, 0x38, 0xff];
const MARK = [0x9f, 0xbe, 0xdf, 0xff];
const SLASH = [0x5f, 0x7f, 0x9f, 0xff];

const SS = 4;                       // samples per pixel, per axis
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Distance from a point to a line segment, in unit space. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSquared);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Signed distance to a rounded rectangle centred on the tile, in unit space. */
function distanceToRoundedRect(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const STROKE = 0.055;               // half-width of the mark's strokes
const CHEVRONS = [
  { a: [0.42, 0.29], b: [0.26, 0.5], colour: MARK },
  { a: [0.26, 0.5], b: [0.42, 0.71], colour: MARK },
  { a: [0.58, 0.29], b: [0.74, 0.5], colour: MARK },
  { a: [0.74, 0.5], b: [0.58, 0.71], colour: MARK },
];
const SLASH_SEGMENT = { a: [0.545, 0.245], b: [0.455, 0.755], colour: SLASH };
// Below 64 px the slash closes the gap between the chevrons and the three strokes
// read as one blob, so the small sizes carry the bracket pair alone.
const segmentsFor = (size) => (size >= 64 ? [...CHEVRONS, SLASH_SEGMENT] : CHEVRONS);

/** The colour at one sample, or null where the icon is transparent. */
function sample(x, y, segments) {
  const tile = distanceToRoundedRect(x, y, 0.5, 0.115);
  if (tile > 0) return null;
  let colour = tile > -0.018 ? EDGE : TILE;
  for (const segment of segments) {
    if (distanceToSegment(x, y, segment.a[0], segment.a[1], segment.b[0], segment.b[1]) <= STROKE) colour = segment.colour;
  }
  return colour;
}

/** RGBA pixels for one size, supersampled and averaged. */
function render(size) {
  const segments = segmentsFor(size);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const colour = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, segments);
          if (!colour) continue;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }
      const samples = SS * SS;
      const offset = (y * size + x) * 4;
      const coverage = a / samples / 255;
      // Premultiplied averaging would darken the edges; average the colour over the
      // covered samples only and keep coverage in the alpha channel.
      const covered = Math.max(1, a / 255);
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------- PNG
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;        // bit depth
  header[9] = 6;        // colour type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO
/** A 32-bit bottom-up DIB with an AND mask, which every Windows shell reads. */
function dib(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // XOR and AND masks stacked
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      xor[to] = pixels[from + 2];
      xor[to + 1] = pixels[from + 1];
      xor[to + 2] = pixels[from];
      xor[to + 3] = pixels[from + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);   // zero: opaque where alpha says so
  header.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([header, xor, and]);
}
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ---------------------------------------------------------------- write
mkdirSync(iconsDir, { recursive: true });
const cache = new Map();
const pixelsFor = (size) => {
  if (!cache.has(size)) cache.set(size, render(size));
  return cache.get(size);
};

const pngSizes = { "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512 };
for (const [name, size] of Object.entries(pngSizes)) {
  writeFileSync(resolve(iconsDir, name), png(size, pixelsFor(size)));
}
// Small sizes as DIB (what Explorer picks for list views), large as PNG.
const icoEntries = [16, 24, 32, 48, 64].map((size) => ({ size, data: dib(size, pixelsFor(size)) }))
  .concat([128, 256].map((size) => ({ size, data: png(size, pixelsFor(size)) })));
writeFileSync(resolve(iconsDir, "icon.ico"), ico(icoEntries));

console.log(`icons written to ${iconsDir}: ${Object.keys(pngSizes).join(", ")}, icon.ico (${icoEntries.map((entry) => entry.size).join("/")})`);
