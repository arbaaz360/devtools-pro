import assert from "node:assert/strict";
import test from "node:test";
import { dataUriBytes, rasterScale } from "./imageClipboard.ts";

test("an SVG is scaled by a whole number to at least 512 px on its long side", () => {
  // A 33-module QR code at one pixel per module: 512 / 33 = 15.5, so 16, giving 528 px.
  assert.equal(rasterScale(33, 33), 16);
  assert.equal(33 * rasterScale(33, 33) >= 512, true);
  assert.equal(Number.isInteger(rasterScale(37, 29)), true);
  assert.equal(rasterScale(512, 512), 1, "already large enough");
  assert.equal(rasterScale(2000, 10), 1, "never shrunk");
  assert.equal(rasterScale(0, 0), 1, "no natural size is drawn as is");
  assert.equal(rasterScale(Number.NaN, 4), 1);
});

test("a base64 data URI decodes to the bytes node encoded", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const uri = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  assert.deepEqual(dataUriBytes(uri), bytes);
  assert.throws(() => dataUriBytes("data:image/svg+xml;charset=utf-8,%3Csvg%3E"), /not a base64 data URI/);
  assert.throws(() => dataUriBytes("no comma here"), /not a base64 data URI/);
});
