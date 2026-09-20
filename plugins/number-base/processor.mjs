import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export class NumberBaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NumberBaseError";
    this.code = code;
    Object.assign(this, details);
  }
}

function parseOptions(options) {
  let fromBase = options?.["from-base"] ?? options?.fromBase;
  if (typeof fromBase === "string") fromBase = parseInt(fromBase, 10);
  fromBase = fromBase ?? 10;
  if (!Number.isInteger(fromBase) || fromBase < 2 || fromBase > 36) {
    throw new NumberBaseError("invalid-option", "from-base must be an integer between 2 and 36", { option: "from-base" });
  }

  let toBase = options?.["to-base"] ?? options?.toBase;
  if (typeof toBase === "string") toBase = parseInt(toBase, 10);
  toBase = toBase ?? 16;
  if (!Number.isInteger(toBase) || toBase < 2 || toBase > 36) {
    throw new NumberBaseError("invalid-option", "to-base must be an integer between 2 and 36", { option: "to-base" });
  }

  const digits = options?.digits ?? "lower";
  if (digits !== "lower" && digits !== "upper") {
    throw new NumberBaseError("invalid-option", "digits must be lower or upper", { option: "digits" });
  }

  return { fromBase, toBase, digits };
}

function parseBigIntWithCancellation(str, base, context) {
  if (str === "0") return 0n;
  let res = 0n;
  let baseN = BigInt(base);
  for (let i = 0; i < str.length; i++) {
    if (i % 1024 === 0 && context.cancellation.isCancelled()) {
      throw new ProcessorCancelled();
    }
    const code = str.charCodeAt(i);
    let val = -1;
    if (code >= 48 && code <= 57) val = code - 48; // 0-9
    else if (code >= 65 && code <= 90) val = code - 65 + 10; // A-Z
    else if (code >= 97 && code <= 122) val = code - 97 + 10; // a-z

    res = res * baseN + BigInt(val);
  }
  return res;
}

export async function execute(request, context) {
  const { fromBase, toBase, digits: digitCase } = parseOptions(request?.options);

  let bytes;
  try {
    bytes = await context.read("input");
  } catch (e) {
    if (e instanceof Error && e.message.includes("named input")) {
      bytes = undefined;
    } else {
      throw e;
    }
  }

  if (!bytes || bytes.length === 0) {
    throw new NumberBaseError("empty-input", "Input cannot be empty");
  }

  let inputRaw = new TextDecoder().decode(bytes);
  let str = inputRaw.trim();
  if (str === "") throw new NumberBaseError("empty-input", "Input cannot be empty");

  const startOffset = inputRaw.indexOf(str);

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (/\s/.test(c)) {
      throw new NumberBaseError("invalid-character", "Whitespace or second line is not allowed inside the number", { offset: startOffset + i });
    }
    if (c === '.' || c === ',') {
      throw new NumberBaseError("invalid-character", `Fractional or separator character '${c}' is not allowed`, { offset: startOffset + i });
    }
  }

  let isNegative = false;
  let offset = 0;
  if (str.startsWith("-")) {
    isNegative = true;
    offset++;
  } else if (str.startsWith("+")) {
    throw new NumberBaseError("invalid-character", "Optional sign can only be '-'", { offset: startOffset + offset });
  }

  let prefixOffset = offset;
  if (str.startsWith("0b", offset) || str.startsWith("0B", offset)) {
    if (fromBase !== 2) throw new NumberBaseError("prefix-mismatch", "Prefix '0b' requires from-base to be 2", { offset: startOffset + offset });
    offset += 2;
  } else if (str.startsWith("0o", offset) || str.startsWith("0O", offset)) {
    if (fromBase !== 8) throw new NumberBaseError("prefix-mismatch", "Prefix '0o' requires from-base to be 8", { offset: startOffset + offset });
    offset += 2;
  } else if (str.startsWith("0x", offset) || str.startsWith("0X", offset)) {
    if (fromBase !== 16) throw new NumberBaseError("prefix-mismatch", "Prefix '0x' requires from-base to be 16", { offset: startOffset + offset });
    offset += 2;
  }

  if (offset >= str.length) {
    throw new NumberBaseError("no-digits", "Number must contain at least one digit");
  }

  for (let i = offset; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let val = -1;
    if (code >= 48 && code <= 57) val = code - 48; // 0-9
    else if (code >= 65 && code <= 90) val = code - 65 + 10; // A-Z
    else if (code >= 97 && code <= 122) val = code - 97 + 10; // a-z

    if (val === -1 || val >= fromBase) {
      throw new NumberBaseError("invalid-character", `Invalid character '${str[i]}' for base ${fromBase}`, { offset: startOffset + i });
    }
  }

  const digitStr = str.slice(offset);
  let val = parseBigIntWithCancellation(digitStr, fromBase, context);

  const formatBase = (v, b) => {
    if (v === 0n) return "0";
    let s = v.toString(b);
    if (digitCase === "upper") s = s.toUpperCase();
    if (isNegative) s = "-" + s;
    return s;
  };

  const resultStr = formatBase(val, toBase);

  const maxOutputBytes = context.limits?.maxOutputBytes ?? 1048576;
  if (resultStr.length > maxOutputBytes) {
    throw new NumberBaseError("output-limit", `Result exceeds maximum output size limit of ${maxOutputBytes} bytes`, { needed: resultStr.length, limit: maxOutputBytes });
  }

  const binaryStr = formatBase(val, 2);
  const octalStr = formatBase(val, 8);
  const decimalStr = formatBase(val, 10);
  const hexStr = formatBase(val, 16);

  const props = {
    result: resultStr,
    binary: binaryStr,
    octal: octalStr,
    decimal: decimalStr,
    hexadecimal: hexStr,
    fromBase,
    toBase,
    digits: resultStr.startsWith("-") ? resultStr.length - 1 : resultStr.length,
    negative: isNegative && val !== 0n
  };

  await context.writeValue("output", props);
  await context.write("output", new TextEncoder().encode(resultStr));

  return props;
}
