import assert from "node:assert/strict";
import test from "node:test";
import { PLAIN, applyConventions, conventionsNotice, conventionsOf } from "./fileConventions.ts";

// The oracle is the bytes a file had: what an edit did not touch, a save must not change.
const utf8 = (text: string) => [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

test("a BOM and CRLF file keeps both through an edit", () => {
  const file = { encoding: "UTF-8 BOM", preview: "hello\r\nworld\r\n" };
  const conventions = conventionsOf(file);
  assert.deepEqual(conventions, { bom: true, eol: "\r\n", mixed: false });
  // The editor hands back LF (a textarea normalises), with the user's edit.
  assert.equal(utf8(applyConventions("hello!\nworld\n", conventions)), `efbbbf${utf8("hello!\r\nworld\r\n")}`);
  assert.equal(conventionsNotice(conventions), "");
});

test("an LF file without a BOM stays exactly that", () => {
  const conventions = conventionsOf({ encoding: "UTF-8", preview: "a\nb\n" });
  assert.deepEqual(conventions, { bom: false, eol: "\n", mixed: false });
  assert.equal(applyConventions("a\nb!\n", conventions), "a\nb!\n");
});

test("a file with mixed endings gets its dominant one, and the notice says so", () => {
  const crlfMostly = conventionsOf({ encoding: "UTF-8", preview: "a\r\nb\r\nc\nd" });
  assert.deepEqual(crlfMostly, { bom: false, eol: "\r\n", mixed: true });
  assert.equal(applyConventions("a\nb\nc\nd", crlfMostly), "a\r\nb\r\nc\r\nd");
  assert.equal(conventionsNotice(crlfMostly), " (line endings made CRLF throughout)");
  // A tie is not a majority: LF, the editor's own form.
  assert.equal(conventionsOf({ encoding: "UTF-8", preview: "a\r\nb\n" }).eol, "\n");
});

test("a file with no line breaks, or no file at all, is saved plain", () => {
  assert.deepEqual(conventionsOf({ encoding: "UTF-8 BOM", preview: "one line" }), { bom: true, eol: "\n", mixed: false });
  assert.deepEqual(conventionsOf(null), PLAIN);
  assert.equal(applyConventions("x\ny", PLAIN), "x\ny");
});

test("stray CRs from the editor are made the file's ending, and a BOM is never doubled", () => {
  const conventions = { bom: true, eol: "\r\n" as const, mixed: false };
  assert.equal(applyConventions("a\r\nb\rc\n", conventions), "\ufeffa\r\nb\r\nc\r\n");
  assert.equal(applyConventions("\ufeffa", conventions), "\ufeffa");
});
