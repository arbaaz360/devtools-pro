import assert from "node:assert/strict";
import test from "node:test";
import { annotationMarkup, annotationSummary } from "./annotations.ts";

test("plain text is escaped and unchanged without annotations", () => {
  assert.equal(annotationMarkup("a < b & c", []), "a &lt; b &amp; c");
});

test("spans wrap exactly their characters and keep the rest of the text intact", () => {
  const html = annotationMarkup("hello world", [{ start: 6, end: 11, kind: "match", label: "#1" }]);
  assert.equal(html, 'hello <mark class="ann-match" title="#1">world</mark>');
});

test("overlapping spans are split at boundaries and carry every covering class", () => {
  const html = annotationMarkup("2024-02-29", [
    { start: 0, end: 10, kind: "match", label: "#1" },
    { start: 0, end: 4, kind: "group", label: "y" },
    { start: 5, end: 7, kind: "group", label: "m" },
  ]);
  assert.equal(
    html,
    '<mark class="ann-match ann-group" title="#1 · y">2024</mark><mark class="ann-match" title="#1">-</mark><mark class="ann-match ann-group" title="#1 · m">02</mark><mark class="ann-match" title="#1">-29</mark>',
  );
});

test("out-of-range and empty spans are clamped or dropped; unknown kinds fall back to match", () => {
  assert.equal(annotationMarkup("abc", [{ start: 2, end: 99, kind: "weird" }]), 'ab<mark class="ann-match">c</mark>');
  assert.equal(annotationMarkup("abc", [{ start: 1, end: 1, kind: "match" }]), "abc");
  assert.equal(annotationMarkup("abc", [{ start: -5, end: 1, kind: "error" }]), '<mark class="ann-error">a</mark>bc');
});

test("markup inside annotated text stays escaped", () => {
  assert.equal(annotationMarkup("<b>", [{ start: 0, end: 3, kind: "warning" }]), '<mark class="ann-warning">&lt;b&gt;</mark>');
});

test("summary counts by kind", () => {
  assert.equal(annotationSummary([{ start: 0, end: 1, kind: "match" }, { start: 0, end: 1, kind: "match" }, { start: 0, end: 1, kind: "group" }]), "2 matches, 1 group");
});
