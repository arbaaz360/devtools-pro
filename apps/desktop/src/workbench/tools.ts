import type { FileDocument, Format, ToolManifest } from "../bridge";
import type { TabState } from "./state";

export interface ToolDefinition {
  id: string;
  label: string;
  group: string;
  icon: string;
  defaultOperation: string;
  defaultOptions: Record<string, unknown>;
  input: "text" | "image" | "bytes";
  auto: boolean;
  compare?: boolean;
  operations: readonly { id: string; label: string }[];
}
const op = (id: string, label: string) => ({ id, label });
const define = (
  id: string,
  label: string,
  group: string,
  icon: string,
  input: ToolDefinition["input"],
  operations: ToolDefinition["operations"],
  defaultOptions = {},
  compare = false,
): ToolDefinition => ({
  id,
  label,
  group,
  icon,
  input,
  operations,
  defaultOperation: operations[0]?.id ?? "",
  defaultOptions,
  auto: operations.length > 0,
  compare,
});
export const editor = define(
  "editor.text",
  "Text editor",
  "WORKSPACE",
  "Aa",
  "bytes",
  [],
);
export const bundledTools: readonly ToolDefinition[] = [
  editor,
  define("structured.json", "JSON", "STRUCTURED DATA", "{}", "text", [
    op("format", "Format"),
    op("minify", "Minify"),
    op("inspect", "Validate"),
  ]),
  define("structured.csv", "CSV inspector", "STRUCTURED DATA", "▦", "text", [
    op("inspect", "Inspect"),
  ]),
  define("text.inspect", "Text inspector", "TEXT & ENCODING", "Aa", "text", [
    op("inspect", "Inspect"),
  ]),
  define(
    "encoding.image-base64",
    "Image to Base64",
    "TEXT & ENCODING",
    "▧",
    "image",
    [op("encode", "Encode")],
    { dataUri: true },
  ),
  define(
    "encoding.base64-image",
    "Base64 to Image",
    "TEXT & ENCODING",
    "▧",
    "text",
    [op("decode", "Decode")],
  ),
  define(
    "text.json-string",
    "JSON escape / unescape",
    "TEXT & ENCODING",
    "{}",
    "text",
    [op("escape", "Escape"), op("unescape", "Unescape")],
  ),
  {
    ...define(
      "text.find-replace",
      "Find & Replace",
      "TEXT & ENCODING",
      "⌕",
      "text",
      [op("find", "Find"), op("replace", "Replace")],
    ),
    auto: false,
  },
  define("encoding.hash", "Hash generator", "TEXT & ENCODING", "#", "bytes", [
    op("sha256", "SHA-256"),
    op("sha512", "SHA-512"),
  ]),
  define("text.url", "URL encode / decode", "TEXT & ENCODING", "%", "text", [
    op("encode", "Encode"),
    op("decode", "Decode"),
  ]),
  define(
    "text.html",
    "HTML escape / unescape",
    "TEXT & ENCODING",
    "&",
    "text",
    [op("escape", "Escape"), op("unescape", "Unescape")],
  ),
  define(
    "text.unicode",
    "Unicode escape / unescape",
    "TEXT & ENCODING",
    "U",
    "text",
    [op("encode", "Escape"), op("decode", "Unescape")],
  ),
  define(
    "text.compare",
    "Diff & Compare",
    "COMPARE",
    "⇄",
    "text",
    [op("compare", "Compare")],
    { newline: "preserve", contextLines: 3 },
    true,
  ),
  define("web.curl-code", "cURL to Code", "WEB & API", "↗", "text", [
    op("fetch", "JavaScript fetch"),
    op("python", "Python requests"),
  ]),
];
export const definition = (id: string) =>
  bundledTools.find((tool) => tool.id === id);
export function defaultTool(document: FileDocument): string {
  if (document.contentKind === "image") return "encoding.image-base64";
  return document.contentKind === "text" && document.format === "json"
    ? "structured.json"
    : document.contentKind === "text" && document.format === "csv"
      ? "structured.csv"
      : editor.id;
}
export function snapshotFormat(tab: TabState): Format {
  return tab.toolId === "structured.json"
    ? "json"
    : tab.toolId === "structured.csv"
      ? "csv"
      : "text";
}
export function validation(
  tab: TabState,
  tool: ToolDefinition,
  manifest?: ToolManifest,
): string | null {
  const kind = tab.source?.contentKind ?? "text";
  if (
    tool.input === "image" &&
    (kind !== "image" ||
      !["image/png", "image/jpeg"].includes(tab.source?.mime ?? ""))
  )
    return `${tool.label} requires a PNG or JPEG image. Open an image in this tab or choose another tool.`;
  if (tool.input === "text" && kind !== "text")
    return `${tool.label} accepts text, not ${kind === "image" ? "images" : "binary files"}. Choose a text tab or create a new document.`;
  if (manifest?.limits.maxInputBytes != null) {
    const size =
      tab.text === null
        ? (tab.source?.size ?? 0)
        : new TextEncoder().encode(tab.text).length;
    if (size > manifest.limits.maxInputBytes)
      return `${tool.label} accepts at most ${Math.round(manifest.limits.maxInputBytes / 1024)} KiB per input.`;
  }
  if (tool.id === "web.curl-code") {
    const text = (tab.text ?? tab.source?.preview ?? "").trim();
    if (text && !/^curl(?:\s|$)/i.test(text))
      return "Paste a cURL command beginning with curl. Images and other document formats cannot be converted into a request.";
  }
  return null;
}
export function resultExtension(tab: TabState, mime?: string | null): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (
    tab.toolId === "structured.json" ||
    tab.toolId === "text.compare" ||
    mime === "application/json"
  )
    return "json";
  if (tab.toolId === "web.curl-code")
    return tab.operation === "python" ? "py" : "js";
  return "txt";
}
