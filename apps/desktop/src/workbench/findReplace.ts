/**
 * Pure literal find/replace helpers for the editor. Offsets are JavaScript
 * string (UTF-16) offsets, which are the same offsets used by a textarea.
 * Search is intentionally bounded to the editor's one MiB text limit and to
 * MAX_FIND_MATCHES results so a pathological document cannot freeze the UI.
 */

export const MAX_FIND_TEXT_LENGTH = 1024 * 1024;
export const MAX_FIND_MATCHES = 10_000;

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface TextMatch {
  start: number;
  end: number;
}

export interface FindResult {
  matches: TextMatch[];
  /** True when more than MAX_FIND_MATCHES occurrences exist. */
  truncated: boolean;
}

export type MatchDirection = "forward" | "backward";

function assertSearchable(text: string): void {
  if (text.length > MAX_FIND_TEXT_LENGTH) {
    throw new RangeError(
      `Find and replace is limited to ${MAX_FIND_TEXT_LENGTH} UTF-16 code units.`,
    );
  }
}

function escapedLiteral(value: string): string {
  // A constructor is used instead of a regex literal so a slash is harmless,
  // and every metacharacter remains a literal character in the query.
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}\p{M}_]$/u.test(value);
}

function hasWordBoundary(text: string, start: number, end: number): boolean {
  let before: string | undefined;
  if (start > 0) {
    const unit = text.charCodeAt(start - 1);
    const codePointStart =
      unit >= 0xdc00 && unit <= 0xdfff ? start - 2 : start - 1;
    before = Array.from(text.slice(codePointStart, start))[0];
  }
  const after = end >= text.length ? undefined : Array.from(text.slice(end))[0];
  return !isWordCharacter(before) && !isWordCharacter(after);
}

function matcher(query: string, options: FindOptions): RegExp {
  const flags = options.caseSensitive === false ? "giu" : "gu";
  return new RegExp(escapedLiteral(query), flags);
}

/** Find literal occurrences. Empty queries return no matches. */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions = {},
): FindResult {
  assertSearchable(text);
  if (query.length === 0) return { matches: [], truncated: false };

  const expression = matcher(query, options);
  const matches: TextMatch[] = [];
  let truncated = false;
  let current: RegExpExecArray | null;
  while ((current = expression.exec(text)) !== null) {
    const start = current.index;
    const end = start + current[0].length;
    if (!options.wholeWord || hasWordBoundary(text, start, end)) {
      if (matches.length < MAX_FIND_MATCHES) matches.push({ start, end });
      else {
        truncated = true;
        break;
      }
    }
  }
  return { matches, truncated };
}

/** Select the next occurrence, wrapping around at either end. */
export function nextMatch(
  matches: readonly TextMatch[],
  selectionStart: number,
  selectionEnd: number,
  direction: MatchDirection = "forward",
): TextMatch | null {
  if (matches.length === 0) return null;
  if (direction === "backward") {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].end <= selectionStart) return matches[i];
    }
    return matches[matches.length - 1];
  }
  for (const match of matches) {
    if (match.start >= selectionEnd) return match;
  }
  return matches[0];
}

/** Replace one already-selected occurrence. Replacement text is always literal. */
export function replaceOne(
  text: string,
  match: TextMatch,
  replacement: string,
): string {
  assertSearchable(text);
  if (
    !Number.isInteger(match.start) ||
    !Number.isInteger(match.end) ||
    match.start < 0 ||
    match.end < match.start ||
    match.end > text.length
  ) {
    throw new RangeError("Match offsets are outside the document.");
  }
  const result =
    text.slice(0, match.start) + replacement + text.slice(match.end);
  if (result.length > MAX_FIND_TEXT_LENGTH) {
    throw new RangeError("Replacement would exceed the one MiB editor limit.");
  }
  return result;
}

/** Replace every literal occurrence and return the changed text and count. */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = {},
): { text: string; count: number } {
  assertSearchable(text);
  if (query.length === 0) return { text, count: 0 };

  const expression = matcher(query, options);
  const pieces: string[] = [];
  let cursor = 0;
  let count = 0;
  let current: RegExpExecArray | null;
  while ((current = expression.exec(text)) !== null) {
    const start = current.index;
    const end = start + current[0].length;
    if (options.wholeWord && !hasWordBoundary(text, start, end)) continue;
    pieces.push(text.slice(cursor, start), replacement);
    cursor = end;
    count++;
  }
  if (count === 0) return { text, count: 0 };
  pieces.push(text.slice(cursor));
  const result = pieces.join("");
  if (result.length > MAX_FIND_TEXT_LENGTH) {
    throw new RangeError("Replacement would exceed the one MiB editor limit.");
  }
  return { text: result, count };
}
