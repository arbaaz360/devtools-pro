import { discoverPlugins } from "../src/discovery.ts";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../src/context.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? "plugins");
const packages = await discoverPlugins(root);
if (packages.length === 0) throw new Error(`no trusted plugins found under ${root}`);
const plugin = packages[0]!;
const operation = plugin.manifest.operations[0]!;
const reader = new MemoryReader().insert("input", "headless example");
const outputs = new MemoryOutputSink();
const cancellation = new CancellationToken();
const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
const processor = await import(pathToFileURL(plugin.processorPath).href) as { execute?: (request: { pluginId: string; operationId: string }, context: ProcessorContext) => unknown };
if (typeof processor.execute !== "function") throw new Error(`processor for ${plugin.manifest.id} does not export execute`);
await processor.execute({ pluginId: plugin.manifest.id, operationId: operation.id }, context);
console.log(JSON.stringify({ discovered: packages.map((item) => item.manifest.id), executed: `${plugin.manifest.id}/${operation.id}`, outputs: [...outputs.artifacts.values()] }));
