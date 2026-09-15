import { createHash } from "node:crypto";

const ALGORITHMS = [
  ["md5", "MD5"],
  ["sha1", "SHA-1"],
  ["sha224", "SHA-224"],
  ["sha256", "SHA-256"],
  ["sha384", "SHA-384"],
  ["sha512", "SHA-512"]
];

/**
 * Hash one named byte stream with all supported algorithms in one pass.
 * readChunks is deliberately used here so hosts can provide range-backed
 * readers without materializing a full document in the processor.
 */
export async function execute(request, context) {
  const options = request?.options ?? {};
  const presentationCase = options.case ?? "lower";
  if (presentationCase !== "lower" && presentationCase !== "upper") {
    throw new Error("case must be lower or upper");
  }

  const hashers = new Map(ALGORITHMS.map(([id]) => [id, createHash(id)]));
  let inputBytes = 0;
  for await (const chunk of context.readChunks("input")) {
    inputBytes += chunk.byteLength;
    for (const hasher of hashers.values()) hasher.update(chunk);
  }

  const results = {};
  for (const [id, label] of ALGORITHMS) {
    const raw = hashers.get(id).digest("hex");
    const digest = presentationCase === "upper" ? raw.toUpperCase() : raw;
    const value = {
      algorithm: label,
      digest,
      case: presentationCase,
      inputBytes,
      encoding: "hex",
      complete: true
    };
    results[id] = value;
    await context.writeValue(id, value);
    await context.write(id, new TextEncoder().encode(digest));
  }
  return results;
}
