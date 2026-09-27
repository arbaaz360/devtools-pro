import type { FileDocument, Format, ToolManifest } from "../bridge";
import type { OptionSpec } from "../../../../packages/plugin-contract/ts/generated.ts";
import type { TabState } from "./state";
import { groupFor, initials } from "../plugins/describe.ts";

export interface ToolDefinition {
  id: string;
  label: string;
  /** What the tool does, in one line: the rail and tool-header subtitle. */
  description: string;
  group: string;
  icon: string;
  defaultOperation: string;
  defaultOptions: Record<string, unknown>;
  input: "text" | "image" | "bytes";
  auto: boolean;
  compare?: boolean;
  /** Generators may run with an empty document. */
  emptyInput?: boolean;
  operations: readonly ToolOperationDefinition[];
}
export interface ToolOperationDefinition {
  id: string;
  label: string;
  /** Declared options rendered as generic controls (package tools). */
  options?: readonly OptionSpec[];
  autoOnInput?: boolean;
  autoOnOption?: boolean;
  /** False when the operation has no document input (a generator). */
  readsDocument?: boolean;
}
/** Why the shell wants to run: a press always runs, the rest ask the manifest. */
export type RunReason = "explicit" | "input" | "option" | "select";
export const operationOf = (
  tool: ToolDefinition,
  operationId: string | undefined,
): ToolOperationDefinition | undefined =>
  tool.operations.find((operation) => operation.id === operationId) ?? tool.operations[0];
/** The controls to render: the active operation's own options. */
export const optionSchemaFor = (
  tool: ToolDefinition,
  operationId: string | undefined,
): readonly OptionSpec[] => operationOf(tool, operationId)?.options ?? [];
/**
 * Whether the shell may start this run without the user pressing the operation.
 * A bundled tool has no manifest and keeps the catalog's own `auto` flag; a
 * package operation is governed by the trigger modes it declares.
 */
export function runsAutomatically(
  tool: ToolDefinition,
  operationId: string | undefined,
  reason: RunReason,
): boolean {
  if (reason === "explicit") return true;
  const operation = operationOf(tool, operationId);
  if (!operation || operation.autoOnInput === undefined) return tool.auto;
  if (reason === "input") return operation.autoOnInput;
  // Selecting a tool starts it the same way an option change would: a generator
  // shows its first value, a document tool waits unless it follows the document.
  return operation.autoOnOption ?? operation.autoOnInput;
}
/** Whether the document is an input to this operation. Every bundled tool reads it. */
export const readsDocument = (tool: ToolDefinition, operationId: string | undefined): boolean =>
  operationOf(tool, operationId)?.readsDocument ?? true;
/**
 * The workspace a tool is laid out in (docs/DESIGN_SYSTEM.md, "Purpose-built workspaces").
 * A package tool's generator kind arrives as `emptyInput` (its manifest workspace is a
 * generator); a compare or image tool says so by its renderer and input. The rest are
 * named here: the native tools, and the two package tools whose manifests say
 * "transform" but whose output is a rendered page or a list of findings.
 */
export type WorkspaceKind = "transform" | "inspect" | "generator" | "image" | "compare" | "viewer" | "editor";
const WORKSPACE_KINDS: Record<string, WorkspaceKind> = {
  "editor.text": "editor",
  "text.find-replace": "editor",
  "text.inspect": "inspect",
  "structured.csv": "inspect",
  "preview.documents": "viewer",
};
export function workspaceKind(tool: ToolDefinition | undefined): WorkspaceKind {
  if (!tool) return "editor";
  if (tool.compare) return "compare";
  if (tool.input === "image") return "image";
  return WORKSPACE_KINDS[tool.id] ?? (tool.emptyInput ? "generator" : "transform");
}
const op = (id: string, label: string) => ({ id, label });
const define = (
  id: string,
  label: string,
  description: string,
  group: string,
  icon: string,
  input: ToolDefinition["input"],
  operations: ToolDefinition["operations"],
  defaultOptions = {},
  compare = false,
): ToolDefinition => ({
  id,
  label,
  description,
  group,
  icon,
  input,
  operations,
  defaultOperation: operations[0]?.id ?? "",
  defaultOptions,
  auto: operations.length > 0,
  compare,
});
// Names, groups, descriptions and glyphs follow docs/RELEASE_UI_SPEC.md; package tools
// take theirs from their manifests (plugins/describe.ts).
export const editor = define(
  "editor.text",
  "Text Editor",
  "A plain text document with no tool attached",
  "WORKSPACE",
  "✎",
  "bytes",
  [],
);
export const bundledTools: readonly ToolDefinition[] = [
  editor,
  define("structured.json", "JSON Formatter", "Format, minify or validate JSON", "FORMAT", "{}", "text", [
    op("format", "Format"),
    op("minify", "Minify"),
    op("inspect", "Validate"),
  ]),
  define("structured.csv", "CSV Inspector", "Rows, columns and delimiter of a CSV document", "FORMAT", "▤", "text", [
    op("inspect", "Inspect"),
  ]),
  define("text.inspect", "Text Inspector", "Bytes, characters, lines, words and line endings", "TEXT", "¶", "text", [
    op("inspect", "Inspect"),
  ]),
  define(
    "encoding.image-base64",
    "Image to Base64",
    "A PNG or JPEG as a Base64 string or data URI",
    "ENCODE",
    "▧",
    "image",
    [op("encode", "Encode")],
    { dataUri: true },
  ),
  define(
    "encoding.base64-image",
    "Base64 to Image",
    "A Base64 string or data URI back to an image",
    "ENCODE",
    "◧",
    "text",
    [op("decode", "Decode")],
  ),
  define(
    "text.json-string",
    "JSON String Escape / Unescape",
    "Text as a JSON string literal, and back",
    "ENCODE",
    '""',
    "text",
    [op("escape", "Escape"), op("unescape", "Unescape")],
  ),
  {
    ...define(
      "text.find-replace",
      "Find & Replace",
      "Find text in the document and replace it",
      "TEXT",
      "⌕",
      "text",
      [op("find", "Find"), op("replace", "Replace")],
    ),
    auto: false,
  },
  define("encoding.hash", "Hash Generator", "SHA-256 and SHA-512 digests of text or a file", "ENCODE", "#", "bytes", [
    op("sha256", "SHA-256"),
    op("sha512", "SHA-512"),
  ]),
  define("text.url", "URL Encode / Decode", "Percent-encode text, or decode it", "ENCODE", "%", "text", [
    op("encode", "Encode"),
    op("decode", "Decode"),
  ]),

  define(
    "text.unicode",
    "Unicode Escape / Unescape",
    "\\uXXXX escapes for non-ASCII text, and back",
    "ENCODE",
    "U+",
    "text",
    [op("encode", "Escape"), op("decode", "Unescape")],
  ),
  define(
    "text.compare",
    "Text Diff",
    "Line-by-line differences between two texts",
    "TEXT",
    "⇄",
    "text",
    [op("compare", "Compare")],
    { newline: "preserve", contextLines: 3 },
    true,
  ),
  define("web.curl-code", "cURL to Code", "A cURL command as JavaScript fetch or Python requests", "CONVERT", "$", "text", [
    op("fetch", "JavaScript fetch"),
    op("python", "Python requests"),
  ]),
];
function manifestTool(manifest: ToolManifest): ToolDefinition {
  // What the input port declares decides an image tool; the tool's name has no say.
  const input: ToolDefinition["input"] = manifest.inputContent === "image"
    ? "image"
    : manifest.inputKinds.includes("bytes")
      ? "bytes"
      : "text";
  const group = manifest.group ?? groupFor(undefined, manifest.id.split(".")[0]) ?? "CONVERT";
  const icon = manifest.icon ?? initials(manifest.label);
  // A v1 manifest declares no per-operation policy: leave those fields off entirely
  // so such a tool keeps the catalog's own `auto` flag rather than an empty policy.
  const operations: ToolOperationDefinition[] = manifest.operations.map((operation) => ({
    id: operation.id,
    label: operation.label,
    ...(operation.options ? { options: operation.options } : {}),
    ...(operation.autoOnInput === undefined
      ? {}
      : { autoOnInput: operation.autoOnInput, autoOnOption: operation.autoOnOption ?? operation.autoOnInput }),
    ...(operation.readsDocument === undefined ? {} : { readsDocument: operation.readsDocument }),
  }));
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description ?? "",
    group,
    icon,
    input,
    operations,
    defaultOperation: operations[0]?.id ?? "",
    defaultOptions: manifest.operations[0]?.defaultOptions ?? {},
    auto: manifest.auto ?? operations.length > 0,
    compare: manifest.renderer === "diff",
    emptyInput: manifest.emptyInput,
  };
}

export const definition = (id: string, manifests?: ReadonlyMap<string, ToolManifest>) =>
  bundledTools.find((tool) => tool.id === id) ?? (manifests?.get(id) ? manifestTool(manifests.get(id)!) : undefined);

export function definitionFromManifest(manifest: ToolManifest): ToolDefinition {
  return manifestTool(manifest);
}
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
  if (
    tool.id === "structured.csv" &&
    kind === "text" &&
    tab.source?.format === "json"
  )
    return "CSV Inspector requires comma-separated rows, but this document is detected as JSON. Open a CSV file or choose another tool.";
  if (
    tool.id === "structured.json" &&
    kind === "text" &&
    tab.source?.format === "csv"
  )
    return "JSON tools require a JSON document, but this document is detected as CSV. Open a JSON file or choose another tool.";
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
      return "Paste a cURL command that starts with curl.";
  }
  return null;
}
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "js",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "text/x-sql": "sql",
  "text/markdown": "md",
};
export function resultExtension(tab: TabState, mime?: string | null): string {
  if (mime && MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
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
