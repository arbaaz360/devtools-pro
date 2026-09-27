import type { Annotation, ToolManifest, ToolOperation } from "../bridge";
import type {
  Condition,
  OperationSpec,
  OptionSpec,
  PluginManifest,
  ToolSpec,
} from "../../../../packages/plugin-contract/ts/generated.ts";

/**
 * Turns a v2 package manifest into the tool entries the shell already knows
 * how to render and run. The shell keeps one catalog shape (ToolManifest) for
 * every engine; a package tool differs only in the extras the engine needs.
 */
export interface EngineTool {
  /** Sidebar identity: the v2 tool id, which is what run requests carry. */
  id: string;
  pluginId: string;
  /** Package directory name, which is how the worker locates the processor. */
  packageDir: string;
  tool: ToolSpec;
  operations: OperationSpec[];
  manifest: ToolManifest;
}

/** The rail's groups, in the fixed order it shows them (RELEASE_UI_SPEC.md, "Rail groups"). */
export const GROUP_ORDER: readonly string[] = ["WORKSPACE", "FORMAT", "CONVERT", "ENCODE", "TEXT", "WEB & SECURITY", "GENERATE"];
/**
 * A manifest's `category` (or, failing that, its tool id's family) to a rail group. The
 * legacy categories still map, so no tool falls through to an upper-cased raw category.
 */
const GROUPS: Record<string, string> = {
  format: "FORMAT",
  convert: "CONVERT",
  encode: "ENCODE",
  text: "TEXT",
  web: "WEB & SECURITY",
  security: "WEB & SECURITY",
  generate: "GENERATE",
  converter: "CONVERT",
  encoding: "ENCODE",
  structured: "FORMAT",
  compare: "TEXT",
  generator: "GENERATE",
  identity: "GENERATE",
  media: "GENERATE",
  time: "CONVERT",
  number: "CONVERT",
  viewer: "FORMAT",
};
export const groupFor = (category: string | undefined, family?: string): string | undefined =>
  (category ? GROUPS[category] : undefined) ?? (family ? GROUPS[family] : undefined);
/** One distinct glyph per package tool, legible in a 20px box. Native tools set theirs in tools.ts. */
const ICONS: Record<string, string> = {
  "format.css": "CSS",
  "format.html": "</>",
  "format.js": "JS",
  "format.sql": "SQL",
  "format.xml": "<>",
  "preview.documents": "md",
  "convert.yaml": "Y",
  "convert.jsx": "JSX",
  "number.base": "10",
  "time.unix": "t",
  "text.case": "Aa",
  "encoding.base64-text": "64",
  "encoding.hex": "0x",
  "text.html": "&",
  "text.backslash": "\\",
  "text.lines": "≡",
  "text.regex": ".*",
  "web.url-parser": "?",
  "security.jwt": "JWT",
  "identity.uuid": "id",
  "media.qr": "▦",
  "media.qr-reader": "⌖",
  "generate.examples": "…",
};
/** A tool the table does not know yet still gets a legible mark: its name's initials. */
export const initials = (title: string): string =>
  title.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";

/** Package tools whose category marks them as samples, not products. */
export const isSampleTool = (tool: ToolSpec): boolean => tool.category === "examples";

/** Option values as processors expect them: numbers for numeric options. */
export function optionDefault(option: OptionSpec): unknown {
  switch (option.type) {
    case "integer":
    case "decimal":
      return Number(option.default);
    case "boolean":
    case "string":
    case "enum":
    case "list":
    case "record":
    case "taggedUnion":
      return option.default;
    default:
      return undefined;
  }
}

export function defaultOptions(operation: OperationSpec): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const option of operation.options) {
    const value = optionDefault(option);
    if (value !== undefined) options[option.id] = value;
  }
  return options;
}

/**
 * The options a run sends: only the operation's declared ids, each with its
 * default when the tab holds nothing for it. Processors reject unknown keys,
 * and a tab keeps its options across operation switches.
 */
export function prepareOptions(
  operation: OperationSpec,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const options = defaultOptions(operation);
  for (const option of operation.options)
    if (supplied[option.id] !== undefined) options[option.id] = supplied[option.id];
  return options;
}

/** Whether a predicate's value and an option's value are the same, as a form would read them. */
const sameValue = (current: unknown, expected: unknown): boolean =>
  current === expected ||
  (current !== undefined && current !== null && expected !== undefined && expected !== null &&
    typeof current !== "object" && typeof expected !== "object" && String(current) === String(expected));

/** A contract condition over the tab's option values. No expression language: four operators and three combinators. */
export function conditionHolds(condition: Condition, values: Readonly<Record<string, unknown>>): boolean {
  switch (condition.kind) {
    case "all":
      return condition.conditions.every((item) => conditionHolds(item, values));
    case "any":
      return condition.conditions.some((item) => conditionHolds(item, values));
    case "not":
      return !conditionHolds(condition.condition, values);
    case "predicate": {
      const current = values[condition.optionId];
      switch (condition.operator) {
        case "equals":
          return sameValue(current, condition.value);
        case "notEquals":
          return !sameValue(current, condition.value);
        case "in":
          return Array.isArray(condition.value) && condition.value.some((item) => sameValue(current, item));
        case "isSet":
          return current !== undefined && current !== null && current !== "";
        default:
          return true;
      }
    }
    default:
      return true;
  }
}

/**
 * How an option's control is shown, from its declared `rules` and the values the tab
 * would run with (its own over the defaults): hidden when a `visible` rule fails,
 * disabled when an `enabled` rule fails. `required` is the processor's to enforce.
 */
export function optionPresentation(
  option: OptionSpec,
  schema: readonly OptionSpec[],
  supplied: Readonly<Record<string, unknown>>,
): { visible: boolean; enabled: boolean } {
  const rules = option.rules ?? [];
  if (!rules.length) return { visible: true, enabled: true };
  const values: Record<string, unknown> = {};
  for (const item of schema) {
    const value = supplied[item.id] ?? optionDefault(item);
    if (value !== undefined) values[item.id] = value;
  }
  const holds = (effect: "visible" | "enabled") =>
    rules.filter((rule) => rule.effect === effect).every((rule) => conditionHolds(rule.when, values));
  return { visible: holds("visible"), enabled: holds("enabled") };
}

/**
 * A manifest's trigger policy, as the shell applies it. `inputChange` is the
 * permission to run as the document changes; `heldRepeat` belongs to generators,
 * whose options are their only input, so an option change may run those too.
 * An operation that declares neither runs only when its button is pressed.
 */
export const autoOnInput = (operation: OperationSpec): boolean =>
  operation.trigger.modes.includes("inputChange");
export const autoOnOption = (operation: OperationSpec): boolean =>
  autoOnInput(operation) || operation.trigger.modes.includes("heldRepeat");

/**
 * What a port's bytes are. A port declaring image content receives decoded pixels from
 * the engine rather than a container format, so a processor never parses PNG or JPEG
 * and stays runnable under node for its own tests.
 */
export function inputContentKind(port: OperationSpec["inputs"][number] | undefined): "text" | "image" {
  return port?.contentKinds?.includes("image") ? "image" : "text";
}

/** The engine feeds at most one document per run; compare-style tools stay native. */
export function primaryInput(operation: OperationSpec): OperationSpec["inputs"][number] | undefined {
  const documents = operation.inputs.filter((input) => input.kind === "document");
  return documents.length === 1 ? documents[0] : undefined;
}
/** Generators may declare no document input at all; two or more stay native. */
export function engineRunnable(operation: OperationSpec): boolean {
  return (
    operation.executor.kind === "javascriptWorker" &&
    operation.inputs.filter((input) => input.kind === "document").length <= 1
  );
}

export function primaryOutput(operation: OperationSpec): OperationSpec["outputs"][number] | undefined {
  return operation.outputs[0];
}

export const MAX_ANNOTATIONS = 20_000;

/**
 * Splits a package result value into the properties the result pane lists and the
 * editor annotations it carries. Anything that is not a well-formed span is dropped;
 * the list is capped so a runaway result cannot stall the editor.
 */
export function splitAnnotations(value: unknown): { properties: unknown; annotations: Annotation[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { properties: value, annotations: [] };
  const { annotations: raw, ...properties } = value as Record<string, unknown>;
  if (!Array.isArray(raw)) return { properties: value, annotations: [] };
  const annotations: Annotation[] = [];
  for (const item of raw) {
    if (annotations.length >= MAX_ANNOTATIONS) break;
    if (!item || typeof item !== "object") continue;
    const { start, end, kind, label } = item as Record<string, unknown>;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < (start as number)) continue;
    annotations.push({ start: start as number, end: end as number, kind: typeof kind === "string" ? kind : "match", label: typeof label === "string" ? label : undefined });
  }
  return { properties, annotations };
}

/** How the shell shows an output port: by mime first, then by declared representation. */
export function rendererFor(port: OperationSpec["outputs"][number] | undefined, produced: boolean, value: unknown): "text" | "json" | "preview" | "svg" {
  const mime = port?.mime ?? [];
  const representations = port?.representations ?? [];
  if (mime.includes("text/html") && representations.includes("previewDocument")) return "preview";
  if (mime.includes("image/svg+xml")) return "svg";
  if (mime.includes("application/json") || (!produced && value !== undefined)) return "json";
  return "text";
}

export function describePackage(manifest: PluginManifest, packageDir: string): EngineTool[] {
  const tools: EngineTool[] = [];
  for (const tool of manifest.tools) {
    if (isSampleTool(tool)) continue;
    const operations = tool.operationIds
      .map((id) => manifest.operations.find((operation) => operation.id === id))
      .filter((operation): operation is OperationSpec => !!operation)
      .filter(engineRunnable);
    if (!operations.length) continue;
    const workspace = manifest.workspaces.find((item) => item.id === tool.workspaceId);
    const first = operations[0]!;
    const output = primaryOutput(first);
    const limits = operations.reduce(
      (acc, operation) => ({
        maxInputBytes: Math.min(acc.maxInputBytes, Number(operation.limits.maxInputBytes)),
        maxOutputBytes: Math.min(acc.maxOutputBytes, Number(operation.limits.maxOutputBytes)),
      }),
      { maxInputBytes: Number.POSITIVE_INFINITY, maxOutputBytes: Number.POSITIVE_INFINITY },
    );
    const toolOperations: ToolOperation[] = operations.map((operation) => ({
      id: operation.id,
      label: operation.title,
      defaultOptions: defaultOptions(operation),
      options: operation.options,
      autoOnInput: autoOnInput(operation),
      autoOnOption: autoOnOption(operation),
      readsDocument: operation.inputs.length > 0,
    }));
    const family = tool.id.split(".")[0] ?? "";
    const image = inputContentKind(primaryInput(first)) === "image";
    tools.push({
      id: tool.id,
      pluginId: manifest.id,
      packageDir,
      tool,
      operations,
      manifest: {
        id: tool.id,
        label: tool.title,
        description: tool.description ?? manifest.description,
        contractVersion: 2,
        inputKinds: image ? ["bytes"] : ["text"],
        // An image tool is decided by what its input port declares, never by its name.
        ...(image ? { inputContent: "image" as const } : {}),
        limits,
        capabilities: {
          deterministic: true,
          supportsPreview: false,
          supportsStreaming: false,
          cancellation: true,
          progress: false,
          needsFilesystem: false,
          needsNetwork: false,
          needsSecrets: false,
        },
        operations: toolOperations,
        renderer: output?.mime?.includes("application/json") ? "json" : "text",
        engine: "worker",
        group: groupFor(tool.category, family) ?? tool.category.toUpperCase(),
        icon: ICONS[tool.id] ?? tool.icon ?? initials(tool.title),
        auto: operations.some(autoOnOption),
        emptyInput: workspace?.kind === "generator",
      },
    });
  }
  return tools;
}
