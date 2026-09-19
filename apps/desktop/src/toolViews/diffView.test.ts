import test from "node:test";
import assert from "node:assert/strict";
import {
  compareChanges,
  compareInputProblem,
  describeCompare,
  hunkTitle,
  lineCount,
  lineEnding,
  parseCompareResult,
  type CompareResult,
} from "./diffView.ts";

// Executor-shaped fixtures (crates/devtools-core/src/compare.rs, serde camelCase).
const summary = (patch: Partial<CompareResult["summary"]> = {}): CompareResult["summary"] => ({
  identical: false, newlineOnly: false, leftBytes: 0, rightBytes: 0,
  leftLines: 0, rightLines: 0, addedLines: 0, removedLines: 0, changedHunks: 0, ...patch,
});
const line = (kind: "context" | "added" | "removed", text: string, oldLine: number | null, newLine: number | null) => ({ kind, text, oldLine, newLine });
const replacement: CompareResult = {
  summary: summary({ leftLines: 3, rightLines: 3, addedLines: 1, removedLines: 1, changedHunks: 1 }),
  hunks: [{
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: [line("context", "alpha\n", 1, 1), line("added", "BETA\n", null, 2), line("removed", "beta\n", 2, null), line("context", "gamma\n", 3, 3)],
  }],
};

test("parse accepts the executor shape and rejects anything else", () => {
  const parsed = parseCompareResult(JSON.stringify({ ...replacement, provenance: { operation: "text.compare" } }));
  assert.ok(parsed);
  assert.equal(parsed.hunks[0].lines[1].kind, "added");
  assert.equal(parsed.summary.addedLines, 1);
  assert.equal(parseCompareResult("not json"), null);
  assert.equal(parseCompareResult('{"summary":{}}'), null, "hunks are required");
  assert.equal(parseCompareResult('{"summary":{},"hunks":[{"lines":"x"}]}'), null, "lines must be an array");
  const truncated = JSON.stringify(replacement).slice(0, 40);
  assert.equal(parseCompareResult(truncated), null, "a bounded preview never parses as a complete diff");
});

test("parse tolerates missing counters by deriving them from the hunks", () => {
  const parsed = parseCompareResult(JSON.stringify({ summary: { identical: false }, hunks: replacement.hunks }));
  assert.ok(parsed);
  assert.deepEqual([parsed.summary.addedLines, parsed.summary.removedLines, parsed.summary.changedHunks], [1, 1, 1]);
  assert.equal(parsed.hunks[0].lines[0].kind, "context", "unknown kinds render as context");
});

test("changes are runs of non-context lines and can be bounded to the rendered rows", () => {
  const result: CompareResult = {
    summary: summary(),
    hunks: [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [line("added", "B\n", null, 1), line("removed", "b\n", 1, null), line("context", "c\n", 2, 2)] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [line("context", "i\n", 9, 9), line("added", "j\n", null, 10)] },
    ],
  };
  assert.deepEqual(compareChanges(result), [
    { hunk: 0, first: 0, last: 1, added: 1, removed: 1 },
    { hunk: 1, first: 1, last: 1, added: 1, removed: 0 },
  ]);
  assert.equal(compareChanges(result, 3).length, 1, "rows past the render cap are not navigable");
  assert.deepEqual(compareChanges({ summary: summary({ identical: true }), hunks: [] }), []);
});

test("descriptions cover identical, newline-only and changed results", () => {
  assert.deepEqual(describeCompare({ summary: summary({ identical: true, leftLines: 2, rightLines: 2 }), hunks: [] }), {
    kind: "identical", headline: "No differences", detail: "Both sides are identical · 2 lines vs 2 lines",
  });
  const newline = describeCompare({ summary: summary({ newlineOnly: true, leftLines: 1, rightLines: 1 }), hunks: [] });
  assert.equal(newline.kind, "newline-only");
  assert.match(newline.detail, /Normalize/);
  const changed = describeCompare(replacement);
  assert.equal(changed.kind, "changed");
  assert.equal(changed.headline, "1 change · +1 −1");
  assert.equal(changed.detail, "1 hunk · 3 lines vs 3 lines");
  const crlf = describeCompare({ ...replacement, summary: { ...replacement.summary, newlineOnly: true } });
  assert.match(crlf.detail, /line endings also differ/);
});

test("hunk titles read as line ranges, including pure insertions", () => {
  assert.equal(hunkTitle({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [] }), "Original 1–3 → Revised 1–4");
  assert.equal(hunkTitle({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [] }), "Original 5 → Revised 5");
  assert.equal(hunkTitle({ oldStart: 4, oldLines: 0, newStart: 4, newLines: 2, lines: [] }), "Original after 3 → Revised 4–5");
});

test("the empty-source gate names the empty side and ignores unknown sizes", () => {
  assert.match(compareInputProblem(0, 0) ?? "", /^Both sides are empty/);
  assert.match(compareInputProblem(0, 12) ?? "", /^Left \/ original is empty/);
  assert.match(compareInputProblem(12, 0) ?? "", /^Right \/ revised is empty/);
  assert.equal(compareInputProblem(12, 7), null);
  assert.equal(compareInputProblem(undefined, 7), null, "a read-only source of unknown size is not treated as empty");
});

test("line counting and terminators follow the executor's inclusive split", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount("a\r\nb\r\n"), 2);
  assert.equal(lineEnding("a\r\n"), "\r\n");
  assert.equal(lineEnding("a\n"), "\n");
  assert.equal(lineEnding("a"), "");
});
