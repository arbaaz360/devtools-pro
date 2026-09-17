import { createHash } from "node:crypto";
import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const OPERATION_ID = "encoding.hash";
export const INPUT_PORT = "input";
export const CASES = Object.freeze(["lower", "upper"]);
const encoder = new TextEncoder();

/**
 * Output ports in manifest order. `id` is both the output port and the
 * node:crypto digest name; `hexLength` is the length of a complete digest.
 * MD2 and MD4 are deliberately absent: the bundled runtime does not provide
 * them (see README.md), and the package must not ship placeholder outputs.
 */
export const ALGORITHMS = Object.freeze([
  Object.freeze({ id: "md5", algorithm: "MD5", hexLength: 32 }),
  Object.freeze({ id: "sha1", algorithm: "SHA-1", hexLength: 40 }),
  Object.freeze({ id: "sha224", algorithm: "SHA-224", hexLength: 56 }),
  Object.freeze({ id: "sha256", algorithm: "SHA-256", hexLength: 64 }),
  Object.freeze({ id: "sha384", algorithm: "SHA-384", hexLength: 96 }),
  Object.freeze({ id: "sha512", algorithm: "SHA-512", hexLength: 128 })
]);

function describe(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/**
 * Validate request options and return the normalized presentation settings.
 * Unknown keys are rejected so a misspelled option cannot silently fall back
 * to the default; `case` only affects hexadecimal presentation.
 */
export function normalizeOptions(options) {
  if (options === undefined || options === null) return { case: "lower" };
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`options must be a JSON object, received ${describe(options)}`);
  }
  const unknown = Object.keys(options).filter((key) => key !== "case");
  if (unknown.length > 0) {
    const listed = unknown.map((key) => JSON.stringify(key)).join(", ");
    throw new Error(`unknown option${unknown.length > 1 ? "s" : ""} ${listed}; ${OPERATION_ID} accepts only "case"`);
  }
  const presentationCase = options.case === undefined || options.case === null ? "lower" : options.case;
  if (!CASES.includes(presentationCase)) {
    throw new Error(`case must be "lower" or "upper", received ${describe(options.case)}`);
  }
  return { case: presentationCase };
}

function validateRequest(request) {
  if (request !== undefined && request !== null && (typeof request !== "object" || Array.isArray(request))) {
    throw new Error(`request must be an object, received ${describe(request)}`);
  }
  const operationId = request?.operationId;
  if (operationId !== undefined && operationId !== OPERATION_ID) {
    throw new Error(`unsupported operation ${describe(operationId)}; this package provides only ${JSON.stringify(OPERATION_ID)}`);
  }
  return normalizeOptions(request?.options);
}

function oversized(context, measured, cause) {
  const limit = context.limits.maxInputBytes;
  return new Error(`${measured}, which exceeds the ${limit}-byte limit declared for ${OPERATION_ID}; no digest was produced`, cause ? { cause } : undefined);
}

/**
 * Turn an SDK read failure into a diagnostic that names the port, the byte
 * counts and the declared limit. Cancellation passes through untouched so
 * hosts can distinguish it from a failed job.
 */
async function describeReadFailure(error, context, bytesConsumed) {
  if (error instanceof ProcessorCancelled) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds/u.test(message) && /limit/u.test(message)) {
    let size;
    try { size = typeof context.reader?.size === "function" ? await context.reader.size(INPUT_PORT) : undefined; } catch { size = undefined; }
    return oversized(context, Number.isSafeInteger(size) ? `input is ${size} bytes` : `input is larger than ${bytesConsumed} bytes`, error);
  }
  if (/was not supplied/u.test(message)) {
    return new Error(`${OPERATION_ID} requires the named input port ${JSON.stringify(INPUT_PORT)}`, { cause: error });
  }
  return error;
}

/**
 * The SDK cannot tell end-of-stream from an overrun for a reader without
 * size(): once the limit is reached it requests zero bytes and treats the
 * empty reply as EOF, which would report a truncated digest as complete.
 * Probe one byte past the limit so an oversized stream is rejected instead.
 */
async function assertStreamEnded(context, inputBytes) {
  const reader = context.reader;
  if (inputBytes !== context.limits.maxInputBytes || typeof reader?.size === "function" || typeof reader?.readRange !== "function") return;
  const probe = await reader.readRange(INPUT_PORT, inputBytes, 1);
  if (probe.byteLength > 0) throw oversized(context, `input is larger than ${inputBytes} bytes`);
}

/**
 * Hash one named byte stream with all supported algorithms in one pass.
 * readChunks is deliberately used so hosts can provide range-backed readers
 * without materializing a full document in the processor. Every chunk is
 * forwarded to every hasher unchanged; no decoding, trimming or newline
 * normalization happens here. Outputs are emitted only after the whole input
 * has been read, so a cancelled job never leaves partial digests behind.
 */
export async function execute(request, context) {
  const { case: presentationCase } = validateRequest(request);

  const hashers = ALGORITHMS.map(({ id }) => createHash(id));
  let inputBytes = 0;
  try {
    for await (const chunk of context.readChunks(INPUT_PORT)) {
      inputBytes += chunk.byteLength;
      for (const hasher of hashers) hasher.update(chunk);
    }
  } catch (error) {
    throw await describeReadFailure(error, context, inputBytes);
  }
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
  await assertStreamEnded(context, inputBytes);

  const results = {};
  for (const [index, { id, algorithm }] of ALGORITHMS.entries()) {
    const raw = hashers[index].digest("hex");
    const digest = presentationCase === "upper" ? raw.toUpperCase() : raw;
    const value = {
      algorithm,
      digest,
      case: presentationCase,
      source: INPUT_PORT,
      inputBytes,
      encoding: "hex",
      complete: true
    };
    results[id] = value;
    await context.writeValue(id, value);
    await context.write(id, encoder.encode(digest));
  }
  return results;
}
