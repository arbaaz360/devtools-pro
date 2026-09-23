/**
 * An image result goes on the clipboard as PNG: the one image type the async
 * clipboard writes, and the one every paste target (Paint, Word, a chat box) reads.
 */

/** The source of an image result: complete bytes (PNG, JPEG) or SVG markup. */
export type ImageSource =
  | { kind: "bytes"; mime: string; dataUri: string }
  | { kind: "svg"; markup: string };

/**
 * The whole-number scale that brings a drawing's long side to at least `target`
 * pixels. Whole numbers keep every source pixel the same size, so a QR code's
 * modules stay square and its edges stay sharp, which is what makes it scan.
 */
export function rasterScale(width: number, height: number, target = 512): number {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return 1;
  return Math.max(1, Math.ceil(target / longest));
}

/** The bytes of a base64 data URI. Decoded here, because the CSP does not let fetch read data: URIs. */
export function dataUriBytes(dataUri: string): Uint8Array<ArrayBuffer> {
  const comma = dataUri.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(dataUri.slice(0, comma))) throw new Error("The image is not a base64 data URI.");
  const binary = atob(dataUri.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** PNG bytes for an image result. A PNG passes through untouched; anything else is drawn once. */
export async function imageAsPng(source: ImageSource): Promise<Blob> {
  if (source.kind === "bytes" && source.mime === "image/png")
    return new Blob([dataUriBytes(source.dataUri)], { type: "image/png" });
  const image = new Image();
  image.src =
    source.kind === "bytes"
      ? source.dataUri
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source.markup)}`;
  await image.decode();
  // An SVG with only a viewBox has no natural size; draw it at the target size.
  const width = image.naturalWidth || 512;
  const height = image.naturalHeight || 512;
  const scale = source.kind === "svg" ? rasterScale(width, height) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The image could not be drawn.");
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded as PNG."))),
      "image/png",
    ),
  );
}
