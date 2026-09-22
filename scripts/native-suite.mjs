#!/usr/bin/env node
// The native suite: drives the real desktop executable over WebView2's debugging port
// and checks what only the shipped window can answer — the Tauri host, the WebView2
// CSP, the worker bundle and the shell's own wiring, together.
//
// Playwright's rendered suite runs the same shell in Chromium against a mocked host;
// the package suites run the processors headlessly. This is the layer where a manifest
// meets the UI, which is where the defects fixed in #82 lived.
//
//   node scripts/native-suite.mjs               every check
//   node scripts/native-suite.mjs --smoke       the startup subset (fast)
//   node scripts/native-suite.mjs --only TL-    the checks whose id matches
//   node scripts/native-suite.mjs --json out.json
//
// Ids match docs/MANUAL_TEST_PLAN.md, so a failure names the case a human would
// otherwise have run by hand.

import { writeFileSync } from "node:fs";
import process from "node:process";
import { startApp, artifacts, sleep } from "./native/harness.mjs";
import { driver as makeDriver } from "./native/driver.mjs";
import { checks } from "./native/checks.mjs";
import { resolve } from "node:path";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const smokeOnly = process.argv.includes("--smoke");
const only = argument("--only");
const jsonPath = argument("--json") ?? resolve(artifacts, "native-suite.json");

if (process.platform !== "win32") {
  console.log("native suite: skipped, the desktop host is verified on Windows only.");
  process.exit(0);
}

const selected = checks.filter((check) => (smokeOnly ? check.smoke : true) && (!only || new RegExp(only, "i").test(check.id)));
if (!selected.length) {
  console.error(`no checks match ${only ?? "(none)"}`);
  process.exit(2);
}

const started = Date.now();
let app;
try {
  app = await startApp();
} catch (error) {
  console.error(`native suite failed to start: ${error.message}`);
  process.exit(1);
}

const results = [];
const state = { tools: [] };
const context = { page: app.page, driver: makeDriver(app.page), errors: app.errors, dialogs: app.dialogs, state };

// The catalog has to be listed before the checks that walk it.
await sleep(600);

for (const check of selected) {
  const at = Date.now();
  let outcome;
  try {
    outcome = (await check.run(context)) ?? { status: "pass", note: "" };
  } catch (error) {
    outcome = { status: "fail", note: `threw: ${String(error.message).split("\n")[0]}` };
  }
  const elapsedMs = Date.now() - at;
  results.push({ id: check.id, ...outcome, elapsedMs });
  console.log(`${(outcome.status === "pass" ? "PASS" : "FAIL").padEnd(5)} ${check.id.padEnd(17)} ${String(outcome.note ?? "").slice(0, 140)}`);
}

await app.close();

const failures = results.filter((result) => result.status !== "pass");
const seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), seconds, results }, null, 1));

if (failures.length) {
  console.error(`\nnative suite failed in ${seconds} s: ${failures.length} of ${results.length} checks (${failures.map((failure) => failure.id).join(", ")}). Detail in ${jsonPath}`);
  process.exit(1);
}
console.log(`\nnative suite passed in ${seconds} s: ${results.length} checks against the real window, no webview errors.`);
