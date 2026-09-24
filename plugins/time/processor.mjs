import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export class TimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TimeError";
    this.code = code;
    Object.assign(this, details);
  }
}

const ISO_REGEX = /^([+-]?\d{4,}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/i;

function evaluateArithmetic(expr) {
  const tokens = [];
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (/\s/.test(c)) continue;
    if (/[+/*()-]/.test(c)) {
      if (current) { tokens.push(current); current = ""; }
      tokens.push(c);
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);

  if (tokens.length === 0) return NaN;

  for(let t of tokens) {
    if (!/[+/*()-]/.test(t) && isNaN(Number(t))) {
      throw new TimeError("invalid-token", `Invalid token in arithmetic expression: ${t}`);
    }
  }

  let hasArithmetic = false;
  let pos = 0;
  function parseExpr() {
    let val = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      hasArithmetic = true;
      const op = tokens[pos++];
      const right = parseTerm();
      if (op === '+') val += right;
      else val -= right;
    }
    return val;
  }

  function parseTerm() {
    let val = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      hasArithmetic = true;
      const op = tokens[pos++];
      const right = parseFactor();
      if (op === '*') val *= right;
      else {
        if (right === 0) throw new TimeError("divide-by-zero", "Division by zero");
        val /= right;
      }
    }
    return val;
  }

  function parseFactor() {
    if (pos >= tokens.length) throw new TimeError("invalid-expression", "Unexpected end of expression");
    let sign = 1;
    if (tokens[pos] === '-') {
      sign = -1;
      pos++;
    } else if (tokens[pos] === '+') {
      pos++;
    }

    if (pos >= tokens.length) throw new TimeError("invalid-expression", "Unexpected end of expression");

    if (tokens[pos] === '(') {
      pos++;
      hasArithmetic = true;
      let val = parseExpr();
      if (pos >= tokens.length || tokens[pos] !== ')') {
        throw new TimeError("unbalanced-parentheses", "Unbalanced parentheses");
      }
      pos++;
      return sign * val;
    }

    const token = tokens[pos++];
    if (/[+/*()-]/.test(token)) throw new TimeError("invalid-expression", "Unexpected operator");
    if (isNaN(Number(token))) throw new TimeError("invalid-token", `Invalid token: ${token}`);
    return sign * Number(token);
  }

  let val = parseExpr();
  if (pos < tokens.length) throw new TimeError("invalid-expression", "Invalid arithmetic expression");

  if (!Number.isFinite(val)) throw new TimeError("non-finite", "Arithmetic expression resulted in a non-finite value");

  return { value: val, isExpr: hasArithmetic };
}

function parseInput(input, interpretation) {
  input = input.trim();
  const isIsoForm = ISO_REGEX.test(input);

  if (interpretation === "iso" && !isIsoForm) {
    throw new TimeError("interpretation-mismatch", "Input must be an ISO 8601 date when interpretation is iso");
  }
  if ((interpretation === "seconds" || interpretation === "milliseconds") && isIsoForm) {
    throw new TimeError("interpretation-mismatch", `Input must be numeric when interpretation is ${interpretation}`);
  }

  if (isIsoForm) {
    const millis = Date.parse(input);
    if (isNaN(millis)) throw new TimeError("invalid-date", "Invalid ISO 8601 date");

    const match = input.match(/^([+-]?\d{4,})-(\d{2})-(\d{2})/);
    if (match) {
      const yearStr = match[1];
      const mStr = match[2];
      const dStr = match[3];

      const test = new Date(0);
      test.setUTCFullYear(parseInt(yearStr, 10), parseInt(mStr, 10) - 1, parseInt(dStr, 10));
      if (test.getUTCMonth() + 1 !== parseInt(mStr, 10)) {
        throw new TimeError("invalid-date", "Invalid ISO 8601 date: calendar date does not exist (e.g. leap day in non-leap year)");
      }
    }

    return { type: "iso", value: millis };
  }


  if (/^\d{1,4}\/\d{1,2}\/\d{1,4}$/.test(input.replace(/\s+/g, '')) && !isIsoForm) {
    throw new TimeError("ambiguous-date", "Ambiguous date format. Use ISO 8601 (YYYY-MM-DD)");
  }

  try {
    const res = evaluateArithmetic(input);
    return { type: "numeric", value: res.value, isExpr: res.isExpr };
  } catch(e) {
    if (e instanceof TimeError) throw e;
    throw new TimeError("invalid-input", "Input could not be parsed as ISO date or numeric arithmetic");
  }
}

/**
 * The local wall-clock time and offset for `millis` in `timeZone`, read from `Intl`
 * (never the host's own zone). `longOffset` gives whole-second precision, which the tz
 * database needs for pre-1900s zones defined in local mean time (e.g. Asia/Kolkata's
 * historical +05:53:28). The year is read back from the era so 1 BC round-trips as
 * astronomical year 0, matching `isoUtc`'s extended-year convention.
 */
function formatLocal(millis, timeZone) {
  let parts;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
      timeZoneName: "longOffset",
    });
    parts = Object.fromEntries(formatter.formatToParts(new Date(millis)).map((part) => [part.type, part.value]));
  } catch {
    throw new TimeError("invalid-timezone", `Unknown time zone: ${timeZone}`);
  }

  let year = parseInt(parts.year, 10);
  if (parts.era === "BC") year = 1 - year;
  const yearStr = (year < 0 ? "-" : "") + String(Math.abs(year)).padStart(4, "0");
  const milliseconds = String(new Date(millis).getUTCMilliseconds()).padStart(3, "0");
  const utcOffset = parts.timeZoneName.replace(/^GMT/, "") || "+00:00";

  return {
    timeZone,
    utcOffset,
    local: `${yearStr}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${utcOffset}`,
  };
}

function getOutputs(millis, nowISO, timeZone) {
  if (millis < -8640000000000000 || Math.ceil(millis) > 8640000000000000) {
    throw new TimeError("out-of-range", "Timestamp is outside the ECMAScript date range (±8,640,000,000,000,000 ms)");
  }

  const d = new Date(millis);
  if (isNaN(d)) throw new TimeError("invalid-date", "Invalid date");
  const isoUtc = d.toISOString();
  const dateUtc = isoUtc.split("T")[0];
  const timeUtc = isoUtc.split("T")[1];

  const start = new Date(0);
  start.setUTCFullYear(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);

  const dateForWeek = new Date(d.getTime());
  dateForWeek.setUTCDate(dateForWeek.getUTCDate() + 4 - (dateForWeek.getUTCDay() || 7));
  const yearStart = new Date(0);
  yearStart.setUTCFullYear(dateForWeek.getUTCFullYear(), 0, 1);
  const isoWeek = Math.ceil((((dateForWeek - yearStart) / 86400000) + 1) / 7);

  const year = d.getUTCFullYear();
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);

  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekday = weekdayNames[d.getUTCDay()];

  const now = new Date(nowISO).getTime();
  const diffSecs = Math.floor((millis - now) / 1000);

  let relative;
  const abs = Math.abs(diffSecs);
  if (abs < 60) relative = diffSecs < 0 ? `${abs} seconds ago` : `in ${abs} seconds`;
  else if (abs < 3600) relative = diffSecs < 0 ? `${Math.floor(abs/60)} minutes ago` : `in ${Math.floor(abs/60)} minutes`;
  else if (abs < 86400) relative = diffSecs < 0 ? `${Math.floor(abs/3600)} hours ago` : `in ${Math.floor(abs/3600)} hours`;
  else relative = diffSecs < 0 ? `${Math.floor(abs/86400)} days ago` : `in ${Math.floor(abs/86400)} days`;
  if (diffSecs === 0) relative = "now";

  const local = formatLocal(millis, timeZone);

  return {
    epochSeconds: millis / 1000,
    epochMilliseconds: millis,
    isoUtc,
    dateUtc,
    timeUtc,
    timeZone: local.timeZone,
    utcOffset: local.utcOffset,
    local: local.local,
    weekday,
    dayOfYear,
    isoWeek,
    leapYear,
    relative
  };
}

function normalizeOptions(options) {
  const interpretation = options?.interpretation ?? "auto";
  if (!["auto", "seconds", "milliseconds", "iso"].includes(interpretation)) {
    throw new TimeError("invalid-option", "interpretation must be auto, seconds, milliseconds, or iso", { option: "interpretation" });
  }

  const msDigitsRaw = options?.["milliseconds-from-digits"];
  const msDigits = typeof msDigitsRaw === "string" && /^-?\d+$/.test(msDigitsRaw) ? Number(msDigitsRaw) : (msDigitsRaw ?? 12);
  if (!Number.isInteger(msDigits) || msDigits < 1) {
    throw new TimeError("invalid-option", "milliseconds-from-digits must be an integer >= 1", { option: "milliseconds-from-digits" });
  }

  return { interpretation, msDigits };
}

export async function execute(request, context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();

  const options = request?.options ?? {};
  const { interpretation: interpOption, msDigits } = normalizeOptions(options);

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

  let inputRaw = bytes ? new TextDecoder().decode(bytes) : "";

  const inputStr = inputRaw?.trim();

  const nowISO = context.clock.now();
  let millis;
  let interpretation = "auto";
  let expression = false;

  if (!inputStr) {
    millis = Date.parse(nowISO);
    interpretation = "now";
  } else {
    const parsed = parseInput(inputStr, interpOption);
    if (parsed.type === "iso") {
      millis = parsed.value;
      interpretation = "iso";
    } else {
      let numericVal = parsed.value;
      expression = parsed.isExpr;

      let asMs = false;
      if (interpOption === "milliseconds") {
        asMs = true;
      } else if (interpOption === "seconds") {
        asMs = false;
      } else {
        const intStr = String(Math.abs(Math.trunc(numericVal)));
        if (intStr.length >= msDigits) asMs = true;
        else asMs = false;
      }

      interpretation = asMs ? "milliseconds" : "seconds";
      millis = asMs ? numericVal : numericVal * 1000;
    }
  }

  const timeZone = context.clock.timeZone();
  const outputs = getOutputs(millis, nowISO, timeZone);

  const resultObj = {
    ...outputs,
    interpretation
  };
  if (expression) resultObj.expression = true;

  let textOut = "";
  for (const [k, v] of Object.entries(resultObj)) {
    textOut += `${k}: ${v}\n`;
  }

  await context.writeValue("output", resultObj);
  await context.write("output", new TextEncoder().encode(textOut));

  return resultObj;
}
