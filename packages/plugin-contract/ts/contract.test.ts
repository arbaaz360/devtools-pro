import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeV1, validateManifest, validateRequest, validateWire, ContractValidationError } from "./validate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(root, "fixtures", name), "utf8"));
const rejectsContract = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof ContractValidationError || error instanceof Error);

test("representative manifest, selection, linked and preview fixtures validate", () => {
  const manifest = validateManifest(fixture("valid/manifest-comprehensive.json"));
  assert.equal(manifest.id, "examples.contract");
  assert.equal(manifest.tests.requirementIds.length, 27);
  assert.equal(validateRequest(fixture("valid/request-selection.json"), manifest).generation, "7");
  assert.equal(validateRequest(fixture("valid/representative.json"), manifest).generation, "9007199254740993");
  assert.equal(validateManifest(JSON.parse(JSON.stringify(manifest))).id, manifest.id);
  validateWire(fixture("valid/event-preview.json"));
});

test("schema and semantic invalid fixtures fail closed", () => {
  for (const name of ["unknown-version.json", "duplicate-id.json", "dangling-reference.json", "invalid-default.json", "unknown-capability.json"]) rejectsContract(() => validateManifest(fixture(`invalid/${name}`)));
});

test("v1 normalization keeps stable public ids and maps the single input/output", () => {
  const normalized = normalizeV1(fixture("valid/v1-legacy.json"));
  assert.equal(normalized.id, "structured.json");
  assert.equal(normalized.tools[0].id, "structured.json");
  assert.equal(normalized.operations[0].id, "format");
  assert.equal(normalized.operations[0].inputs[0].id, "input");
});

test("wire values use decimal strings for exact large integers", () => {
  const request = fixture("valid/representative.json") as Record<string, unknown>;
  validateWire(request);
  request.generation = 3;
  rejectsContract(() => validateWire(request));
});

test("schema unknown properties are rejected", () => {
  const manifest = fixture("valid/manifest-comprehensive.json") as Record<string, unknown>;
  manifest.unknownField = true;
  rejectsContract(() => validateManifest(manifest));
});
