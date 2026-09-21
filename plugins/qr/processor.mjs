import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { qrcode } from "../../packages/vendor/qrcode-generator/qrcode.mjs";

export const OPERATION_ID = "media.qr";

export class QrError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "QrError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data };
  }
}

const check = context => {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
};

const invalid = (message, data) => new QrError("qr.invalid-option", message, data);

const ERROR_CORRECTION_LEVELS = ["L", "M", "Q", "H"];

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  const known = new Set(["error-correction", "errorCorrection", "cell-size", "cellSize", "margin", "version"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...known] });
  }

  let errorCorrection = "M";
  if (raw["error-correction"] !== undefined) errorCorrection = raw["error-correction"];
  else if (raw.errorCorrection !== undefined) errorCorrection = raw.errorCorrection;
  if (!ERROR_CORRECTION_LEVELS.includes(errorCorrection)) {
    throw invalid(`error-correction must be one of ${ERROR_CORRECTION_LEVELS.join(", ")}`, { option: "error-correction", received: errorCorrection });
  }

  let cellSize = 8;
  if (raw["cell-size"] !== undefined) cellSize = raw["cell-size"];
  else if (raw.cellSize !== undefined) cellSize = raw.cellSize;
  if (!Number.isInteger(cellSize) || cellSize < 1 || cellSize > 40) {
    throw invalid(`cell-size must be an integer from 1 to 40`, { option: "cell-size", received: cellSize });
  }

  const margin = raw.margin !== undefined ? raw.margin : 4;
  if (!Number.isInteger(margin) || margin < 0 || margin > 16) {
    throw invalid(`margin must be an integer from 0 to 16`, { option: "margin", received: margin });
  }

  const version = raw.version !== undefined ? raw.version : 0;
  if (!Number.isInteger(version) || version < 0 || version > 40) {
    throw invalid(`version must be an integer from 0 to 40`, { option: "version", received: version });
  }

  return { errorCorrection, cellSize, margin, version };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 65536)) {
    check(context);
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) {
      throw new QrError("qr.capacity", `input exceeds ${context.limits.maxInputBytes} bytes limit`, { bytes: length, limit: context.limits.maxInputBytes });
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  if (length === 0) throw new QrError("qr.empty", "input is empty", { bytes: 0 });

  let text;
  try { text = decoder.decode(bytes); } catch { throw new QrError("qr.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new QrError("qr.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }

  const options = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);

  let qr;
  try {
    qr = qrcode(options.version, options.errorCorrection);
    qr.addData(text, "Byte");
    check(context);
    qr.make();
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("code length overflow")) {
      throw new QrError("qr.capacity", "input is too large for the requested QR version or level", { inputBytes, message: msg });
    }
    throw err;
  }

  check(context);

  const modules = qr.getModuleCount();
  const widthPx = modules * options.cellSize + 2 * options.margin * options.cellSize;

  const rawSvg = qr.createSvgTag({ cellSize: options.cellSize, margin: options.margin * options.cellSize, scalable: true });
  // Ensure <?xml version="1.0" encoding="UTF-8"?> is added and width/height attributes are in pixels
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n` + rawSvg;
  svg = svg.replace("<svg ", `<svg width="${widthPx}px" height="${widthPx}px" `);

  const outputBytes = encoder.encode(svg);

  if (outputBytes.byteLength > context.limits.maxOutputBytes) {
    throw new QrError("qr.output-limit", `output exceeds ${context.limits.maxOutputBytes} bytes limit`, { bytes: outputBytes.byteLength, limit: context.limits.maxOutputBytes });
  }

  const report = {
    version: (modules - 17) / 4,
    modules,
    errorCorrection: options.errorCorrection,
    cellSize: options.cellSize,
    margin: options.margin,
    widthPx,
    inputBytes,
    bytes: outputBytes.byteLength
  };

  await context.writeValue("output", report);
  await context.write("output", outputBytes);
  return report;
}
