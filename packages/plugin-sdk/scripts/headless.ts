import { discoverPlugins } from "../src/discovery.ts";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../src/context.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const root = resolve(args[0] ?? "plugins");
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flags = (name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[++index]!);
  return values;
};
const pluginId = flag("--plugin");
const operationId = flag("--operation");
const optionsText = flag("--options");
const packages = await discoverPlugins(root);
if (packages.length === 0) throw new Error(`no trusted plugins found under ${root}`);
const plugin = (pluginId ? packages.find((item) => item.manifest.id === pluginId) : packages[0]);
if (!plugin) throw new Error(`plugin ${pluginId} was not discovered under ${root}`);
const operation = plugin.manifest.operations.find((item) => item.id === operationId) ?? plugin.manifest.operations[0]!;
const tool = plugin.manifest.tools.find((item) => item.operationIds.includes(operation.id));
if (!tool) throw new Error(`operation ${operation.id} is not attached to a tool in ${plugin.manifest.id}`);
const options = optionsText ? JSON.parse(optionsText) as Record<string, unknown> : {};
const reader = new MemoryReader();
const inputPorts = operation.inputs.map((input) => input.id);
const inputValues = flags("--input");
const supplied = new Map<string, string>();
for (const value of inputValues) {
  const separator = value.indexOf("=");
  const namedPort = separator > 0 ? value.slice(0, separator) : "";
  if (namedPort && inputPorts.includes(namedPort)) supplied.set(namedPort, value.slice(separator + 1));
  else {
    const nextPort = inputPorts.find((port) => !supplied.has(port));
    if (!nextPort) throw new Error(`too many --input values; expected ${inputPorts.join(", ")}`);
    supplied.set(nextPort, value);
  }
}
for (const [port, value] of supplied) reader.insert(port, value);
const outputs = new MemoryOutputSink();
const cancellation = new CancellationToken();
const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
const processor = await import(pathToFileURL(plugin.processorPath).href) as { execute?: (request: { pluginId: string; toolId: string; operationId: string; options: Record<string, unknown> }, context: ProcessorContext) => unknown };
if (typeof processor.execute !== "function") throw new Error(`processor for ${plugin.manifest.id} does not export execute`);
await processor.execute({ pluginId: plugin.manifest.id, toolId: tool.id, operationId: operation.id, options }, context);
console.log(JSON.stringify({ discovered: packages.map((item) => item.manifest.id), executed: `${plugin.manifest.id}/${operation.id}`, inputPorts: [...supplied.keys()], outputs: [...outputs.artifacts.values()], values: [...outputs.values.entries()] }));
