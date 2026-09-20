import type { Annotation } from "../bridge";

const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));

const KINDS = new Set(["match", "group", "warning", "error", "info"]);
const className = (kind: string) => `ann-${KINDS.has(kind) ? kind : "match"}`;

/**
 * The HTML for the highlight layer behind the editor: the text, byte for byte
 * as the textarea holds it, with every annotated span wrapped. Overlapping
 * spans (a group inside its match) are split at each boundary so a segment
 * carries the classes of every span covering it. Offsets are UTF-16 code
 * units, the same units the textarea uses for selection, so a span drawn here
 * sits exactly under the characters it names. Out-of-range spans are clamped.
 */
export function annotationMarkup(text: string, annotations: readonly Annotation[]): string {
  const spans = annotations
    .map((item) => ({ start: Math.max(0, Math.min(text.length, item.start)), end: Math.max(0, Math.min(text.length, item.end)), kind: item.kind, label: item.label }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (!spans.length) return escapeHtml(text);
  const bounds = new Set<number>([0, text.length]);
  for (const span of spans) { bounds.add(span.start); bounds.add(span.end); }
  const points = [...bounds].sort((a, b) => a - b);
  let html = "";
  let next = 0;
  const active: typeof spans = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    while (next < spans.length && spans[next]!.start <= from) active.push(spans[next++]!);
    for (let cursor = active.length - 1; cursor >= 0; cursor -= 1) if (active[cursor]!.end <= from) active.splice(cursor, 1);
    const segment = escapeHtml(text.slice(from, to));
    if (!active.length) { html += segment; continue; }
    const classes = [...new Set(active.map((item) => className(item.kind)))].join(" ");
    const label = active.map((item) => item.label).filter(Boolean).join(" · ");
    html += `<mark class="${classes}"${label ? ` title="${escapeHtml(label)}"` : ""}>${segment}</mark>`;
  }
  return html;
}

/** Counts by kind, for the result pane's one-line summary of the highlights. */
export function annotationSummary(annotations: readonly Annotation[]): string {
  const counts = new Map<string, number>();
  for (const item of annotations) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const plural = (kind: string) => (kind === "match" ? "matches" : kind.endsWith("s") ? kind : `${kind}s`);
  return [...counts].map(([kind, count]) => `${count} ${count === 1 ? kind : plural(kind)}`).join(", ");
}
