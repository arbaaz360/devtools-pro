import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PluginManifest } from "../../../../packages/plugin-contract/ts/generated.ts";
import { autoOnInput, autoOnOption, conditionHolds, defaultOptions, describePackage, engineRunnable, groupFor, GROUP_ORDER, inputContentKind, optionPresentation, prepareOptions } from "./describe.ts";
import { bundledTools, definitionFromManifest } from "../workbench/tools.ts";
import { readdirSync } from "node:fs";

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
  assert.equal(tool.manifest.group, "CONVERT");
  assert.equal(tool.manifest.limits.maxInputBytes, 1048576);
  assert.equal(tool.manifest.limits.maxOutputBytes, 2097152);
  assert.deepEqual(tool.manifest.operations.map((operation) => operation.id), ["text.case"]);
  assert.deepEqual(tool.manifest.operations[0]!.defaultOptions, {
    target: "camel",
    acronyms: "ID,API,DB,URL,HTTP",
    "preserve-acronyms": true,
  });
  assert.equal(tool.manifest.operations[0]!.options?.length, 3);
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
  const operation = load("uuid").operations.find((candidate) => candidate.inputs.length === 1);
  assert.ok(operation);
  const input = operation.inputs[0]!;
  assert.equal(engineRunnable({ ...operation, inputs: [] }), true);
  assert.equal(engineRunnable({ ...operation, inputs: [input, { ...input, id: "second" }] }), false);
  assert.equal(engineRunnable({ ...operation, executor: { ...operation.executor, kind: "rust" } }), false);
});

test("annotations are lifted out of a result value, validated and capped", async () => {
  const { splitAnnotations, MAX_ANNOTATIONS } = await import("./describe.ts");
  const { properties, annotations } = splitAnnotations({ count: 2, annotations: [{ start: 0, end: 3, kind: "match", label: "#1" }, { start: 5, end: 2 }, { start: "x", end: 2 }, null, { start: 4, end: 6 }] });
  assert.deepEqual(properties, { count: 2 });
  assert.deepEqual(annotations, [{ start: 0, end: 3, kind: "match", label: "#1" }, { start: 4, end: 6, kind: "match", label: undefined }]);
  assert.deepEqual(splitAnnotations("text"), { properties: "text", annotations: [] });
  assert.deepEqual(splitAnnotations({ a: 1 }), { properties: { a: 1 }, annotations: [] });
  const many = splitAnnotations({ annotations: Array.from({ length: MAX_ANNOTATIONS + 5 }, (_, i) => ({ start: i, end: i + 1 })) });
  assert.equal(many.annotations.length, MAX_ANNOTATIONS);
});

test("the renderer follows the port's mime and representations", async () => {
  const { rendererFor } = await import("./describe.ts");
  const port = (mime: string[], representations: string[]) => ({ id: "output", kind: "artifact" as const, multiplicity: "one" as const, mime, representations: representations as never, sensitive: false, exports: [] });
  assert.equal(rendererFor(port(["text/html"], ["previewDocument", "code"]), true, undefined), "preview");
  assert.equal(rendererFor(port(["text/html"], ["code"]), true, undefined), "text");
  assert.equal(rendererFor(port(["image/svg+xml"], ["image", "code"]), true, undefined), "svg");
  assert.equal(rendererFor(port(["application/json"], ["text"]), true, undefined), "json");
  assert.equal(rendererFor(port([], ["properties"]), false, { a: 1 }), "json");
  assert.equal(rendererFor(port(["text/plain"], ["text"]), true, {}), "text");
});


test("each operation keeps its own options: a sibling's controls are not offered", () => {
  const [js] = describePackage(load("js"), "js");
  const beautify = js!.manifest.operations.find((operation) => operation.id === "beautify");
  const minify = js!.manifest.operations.find((operation) => operation.id === "minify");
  const ids = (operation: typeof beautify) => (operation?.options ?? []).map((option) => option.id).sort();
  assert.deepEqual(ids(minify), ["preserve-comments"]);
  assert.ok(!ids(beautify).includes("preserve-comments"));
  assert.ok(ids(beautify).includes("brace-style"));

  // The YAML tool's two operations declare the same option id with different
  // choices; offering the wrong list is what made a chosen value fail at run time.
  const [yaml] = describePackage(load("yaml"), "yaml");
  const choices = (id: string) =>
    (yaml!.manifest.operations.find((operation) => operation.id === id)?.options ?? [])
      .find((option) => option.id === "indent")?.choices?.map((choice) => choice.id);
  assert.deepEqual(choices("convert.yaml-json"), ["space2", "space4", "minified"]);
  assert.deepEqual(choices("convert.json-yaml"), ["space2", "space4"]);
});

test("trigger modes decide whether the shell may run an operation on its own", () => {
  const [css] = describePackage(load("css"), "css");
  for (const operation of css!.manifest.operations) {
    assert.equal(operation.autoOnInput, false, `${operation.id} declares explicit-only execution`);
    assert.equal(operation.autoOnOption, false);
  }
  assert.equal(css!.manifest.auto, false);

  const [stringCase] = describePackage(load("string-case"), "string-case");
  assert.equal(stringCase!.manifest.operations[0]!.autoOnInput, true);
  assert.equal(stringCase!.manifest.auto, true);

  // A generator has no document to change; its options are its input, so an
  // option change may run it while a plain document tool waits for the button.
  const [examples] = describePackage(load("example-strings"), "example-strings");
  const generate = examples!.operations[0]!;
  assert.equal(autoOnInput(generate), false);
  assert.equal(autoOnOption(generate), true);
  assert.equal(examples!.manifest.auto, true);
});

test("a port declaring image content makes the tool take bytes, not text", () => {
  const [qr] = describePackage(load("qr"), "qr");
  const encode = qr!.operations[0]!;
  assert.equal(inputContentKind(encode.inputs[0]), "text", "the QR generator reads the text to encode");
  assert.deepEqual(qr!.manifest.inputKinds, ["text"]);

  // The same manifest with an image input describes a tool the shell feeds pixels.
  const manifest = JSON.parse(JSON.stringify(load("qr")));
  manifest.operations[0].inputs[0].contentKinds = ["image"];
  manifest.operations[0].inputs[0].mime = ["image/png"];
  const [reader] = describePackage(manifest, "qr");
  assert.equal(inputContentKind(reader!.operations[0]!.inputs[0]), "image");
  assert.deepEqual(reader!.manifest.inputKinds, ["bytes"]);
});

test("an image tool is decided by its input port, never by its name", () => {
  // QR Code Reader has no "image" in its id or title; its port declares image content.
  const [reader] = describePackage(load("qr-reader"), "qr-reader");
  assert.equal(reader!.manifest.inputContent, "image");
  assert.equal(definitionFromManifest(reader!.manifest).input, "image");
  // A text tool whose title says "image" is still a text tool.
  const [qr] = describePackage(load("qr"), "qr");
  assert.equal(qr!.manifest.inputContent, undefined);
  assert.equal(definitionFromManifest({ ...qr!.manifest, label: "Image Maker" }).input, "text");
});

test("groups follow the fixed order, and legacy categories still land in one of them", () => {
  assert.deepEqual(GROUP_ORDER, ["WORKSPACE", "FORMAT", "CONVERT", "ENCODE", "TEXT", "WEB & SECURITY", "GENERATE"]);
  const expected: Record<string, string> = {
    format: "FORMAT", convert: "CONVERT", encode: "ENCODE", text: "TEXT", web: "WEB & SECURITY", security: "WEB & SECURITY", generate: "GENERATE",
    converter: "CONVERT", encoding: "ENCODE", structured: "FORMAT", compare: "TEXT", generator: "GENERATE", identity: "GENERATE",
    media: "GENERATE", time: "CONVERT", number: "CONVERT", viewer: "FORMAT",
  };
  for (const [category, group] of Object.entries(expected)) assert.equal(groupFor(category), group, category);
  for (const dir of readdirSync(new URL("../../../../plugins/", import.meta.url)))
    for (const tool of describePackage(load(dir), dir)) assert.ok(GROUP_ORDER.includes(tool.manifest.group!), `${tool.id} is in ${tool.manifest.group}`);
  for (const tool of bundledTools) assert.ok(GROUP_ORDER.includes(tool.group), `${tool.id} is in ${tool.group}`);
});

test("every tool has its own glyph and a description", () => {
  const tools = [
    ...bundledTools,
    ...readdirSync(new URL("../../../../plugins/", import.meta.url))
      .flatMap((dir) => describePackage(load(dir), dir))
      .filter((tool) => !bundledTools.some((native) => native.id === tool.id))
      .map((tool) => definitionFromManifest(tool.manifest)),
  ];
  const glyphs = tools.map((tool) => tool.icon);
  assert.equal(new Set(glyphs).size, glyphs.length, `duplicate glyphs: ${glyphs.join(" ")}`);
  for (const tool of tools) {
    assert.ok(tool.icon && tool.icon !== "◇" && [...tool.icon].length <= 3, `${tool.id} glyph ${tool.icon}`);
    assert.ok(tool.description.trim(), `${tool.id} has no description`);
  }
});

test("a tool's description falls back to its package's", () => {
  const manifest = load("jsx");
  const [own] = describePackage(manifest, "jsx");
  assert.equal(own!.manifest.description, manifest.tools[0]!.description ?? manifest.description);
  const bare = JSON.parse(JSON.stringify(manifest));
  delete bare.tools[0].description;
  bare.description = "Package description";
  assert.equal(describePackage(bare, "jsx")[0]!.manifest.description, "Package description");
});

test("option rules hide what the current values make irrelevant", () => {
  const generate = load("uuid").operations.find((operation) => operation.id === "identity.uuid.generate")!;
  const namespace = generate.options.find((option) => option.id === "namespace")!;
  // Defaults fill in what the tab has not set: v4 needs no namespace.
  assert.deepEqual(optionPresentation(namespace, generate.options, {}), { visible: false, enabled: true });
  assert.equal(optionPresentation(namespace, generate.options, { version: "v5" }).visible, true);
  assert.equal(optionPresentation(namespace, generate.options, { version: "v1" }).visible, false);
  const count = generate.options.find((option) => option.id === "count")!;
  assert.deepEqual(optionPresentation(count, generate.options, {}), { visible: true, enabled: true });

  const html = load("escaping").operations.find((operation) => operation.id === "text.html")!;
  const shown = (mode: string) => html.options.filter((option) => optionPresentation(option, html.options, { mode }).visible).map((option) => option.id);
  assert.notDeepEqual(shown("escape"), shown("unescape"));
  assert.ok(shown("escape").includes("mode") && shown("unescape").includes("mode"));

  // enabled disables without hiding; required is not the form's to enforce.
  const option = { ...count, rules: [{ effect: "enabled" as const, when: { kind: "predicate" as const, optionId: "case", operator: "equals" as const, value: "upper" } }, { effect: "required" as const, when: { kind: "predicate" as const, optionId: "case", operator: "equals" as const, value: "nope" } }] };
  assert.deepEqual(optionPresentation(option, generate.options, {}), { visible: true, enabled: false });
  assert.deepEqual(optionPresentation(option, generate.options, { case: "upper" }), { visible: true, enabled: true });
});

test("conditions: predicates compare as a form reads values, and combinators nest", () => {
  const values = { mode: "encode", count: 2, on: true, empty: "" };
  const is = (optionId: string, operator: "equals" | "notEquals" | "in" | "isSet", value?: unknown) => ({ kind: "predicate" as const, optionId, operator, value });
  assert.equal(conditionHolds(is("mode", "equals", "encode"), values), true);
  assert.equal(conditionHolds(is("count", "equals", "2"), values), true);
  assert.equal(conditionHolds(is("on", "equals", true), values), true);
  assert.equal(conditionHolds(is("mode", "notEquals", "decode"), values), true);
  assert.equal(conditionHolds(is("mode", "in", ["decode", "encode"]), values), true);
  assert.equal(conditionHolds(is("mode", "in", "encode"), values), false);
  assert.equal(conditionHolds(is("empty", "isSet"), values), false);
  assert.equal(conditionHolds(is("missing", "isSet"), values), false);
  assert.equal(conditionHolds({ kind: "all", conditions: [is("mode", "equals", "encode"), is("on", "equals", true)] }, values), true);
  assert.equal(conditionHolds({ kind: "any", conditions: [is("mode", "equals", "x"), is("on", "equals", false)] }, values), false);
  assert.equal(conditionHolds({ kind: "not", condition: is("mode", "equals", "x") }, values), true);
});

test("an operation with no document input says it does not read the document", () => {
  const [tool] = describePackage(load("uuid"), "uuid");
  assert.ok(tool);
  const reads = Object.fromEntries(tool.manifest.operations.map((operation) => [operation.id, operation.readsDocument]));
  assert.deepEqual(reads, { "identity.uuid.generate": false, "identity.uuid.decode": true });
});
