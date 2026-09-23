#!/usr/bin/env node
// The manual test plan marks a case "(suite)" when the native suite checks it for a
// person. This keeps that mark honest: every case it is on must have a native check
// with that id, and every native check must name a case in the plan.
//
// The independent review of 5866a49 found 31 of 85 "(suite)" marks with no check
// behind them — a plan that claimed automation it did not have, so a tester skipped
// cases nothing ran. Two ids per row are recognised:
//   | DOC-17 (suite) ...              the row's own id
//   | 04 (suite) ...                  under "### TL-UUID — ...", meaning TL-UUID-04

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plan = readFileSync(resolve(root, "docs", "MANUAL_TEST_PLAN.md"), "utf8").split(/\r?\n/);
const source = readFileSync(resolve(root, "scripts", "native", "checks.mjs"), "utf8");

/** Checks that are about the run itself rather than a case a person would perform. */
const META = new Set(["PAGE-ERRORS"]);

const checks = new Set([...source.matchAll(/^\s*id: "([A-Za-z0-9-]+)",/gm)].map((match) => match[1]));
const planIds = new Set();
/** An id on two rows: a check names one case and a person reading its result finds two. */
const duplicates = new Set();
const claimed = [];
let section = null;
for (const line of plan) {
  const heading = /^### (TL-[A-Z0-9]+) /.exec(line);
  if (heading) { section = heading[1]; continue; }
  if (/^## /.test(line)) section = null;
  const own = /^\| ([A-Z0-9]+-[0-9]+[a-z]?)( \(suite\))?/.exec(line);
  if (own) {
    if (planIds.has(own[1])) duplicates.add(own[1]);
    planIds.add(own[1]);
    if (own[2]) claimed.push(own[1]);
    continue;
  }
  const relative = /^\| ([0-9]+[a-z]?)( \(suite\))?[^|]*\|/.exec(line);
  if (relative && section) {
    const id = `${section}-${relative[1]}`;
    if (planIds.has(id)) duplicates.add(id);
    planIds.add(id);
    if (relative[2]) claimed.push(id);
  }
}

const unbacked = claimed.filter((id) => !checks.has(id));
const unplanned = [...checks].filter((id) => !planIds.has(id) && !META.has(id));
// The reverse drift: a case the suite does check, left unmarked, sends a person to
// repeat it by hand and hides what the suite covers.
const unmarked = [...checks].filter((id) => planIds.has(id) && !claimed.includes(id));
if (unbacked.length || unplanned.length || unmarked.length || duplicates.size) {
  if (duplicates.size) console.error(`${duplicates.size} id(s) name more than one case in the plan: ${[...duplicates].join(", ")}`);
  if (unbacked.length) console.error(`The plan marks ${unbacked.length} case(s) "(suite)" with no native check of that id: ${unbacked.join(", ")}`);
  if (unplanned.length) console.error(`${unplanned.length} native check(s) name no case in the plan: ${unplanned.join(", ")}`);
  if (unmarked.length) console.error(`${unmarked.length} case(s) have a native check but are not marked "(suite)": ${unmarked.join(", ")}`);
  process.exit(1);
}
console.log(`plan coverage: ${claimed.length} "(suite)" cases, each with its native check; ${checks.size} checks, each in the plan.`);
