import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export class LineToolsError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LineToolsError";
    this.code = code;
    this.diagnostic = {
      code,
      severity: "error",
      message,
      ...options
    };
  }
}

const ACTIONS = ["sort", "dedupe", "reverse", "remove-blank"];
const ORDERS = ["ascending", "descending"];
const COMPARES = ["natural", "code-point", "case-insensitive", "numeric"];

function choice(options, id, alias, allowed, fallback) {
  const value = options[id] ?? (alias ? options[alias] : undefined) ?? fallback;
  if (!allowed.includes(value))
    throw new LineToolsError("lines.invalid-option", `${id} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")} (received ${JSON.stringify(value)})`, { option: id });
  return value;
}

export function readOptions(options = {}) {
  for (const key of Object.keys(options)) {
    if (!["action", "order", "compare", "ignore-case", "ignoreCase", "ignore-whitespace", "ignoreWhitespace"].includes(key)) {
      throw new LineToolsError("lines.invalid-option", `unknown option ${key}`, { option: key });
    }
  }

  const ignoreCase = options["ignore-case"] ?? options["ignoreCase"] ?? false;
  const ignoreWhitespace = options["ignore-whitespace"] ?? options["ignoreWhitespace"] ?? false;

  if (typeof ignoreCase !== "boolean") {
    throw new LineToolsError("lines.invalid-option", `ignore-case must be a boolean`, { option: "ignore-case" });
  }
  if (typeof ignoreWhitespace !== "boolean") {
    throw new LineToolsError("lines.invalid-option", `ignore-whitespace must be a boolean`, { option: "ignore-whitespace" });
  }

  return {
    action: choice(options, "action", null, ACTIONS, "sort"),
    order: choice(options, "order", null, ORDERS, "ascending"),
    compare: choice(options, "compare", null, COMPARES, "natural"),
    ignoreCase,
    ignoreWhitespace
  };
}

function cmpCodePoint(a, b) {
  if (a === b) return 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);

    let cpA = ca;
    let stepA = 1;
    if (ca >= 0xD800 && ca <= 0xDBFF && i + 1 < a.length) {
      const low = a.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cpA = (ca - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000;
        stepA = 2;
      }
    }

    let cpB = cb;
    let stepB = 1;
    if (cb >= 0xD800 && cb <= 0xDBFF && j + 1 < b.length) {
      const low = b.charCodeAt(j + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cpB = (cb - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000;
        stepB = 2;
      }
    }

    if (cpA !== cpB) return cpA - cpB;
    i += stepA;
    j += stepB;
  }
  return a.length - b.length;
}

function cmpCaseInsensitive(a, b) {
  return cmpCodePoint(a.toLowerCase(), b.toLowerCase());
}

const numRegex = /^\s*([-+]?)((?:\d+(?:\.\d*)?|\.\d+))(?:[eE]([-+]?\d+))?/;
function getNumericKey(s) {
  const match = s.match(numRegex);
  if (!match) return { hasNum: false };
  const sign = match[1] === '-' ? -1 : 1;
  const numStr = match[2];
  const expStr = match[3] || '0';

  let intPart = '';
  let fracPart = '';
  const dotIndex = numStr.indexOf('.');
  if (dotIndex === -1) {
    intPart = numStr;
  } else {
    intPart = numStr.slice(0, dotIndex);
    fracPart = numStr.slice(dotIndex + 1);
  }

  intPart = intPart.replace(/^0+/, '');

  let sigDigits = '';
  let baseExp = 0n;

  if (intPart.length > 0) {
    sigDigits = intPart + fracPart;
    baseExp = BigInt(intPart.length - 1);
  } else {
    const firstNonZero = fracPart.search(/[1-9]/);
    if (firstNonZero === -1) {
      return { hasNum: true, isZero: true, sign: 1 };
    }
    sigDigits = fracPart.slice(firstNonZero);
    baseExp = BigInt(-firstNonZero - 1);
  }

  sigDigits = sigDigits.replace(/0+$/, '');

  return {
    hasNum: true,
    isZero: false,
    sign,
    exp: baseExp + BigInt(expStr),
    digits: sigDigits
  };
}

function cmpNumeric(a, b) {
  const ka = getNumericKey(a);
  const kb = getNumericKey(b);

  if (ka.hasNum && kb.hasNum) {
    if (ka.isZero && kb.isZero) return 0;
    if (ka.isZero) return kb.sign === 1 ? -1 : 1;
    if (kb.isZero) return ka.sign === 1 ? 1 : -1;

    if (ka.sign !== kb.sign) return ka.sign - kb.sign;

    const signMult = ka.sign;

    if (ka.exp !== kb.exp) return ka.exp < kb.exp ? -signMult : signMult;

    const len = Math.max(ka.digits.length, kb.digits.length);
    for (let i = 0; i < len; i++) {
      const da = i < ka.digits.length ? ka.digits.charCodeAt(i) : 48; // '0'
      const db = i < kb.digits.length ? kb.digits.charCodeAt(i) : 48;
      if (da !== db) return (da - db) * signMult;
    }

    return 0; // if numbers are exactly equal, they remain stable
  }
  if (ka.hasNum && !kb.hasNum) return -1;
  if (!ka.hasNum && kb.hasNum) return 1;
  return cmpCodePoint(a, b);
}

function splitNatural(s) {
  return s.match(/\d+|\D+/g) || [];
}

function cmpNatural(a, b) {
  if (a === b) return 0;
  const runsA = splitNatural(a);
  const runsB = splitNatural(b);

  const len = Math.min(runsA.length, runsB.length);
  for (let i = 0; i < len; i++) {
    const ra = runsA[i];
    const rb = runsB[i];
    if (ra === rb) continue;

    const isDigitA = ra.charCodeAt(0) >= 48 && ra.charCodeAt(0) <= 57;
    const isDigitB = rb.charCodeAt(0) >= 48 && rb.charCodeAt(0) <= 57;

    if (isDigitA && isDigitB) {
      const valA = ra.replace(/^0+/, '');
      const valB = rb.replace(/^0+/, '');

      if (valA.length !== valB.length) return valA.length - valB.length;
      if (valA !== valB) return valA < valB ? -1 : 1;
      if (ra.length !== rb.length) return ra.length - rb.length;
    } else if (isDigitA && !isDigitB) {
      return -1;
    } else if (!isDigitA && isDigitB) {
      return 1;
    } else {
      const cmp = cmpCodePoint(ra, rb);
      if (cmp !== 0) return cmp;
    }
  }
  return runsA.length - runsB.length;
}

export async function execute(request, context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();

  const options = readOptions(request?.options);

  let text = "";
  let inputBytes = 0;
  try {
    const data = await context.read("input");
    if (data) {
      inputBytes = data.byteLength;
      text = new TextDecoder("utf-8").decode(data);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("named input")) {
      // no input
    } else throw e;
  }

  if (inputBytes > context.limits.maxInputBytes) {
    throw new LineToolsError("lines.input-limit", `Input is too large`);
  }

  // Count line endings
  let crlf = 0, lf = 0, cr = 0;
  const matches = text.match(/\r\n|\n|\r/g) || [];
  for (const m of matches) {
    if (m === '\r\n') crlf++;
    else if (m === '\n') lf++;
    else if (m === '\r') cr++;
  }

  let lineEnding = "LF";
  let sep = '\n';
  if (crlf > lf && crlf > cr) {
    sep = '\r\n';
    lineEnding = "CRLF";
  } else if (cr > lf && cr > crlf) {
    sep = '\r';
    lineEnding = "CR";
  }

  // check trailing newline
  let hasTrailing = false;
  if (text.length > 0) {
    const lastChar = text[text.length - 1];
    if (lastChar === '\n' || lastChar === '\r') {
      hasTrailing = true;
    }
  }

  let lines = text.length === 0 ? [] : text.split(/\r\n|\n|\r/);
  if (hasTrailing && lines.length > 0) {
    lines.pop(); // remove the empty string produced by trailing separator
  }

  const initialCount = lines.length;

  if (options.action === "remove-blank") {
    lines = lines.filter(line => line.trim().length > 0);
  } else if (options.action === "reverse") {
    lines.reverse();
  } else if (options.action === "dedupe") {
    const seen = new Set();
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      if (i % 4096 === 0 && context.cancellation.isCancelled()) throw new ProcessorCancelled();
      const line = lines[i];
      let key = line;
      if (options.ignoreWhitespace) key = key.trim();
      if (options.ignoreCase) key = key.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(line);
      }
    }
    lines = result;
  } else if (options.action === "sort") {
    // JavaScript sort is stable in modern engines
    const compareFn = options.compare === "natural" ? cmpNatural :
                      options.compare === "case-insensitive" ? cmpCaseInsensitive :
                      options.compare === "numeric" ? cmpNumeric :
                      cmpCodePoint;

    const orderMult = options.order === "descending" ? -1 : 1;

    // Sort implementation allowing cancellation checks
    let checks = 0;
    const wrapper = lines.map((val, idx) => ({ val, idx }));
    wrapper.sort((a, b) => {
      if (++checks % 65536 === 0 && context.cancellation.isCancelled()) {
        throw new ProcessorCancelled();
      }
      const c = compareFn(a.val, b.val);
      if (c !== 0) return c * orderMult;
      return a.idx - b.idx; // ensure absolute stability
    });

    lines = wrapper.map(w => w.val);
  }

  const finalCount = lines.length;
  const removed = initialCount - finalCount;

  let outText = lines.join(sep);
  if (hasTrailing && lines.length > 0) {
    outText += sep;
  }

  const outputBytes = new TextEncoder().encode(outText);
  if (outputBytes.length > context.limits.maxOutputBytes) {
    throw new LineToolsError("lines.output-limit", `Output would produce ${outputBytes.length.toLocaleString("en-US")} bytes, above the ${context.limits.maxOutputBytes.toLocaleString("en-US")} byte output limit; split the input or raise the limit`, { needed: outputBytes.length, limit: context.limits.maxOutputBytes });
  }

  const result = {
    lines: initialCount,
    linesOut: finalCount,
    removed,
    lineEnding,
    action: options.action,
    contentKind: "text",
    mime: "text/plain; charset=utf-8",
    text: outText,
    complete: true
  };

  await context.writeValue("output", result);
  await context.write("output", outputBytes);
  return result;
}
