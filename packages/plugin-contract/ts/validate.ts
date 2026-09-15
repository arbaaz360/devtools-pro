import type { ContractDocument, ExecuteRequest, PluginManifest } from "./generated.ts";
import { CONTRACT_SCHEMA } from "./generated.ts";

export class ContractValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) { super(`contract validation failed at ${path}: ${message}`); this.path = path; }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const localRef = (ref: string): Record<string, unknown> => (CONTRACT_SCHEMA.$defs as Record<string, Record<string, unknown>>)[ref.slice(ref.lastIndexOf("/") + 1)]!;

function validateNode(value: unknown, original: Record<string, unknown>, path: string): void {
  const node = original.$ref ? localRef(String(original.$ref)) : original;
  if (Array.isArray(node.oneOf)) {
    let matches = 0;
    const errors: string[] = [];
    for (const option of node.oneOf as Record<string, unknown>[]) { try { validateNode(value, option, path); matches++; } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
    if (matches !== 1) throw new ContractValidationError(path, `expected exactly one schema alternative, matched ${matches}: ${errors.join(" | ")}`);
    return;
  }
  if ("const" in node && !Object.is(value, node.const)) throw new ContractValidationError(path, `expected constant ${JSON.stringify(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.some((item) => Object.is(item, value))) throw new ContractValidationError(path, "value is not an allowed enum member");
  const kind = node.type;
  if (typeof kind === "string") {
    const valid = kind === "object" ? isObject(value) : kind === "array" ? Array.isArray(value) : kind === "string" ? typeof value === "string" : kind === "boolean" ? typeof value === "boolean" : kind === "integer" ? typeof value === "number" && Number.isInteger(value) : kind === "number" ? typeof value === "number" : kind === "null" ? value === null : false;
    if (!valid) throw new ContractValidationError(path, `expected ${kind}`);
  }
  if (typeof node.pattern === "string" && (typeof value !== "string" || !(new RegExp(node.pattern)).test(value))) throw new ContractValidationError(path, "string does not match pattern");
  if (typeof node.minLength === "number" && typeof value === "string" && [...value].length < node.minLength) throw new ContractValidationError(path, "string is shorter than minLength");
  if (typeof node.maxLength === "number" && typeof value === "string" && [...value].length > node.maxLength) throw new ContractValidationError(path, "string is longer than maxLength");
  if (typeof node.minItems === "number" && Array.isArray(value) && value.length < node.minItems) throw new ContractValidationError(path, "array is shorter than minItems");
  if (isObject(value)) {
    const properties = isObject(node.properties) ? node.properties : {};
    for (const required of (Array.isArray(node.required) ? node.required : [])) if (!(required in value)) throw new ContractValidationError(path, `missing required property ${required}`);
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) validateNode(child, properties[key] as Record<string, unknown>, `${path}.${key}`);
      else if (node.additionalProperties === false) throw new ContractValidationError(path, `unknown property ${key}`);
      else if (isObject(node.additionalProperties)) validateNode(child, node.additionalProperties, `${path}.${key}`);
    }
  }
  if (Array.isArray(value) && isObject(node.items)) value.forEach((item, index) => validateNode(item, node.items as Record<string, unknown>, `${path}[${index}]`));
}

export function validateWire(value: unknown): asserts value is ContractDocument { validateNode(value, CONTRACT_SCHEMA, "$"); }

const asObject = (value: unknown, path: string): Record<string, unknown> => { if (!isObject(value)) throw new ContractValidationError(path, "expected object"); return value; };
const asArray = (value: unknown, path: string): unknown[] => { if (!Array.isArray(value)) throw new ContractValidationError(path, "expected array"); return value; };
const asString = (value: unknown, path: string): string => { if (typeof value !== "string") throw new ContractValidationError(path, "expected string"); return value; };
const unique = (values: string[], path: string) => { const set = new Set(values); if (set.size !== values.length) throw new ContractValidationError(path, "duplicate id"); return set; };
const decimalInteger = (value: string) => /^-?(?:0|[1-9][0-9]*)$/.test(value);
const compareInteger = (a: string, b: string): number | null => { if (!decimalInteger(a) || !decimalInteger(b)) return null; const negA = a.startsWith("-"), negB = b.startsWith("-"); if (negA !== negB) return negA ? -1 : 1; const aa = a.replace(/^-?0+(?=\d)/, "").replace(/^-/, ""), bb = b.replace(/^-?0+(?=\d)/, "").replace(/^-/, ""); const result = aa.length === bb.length ? aa.localeCompare(bb) : aa.length - bb.length; return negA ? -result : result; };

function optionId(option: Record<string, unknown>): string { return asString(option.id, "option.id"); }
function validateOptionValue(spec: Record<string, unknown>, value: unknown, path: string): void {
  const type = asString(spec.type, `${path}.type`);
  if (type === "boolean" && typeof value !== "boolean") throw new ContractValidationError(path, "boolean option requires boolean");
  if ((type === "string" || type === "document") && typeof value !== "string") throw new ContractValidationError(path, "option requires string");
  if (type === "integer") { const text = asString(value, path); if (!decimalInteger(text)) throw new ContractValidationError(path, "integer defaults and values are decimal strings"); const min = typeof spec.minimum === "string" ? compareInteger(text, spec.minimum) : null; const max = typeof spec.maximum === "string" ? compareInteger(text, spec.maximum) : null; if (min !== null && min < 0) throw new ContractValidationError(path, "value below minimum"); if (max !== null && max > 0) throw new ContractValidationError(path, "value above maximum"); }
  if (type === "decimal" && (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value))) throw new ContractValidationError(path, "decimal values are exact strings");
  if (type === "enum") { const selected = asString(value, path); if (!asArray(spec.choices, `${path}.choices`).some((choice) => asObject(choice, path).id === selected)) throw new ContractValidationError(path, "enum value is not an allowed choice"); }
  if (type === "list" && !Array.isArray(value)) throw new ContractValidationError(path, "list value must be an array");
  if ((type === "record" || type === "taggedUnion") && !isObject(value)) throw new ContractValidationError(path, "record value must be an object");
  if ((type === "secret" || type === "resource") && value !== null) throw new ContractValidationError(path, "secret/resource options cannot persist a value");
}

function validateOptions(options: unknown[], path: string, inherited = new Set<string>()): Set<string> {
  const ids = new Set(inherited);
  options.forEach((raw, index) => { const option = asObject(raw, `${path}[${index}]`); const id = optionId(option); if (ids.has(id)) throw new ContractValidationError(`${path}[${index}].id`, "duplicate option id"); ids.add(id); const sensitive = option.sensitive === true; const persistence = option.persistence; if (option.type === "secret" && !sensitive || sensitive && (persistence === "workspace" || persistence === "instance")) throw new ContractValidationError(`${path}[${index}]`, "sensitive options must be session-only or non-persistent"); if ("default" in option) validateOptionValue(option, option.default, `${path}[${index}].default`); if (Array.isArray(option.rules)) option.rules.forEach((rule) => validateCondition(asObject(rule, path).when, ids, path)); if (option.type === "record") validateOptions(asArray(option.fields, path), `${path}[${index}].fields`, ids); if (option.type === "taggedUnion") asArray(option.variants, path).forEach((variant) => validateOptions(asArray(asObject(variant, path).fields, path), `${path}[${index}].variants.fields`, ids)); });
  return ids;
}

function validateCondition(value: unknown, optionIds: Set<string>, path: string): void { const condition = asObject(value, path); const kind = condition.kind; if (kind === "predicate") { const id = asString(condition.optionId, path); if (!optionIds.has(id)) throw new ContractValidationError(path, "condition references unknown option"); } else if (kind === "all" || kind === "any") asArray(condition.conditions, path).forEach((item) => validateCondition(item, optionIds, path)); else if (kind === "not") validateCondition(condition.condition, optionIds, path); else throw new ContractValidationError(path, "unknown condition kind"); }

export function validateManifest(value: unknown): PluginManifest {
  validateWire(value); const manifest = asObject(value, "$"); const tools = asArray(manifest.tools, "$.tools").map((item) => asObject(item, "$.tools")); const operations = asArray(manifest.operations, "$.operations").map((item) => asObject(item, "$.operations")); const workspaces = asArray(manifest.workspaces, "$.workspaces").map((item) => asObject(item, "$.workspaces")); const toolIds = unique(tools.map((item) => asString(item.id, "$.tools.id")), "$.tools"); const operationIds = unique(operations.map((item) => asString(item.id, "$.operations.id")), "$.operations"); const workspaceIds = unique(workspaces.map((item) => asString(item.id, "$.workspaces.id")), "$.workspaces");
  tools.forEach((tool, index) => { if (!workspaceIds.has(asString(tool.workspaceId, `$.tools[${index}].workspaceId`))) throw new ContractValidationError(`$.tools[${index}].workspaceId`, "dangling workspace reference"); asArray(tool.operationIds, "$.tools.operationIds").forEach((id) => { if (!operationIds.has(asString(id, "$.tools.operationIds"))) throw new ContractValidationError("$.tools.operationIds", "dangling operation reference"); }); });
  asArray(manifest.aliases ?? [], "$.aliases").forEach((alias, index) => { const item = asObject(alias, `$.aliases[${index}]`); if (!toolIds.has(asString(item.toolId, pathJoin(index, "toolId")))) throw new ContractValidationError(pathJoin(index, "toolId"), "dangling tool reference"); });
  operations.forEach((operation, index) => { const path = `$.operations[${index}]`; const inputIds = unique(asArray(operation.inputs, path).map((item) => asString(asObject(item, path).id, path)), `${path}.inputs`); unique(asArray(operation.outputs, path).map((item) => asString(asObject(item, path).id, path)), `${path}.outputs`); const optionIds = validateOptions(asArray(operation.options, path), `${path}.options`); const trigger = asObject(operation.trigger, path); asArray(trigger.changedPorts ?? [], path).forEach((id) => { if (!inputIds.has(asString(id, path))) throw new ContractValidationError(path, "trigger references unknown input port"); }); void optionIds; });
  const inputPortIds = new Set(operations.flatMap((operation) => asArray(operation.inputs, "$.operations.inputs").map((port) => asString(asObject(port, "$.operations.inputs").id, "$.operations.inputs.id")))); const outputPortIds = new Set(operations.flatMap((operation) => asArray(operation.outputs, "$.operations.outputs").map((port) => asString(asObject(port, "$.operations.outputs").id, "$.operations.outputs.id")))); const optionIds = new Set(operations.flatMap((operation) => asArray(operation.options, "$.operations.options").map((option) => optionId(asObject(option, "$.operations.options")))));
  workspaces.forEach((workspace, index) => { const path = `$.workspaces[${index}]`; const commands = asArray(workspace.commands, path).map((item) => asObject(item, path)); const commandIds = unique(commands.map((item) => asString(item.id, path)), `${path}.commands`); commands.forEach((command) => { if (command.operationId !== undefined && !operationIds.has(asString(command.operationId, path))) throw new ContractValidationError(path, "command references unknown operation"); }); asArray(workspace.bindings, path).forEach((binding) => { const item = asObject(binding, path); asArray(item.commandIds ?? [], path).forEach((id) => { if (!commandIds.has(asString(id, path))) throw new ContractValidationError(path, "binding references unknown command"); }); asArray(item.optionIds ?? [], path).forEach((id) => { if (!optionIds.has(asString(id, path))) throw new ContractValidationError(path, "binding references unknown option"); }); for (const field of ["inputPort", "selectionSource"] as const) if (item[field] !== undefined && !inputPortIds.has(asString(item[field], path))) throw new ContractValidationError(path, "binding references unknown input port"); if (item.outputPort !== undefined && !outputPortIds.has(asString(item.outputPort, path))) throw new ContractValidationError(path, "binding references unknown output port"); }); });
  validateOptions(asArray(manifest.settings ?? [], "$.settings"), "$.settings"); return value as PluginManifest;
}

function pathJoin(index: number, key: string): string { return `$.aliases[${index}].${key}`; }

export function validateRequest(value: unknown, manifest: PluginManifest): ExecuteRequest {
  validateWire(value); const request = asObject(value, "$"); if (request.pluginId !== manifest.id || request.pluginVersion !== manifest.version) throw new ContractValidationError("$.pluginId", "request does not target this manifest version"); const operation = manifest.operations.find((item) => item.id === request.operationId); if (!operation) throw new ContractValidationError("$.operationId", "unknown operation"); const inputs = asObject(request.inputs, "$.inputs"); const definitions = new Map(operation.inputs.map((port) => [port.id, port])); operation.inputs.filter((port) => port.required).forEach((port) => { if (!(port.id in inputs)) throw new ContractValidationError("$.inputs", `missing required port ${port.id}`); }); for (const [id, binding] of Object.entries(inputs)) { const definition = definitions.get(id); if (!definition) throw new ContractValidationError(`$.inputs.${id}`, "unknown input port"); if (definition.multiplicity === "one" && Array.isArray(binding)) throw new ContractValidationError(`$.inputs.${id}`, "single port received multiple bindings"); }
  for (const [key, binding] of Object.entries(inputs)) { const definition = definitions.get(key)!; const values = Array.isArray(binding) ? binding : [binding]; for (const raw of values) { const kind = asString(asObject(raw, `$.inputs.${key}`).kind, `$.inputs.${key}.kind`); const valid = definition.kind === kind || (definition.kind === "file" && kind === "file") || (definition.kind === "image" && kind === "image"); if (!valid) throw new ContractValidationError(`$.inputs.${key}`, "binding kind does not match declared port"); } }
  const specs = new Map(operation.options.map((option) => [optionId(option as unknown as Record<string, unknown>), option as unknown as Record<string, unknown>])); for (const [key, optionValue] of Object.entries(asObject(request.options, "$.options"))) { const spec = specs.get(key); if (!spec) throw new ContractValidationError(`$.options.${key}`, "unknown option"); validateOptionValue(spec, optionValue, `$.options.${key}`); } return value as ExecuteRequest;
}

export function normalizeV1(value: unknown): PluginManifest { const legacy = asObject(value, "$"); const id = asString(legacy.id, "$.id"); const title = typeof legacy.label === "string" ? legacy.label : typeof legacy.title === "string" ? legacy.title : id; const operations = asArray(legacy.operations, "$.operations").map((raw) => { const operation = asObject(raw, "$.operations[]"); const operationId = asString(operation.id, "$.operations[].id"); return { id: operationId, title: typeof operation.label === "string" ? operation.label : operationId, executor: { kind: "rust", id, version: "v1", cancellation: "cooperative" }, inputs: [{ id: "input", kind: "document", required: true, multiplicity: "one" }], outputs: [{ id: "output", kind: "artifact", multiplicity: "one", representations: ["text"], sensitive: false, exports: ["copyText", "save"] }], options: [], trigger: { modes: ["inputChange"], debounceMs: "200" }, limits: { maxInputBytes: "18446744073709551615", maxOutputBytes: "18446744073709551615", maxChunkBytes: "1048576", deadlineMs: "0" } }; }); const normalized = { kind: "pluginManifest", apiVersion: "devtools.plugin/v2", id, version: "0.1.0", stateVersion: 1, tools: [{ id, title, category: "legacy", operationIds: operations.map((operation) => operation.id), workspaceId: "legacy" }], operations, workspaces: [{ id: "legacy", kind: "transform", bindings: [], commands: [], presentationSettings: [] }], capabilities: [], settings: [], tests: { requirementIds: [], fixtures: [], uiScenarios: [] } }; return validateManifest(normalized);
}
