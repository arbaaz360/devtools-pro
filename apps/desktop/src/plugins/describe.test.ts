import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PluginManifest } from "../../../../packages/plugin-contract/ts/generated.ts";
import { defaultOptions, describePackage, engineRunnable, prepareOptions } from "./describe.ts";

const load = (dir: string): PluginManifest =>
  JSON.parse(readFileSync(new URL(`../../../../plugins/${dir}/manifest.json`, import.meta.url), "utf8")) as PluginManifest;

test("a package manifest becomes a shell tool with its options, group and limits", () => {
  const [tool] = describePackage(load("string-case"), "string-case");
  assert.ok(tool);
  assert.equal(tool.id, "text.case");
  assert.equal(tool.pluginId, "text.case");
  assert.equal(tool.packageDir, "string-case");
  assert.equal(tool.manifest.label, "String Case Converter");
  assert.equal(tool.manifest.engine, "worker");
  assert.equal(tool.manifest.group, "TEXT & ENCODING");
  assert.equal(tool.manifest.limits.maxInputBytes, 1048576);
  assert.equal(tool.manifest.limits.maxOutputBytes, 2097152);
  assert.deepEqual(tool.manifest.operations.map((operation) => operation.id), ["text.case"]);
  assert.deepEqual(tool.manifest.operations[0]!.defaultOptions, {
    target: "camel",
    acronyms: "ID,API,DB,URL,HTTP",
    "preserve-acronyms": true,
  });
  assert.equal(tool.manifest.optionSchema?.length, 3);
  assert.equal(tool.manifest.emptyInput, false);
});

test("one package can declare several tools; each carries only its own operations", () => {
  const tools = describePackage(load("escaping"), "escaping");
  assert.deepEqual(tools.map((tool) => tool.id), ["text.html", "text.json-string", "text.backslash"]);
  for (const tool of tools) assert.deepEqual(tool.operations.map((operation) => operation.id), [tool.id]);
});

test("sample packages and multi-document operations are left out", () => {
  assert.deepEqual(describePackage(load("examples"), "examples"), []);
  assert.deepEqual(describePackage(load("diff"), "diff"), []);
});

test("numeric option defaults are numbers and run options are filtered to the declared ids", () => {
  const [parser] = describePackage(load("url"), "url").filter((tool) => tool.id === "web.url-parser");
  assert.ok(parser);
  const operation = parser.operations[0]!;
  assert.deepEqual(defaultOptions(operation), { indent: 2 });
  assert.deepEqual(prepareOptions(operation, { indent: 4, target: "snake" }), { indent: 4 });
  assert.deepEqual(prepareOptions(operation, {}), { indent: 2 });
});

test("an operation with no document input is still engine-runnable; two inputs are not", () => {
  const manifest = load("uuid");
  const generate = manifest.operations[0]!;
  assert.equal(engineRunnable({ ...generate, inputs: [] }), true);
  assert.equal(engineRunnable({ ...generate, inputs: [...generate.inputs, { ...generate.inputs[0]!, id: "second" }] }), false);
  assert.equal(engineRunnable({ ...generate, executor: { ...generate.executor, kind: "rust" } }), false);
});
