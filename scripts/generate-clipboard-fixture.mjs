// A valid, deterministic PNG whose Base64 exceeds the editor limit.
// Used to verify native encode -> copy -> paste -> decode without private files.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const width = 512,
  height = 512;
const pixels = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    pixels.set([x % 256, y % 256, 127, 255], offset);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels, { level: 0 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const directory = resolve("benchmarks/fixtures");
mkdirSync(directory, { recursive: true });
const path = join(directory, "clipboard-roundtrip.png");
writeFileSync(path, png);
console.log(
  JSON.stringify(
    {
      path,
      imageBytes: png.length,
      dataUriBytes:
        "data:image/png;base64,".length + png.toString("base64").length,
      sha256: createHash("sha256").update(png).digest("hex"),
    },
    null,
    2,
  ),
);
