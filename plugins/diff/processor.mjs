const encoder = new TextEncoder();

const asNonNegativeInteger = (value, name, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

function normalizeNewlines(text, policy) {
  if (policy === "preserve") return text;
  const lf = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (policy === "lf" || policy === "ignore") return lf;
  if (policy === "crlf") return lf.replaceAll("\n", "\r\n");
  throw new Error("newline must be preserve, lf, crlf or ignore");
}

function splitLines(text) {
  // Keeping the delimiter in each line makes newline style differences visible
  // while still giving line numbers useful editor semantics.
  if (text.length === 0) return [];
  const result = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    result.push(text.slice(start, i + 1)); start = i + 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

async function readText(context, port) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of context.readChunks(port)) {
    context.cancellation.isCancelled(); // readChunks checks and this is a cheap cooperative boundary.
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, bytes)), bytes };
  } catch {
    throw new Error(`${port} input is not valid UTF-8 text`);
  }
}

function concat(chunks, length) {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function lineDiff(left, right, context, cancellation) {
  const cells = (left.length + 1) * (right.length + 1);
  if (!Number.isSafeInteger(cells) || cells > 4_000_000) throw new Error("line comparison matrix exceeds 4,000,000 cells");
  const width = right.length + 1;
  const dp = new Uint32Array(cells);
  for (let i = left.length - 1; i >= 0; i--) {
    if (cancellation?.isCancelled()) throw new Error("processor cancelled");
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i * width + j] = left[i] === right[j] ? 1 + dp[(i + 1) * width + j + 1] : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (cancellation?.isCancelled()) throw new Error("processor cancelled");
    if (i < left.length && j < right.length && left[i] === right[j]) { ops.push({ kind: "context", text: left[i] }); i++; j++; }
    else if (j < right.length && (i === left.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) { ops.push({ kind: "added", text: right[j] }); j++; }
    else { ops.push({ kind: "removed", text: left[i] }); i++; }
  }
  const changed = [];
  for (let index = 0; index < ops.length; index++) if (ops[index].kind !== "context") changed.push([Math.max(0, index - context), Math.min(ops.length, index + context + 1)]);
  const ranges = [];
  for (const range of changed) {
    const previous = ranges[ranges.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else ranges.push(range);
  }
  const hunks = [];
  let addedLines = 0; let removedLines = 0;
  for (const [start, end] of ranges) {
    let oldBefore = 0; let newBefore = 0;
    for (const op of ops.slice(0, start)) { if (op.kind !== "added") oldBefore++; if (op.kind !== "removed") newBefore++; }
    let oldLine = oldBefore + 1; let newLine = newBefore + 1;
    const lines = [];
    for (const op of ops.slice(start, end)) {
      if (op.kind === "context") { lines.push({ kind: "context", text: op.text, oldLine, newLine }); oldLine++; newLine++; }
      else if (op.kind === "added") { lines.push({ kind: "added", text: op.text, oldLine: null, newLine }); newLine++; addedLines++; }
      else { lines.push({ kind: "removed", text: op.text, oldLine, newLine: null }); oldLine++; removedLines++; }
    }
    hunks.push({ oldStart: oldBefore + 1, oldLines: oldLine - oldBefore - 1, newStart: newBefore + 1, newLines: newLine - newBefore - 1, lines });
  }
  return { hunks, addedLines, removedLines };
}

export async function execute(request, context) {
  const options = request?.options ?? {};
  const newline = options.newline ?? options["newline-policy"] ?? "preserve";
  if (!["preserve", "lf", "crlf", "ignore"].includes(newline)) throw new Error("newline must be preserve, lf, crlf or ignore");
  const contextLines = asNonNegativeInteger(options.contextLines ?? options["context-lines"], "contextLines", 3);
  if (contextLines > 64) throw new Error("contextLines must be at most 64");
  const maxLines = asNonNegativeInteger(options.maxLines ?? options["max-lines"], "maxLines", 100000);
  const [leftInput, rightInput] = await Promise.all([readText(context, "left"), readText(context, "right")]);
  const leftText = normalizeNewlines(leftInput.text, newline);
  const rightText = normalizeNewlines(rightInput.text, newline);
  const leftLines = splitLines(leftText); const rightLines = splitLines(rightText);
  if (leftLines.length > maxLines || rightLines.length > maxLines) throw new Error(`each input must contain at most ${maxLines} lines`);
  if (context.cancellation.isCancelled()) throw new Error("processor cancelled");
  const diff = lineDiff(leftLines, rightLines, contextLines, context.cancellation);
  const canonicalLeft = normalizeNewlines(leftInput.text, "lf"); const canonicalRight = normalizeNewlines(rightInput.text, "lf");
  const summary = { identical: leftText === rightText, newlineOnly: leftText !== rightText && canonicalLeft === canonicalRight, leftBytes: leftInput.bytes, rightBytes: rightInput.bytes, leftLines: leftLines.length, rightLines: rightLines.length, addedLines: diff.addedLines, removedLines: diff.removedLines, changedHunks: diff.hunks.length };
  const result = { complete: true, summary, hunks: diff.hunks, provenance: { operation: "text.compare", newline, contextLines, inputs: ["left", "right"] } };
  const bytes = encoder.encode(JSON.stringify(result));
  if (bytes.byteLength > context.limits.maxOutputBytes) throw new Error(`diff output exceeds ${context.limits.maxOutputBytes} bytes`);
  await context.writeValue("output", result);
  // Keep the save/copy artifact complete. The SDK deliberately bounds one write
  // to maxChunkBytes, so an oversized structured result fails explicitly.
  await context.write("output", bytes);
  return result;
}
