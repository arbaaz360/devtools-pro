import test from "node:test";
import assert from "node:assert/strict";
import { discoverPlugins, DiscoveryDiagnostic } from "./discovery.ts";
import { resolve } from "node:path";

const repositoryPlugins = resolve(process.cwd(), "..", "..", "plugins");

test("trusted bundled example is discovered deterministically", async () => { const packages = await discoverPlugins(repositoryPlugins); assert.deepEqual(packages.map((item) => item.manifest.id), ["examples.echo"]); assert.equal(packages[0]!.descriptor.apiVersion, "devtools.plugin/v2"); });
test("missing trusted root has a clear diagnostic", async () => { await assert.rejects(() => discoverPlugins(resolve(process.cwd(), "..", "..", "does-not-exist")), (error: unknown) => error instanceof DiscoveryDiagnostic && error.code === "missing-root"); });
