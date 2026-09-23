import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import jsQR from "../../packages/vendor/jsqr/jsqr.mjs";

export const OPERATION_ID = "media.qr-reader";

export class QrReaderError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "QrReaderError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data };
  }
}

const check = context => {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
};

const invalid = (message, data) => new QrReaderError("qr.invalid-option", message, data);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  const known = new Set(["invert", "try-harder", "tryHarder"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...known] });
  }

  let invert = false;
  if (raw.invert !== undefined) invert = raw.invert;
  if (typeof invert !== "boolean") throw invalid("invert must be a boolean", { option: "invert", received: invert });

  let tryHarder = true;
  if (raw["try-harder"] !== undefined) tryHarder = raw["try-harder"];
  else if (raw.tryHarder !== undefined) tryHarder = raw.tryHarder;
  if (typeof tryHarder !== "boolean") throw invalid("try-harder must be a boolean", { option: "try-harder", received: tryHarder });

  return { invert, tryHarder };
}

const encoder = new TextEncoder();

/** Flips each RGB channel (not alpha), so a genuinely inverted (white-on-dark) code decodes as if it were normal polarity. */
function invertPixels(pixels) {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    out[i] = 255 - pixels[i];
    out[i + 1] = 255 - pixels[i + 1];
    out[i + 2] = 255 - pixels[i + 2];
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

const round = point => ({ x: Math.round(point.x), y: Math.round(point.y) });

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new QrReaderError("qr.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }

  const options = normalizeOptions(request?.options);

  const info = await context.info("input");
  if (info.contentKind !== "image" || typeof info.width !== "number" || typeof info.height !== "number") {
    throw new QrReaderError("qr.not-an-image", "input port does not carry decoded image pixels with a width and height", { contentKind: info.contentKind });
  }
  const { width, height } = info;

  check(context);
  const rawPixels = await context.read("input");
  const expectedBytes = width * height * 4;
  if (rawPixels.byteLength !== expectedBytes) {
    throw new QrReaderError("qr.not-an-image", `pixel buffer of ${rawPixels.byteLength} bytes does not match ${width}x${height} RGBA`, { width, height, bytes: rawPixels.byteLength, expected: expectedBytes });
  }

  const pixels = options.invert ? invertPixels(rawPixels) : rawPixels;
  const inversionAttempts = options.tryHarder ? "attemptBoth" : "dontInvert";

  check(context);
  const decoded = jsQR(pixels, width, height, { inversionAttempts });
  check(context);

  if (!decoded) {
    throw new QrReaderError("qr.not-found", "no QR code was found in the image; try a sharper crop, better contrast, or the invert option", { imageWidth: width, imageHeight: height, invert: options.invert, tryHarder: options.tryHarder });
  }

  const outputBytes = encoder.encode(decoded.data);

  const report = {
    text: decoded.data,
    bytes: outputBytes.byteLength,
    version: decoded.version,
    imageWidth: width,
    imageHeight: height,
    location: {
      topLeft: round(decoded.location.topLeftCorner),
      topRight: round(decoded.location.topRightCorner),
      bottomLeft: round(decoded.location.bottomLeftCorner),
      bottomRight: round(decoded.location.bottomRightCorner)
    }
  };

  await context.writeValue("output", report);
  await context.write("output", outputBytes);
  return report;
}
