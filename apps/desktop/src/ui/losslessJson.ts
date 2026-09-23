/**
 * JSON for inspection, without losing a number's text.
 *
 * `JSON.parse` turns every number into a double, so a result's own text can say
 * `9007199254740993` while the parsed value is 9007199254740992, and `1e400` becomes
 * Infinity. The formatter keeps the text; a tree built from `JSON.parse` would then show
 * a different number from the one in the result, silently.
 *
 * A reviver receives each number's source text (`context.source`). Where that text is
 * not what the double prints, the number is kept as a {@link JsonNumber} carrying the
 * original digits; every other number stays a plain number.
 */

/** A number whose text says more than a double can hold: 9007199254740993, 1e400, 1.50, -0. */
export class JsonNumber {
  readonly lexeme: string;
  /** The nearest double, for anything that has to compute with it. */
  readonly value: number;
  constructor(lexeme: string, value: number) {
    this.lexeme = lexeme;
    this.value = value;
  }
  toString(): string {
    return this.lexeme;
  }
  /** Serialises as the original digits, never the rounded double. */
  toJSON(): unknown {
    const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
    return raw ? raw(this.lexeme) : this.value;
  }
}

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

/** Parse JSON, keeping the text of every number a double would change. Throws as JSON.parse does. */
export function parseJsonLossless(text: string): unknown {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === "number" && context?.source !== undefined && context.source !== String(value)
      ? new JsonNumber(context.source, value)
      : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
