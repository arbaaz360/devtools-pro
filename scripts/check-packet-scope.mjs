#!/usr/bin/env node
// Fails a pull request whose changed files fall outside the "Allowed files"
// of the packet its body declares (`Packet: docs/packets/<ID>-<slug>.md`).
//
//   PR_BODY='...' HEAD_REF=antigravity/AG-101-x BASE_SHA=<sha> HEAD_SHA=<sha> node scripts/check-packet-scope.mjs
//
// Worker branches (antigravity/*, claude/*, worker/*) must declare a packet.
// Other branches without a declaration are integrator work and pass with a note.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const body = process.env.PR_BODY ?? "";
const headRef = process.env.HEAD_REF ?? "";
const baseSha = process.env.BASE_SHA ?? "origin/main";
const headSha = process.env.HEAD_SHA ?? "HEAD";

const declared = /^\s*Packet:\s*(docs\/packets\/[A-Za-z0-9._-]+\.md)\s*$/m.exec(body);
const workerBranch = /^(antigravity|claude|worker)\//.test(headRef);

if (!declared) {
  if (workerBranch) {
    console.error(`packet-scope: branch ${headRef} is a worker branch but the PR body has no "Packet: docs/packets/<file>" line.`);
    process.exit(1);
  }
  console.log("packet-scope: no packet declared; integrator branch, scope check skipped.");
  process.exit(0);
}

const packetPath = declared[1];
if (!existsSync(packetPath)) {
  console.error(`packet-scope: declared packet ${packetPath} does not exist on this branch.`);
  process.exit(1);
}

export function allowedGlobs(markdown) {
  const section = /^## Allowed files\s*$([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(markdown);
  if (!section) return [];
  const fence = /```[a-z]*\s*\n([\s\S]*?)```/.exec(section[1]);
  if (!fence) return [];
  return fence[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

export function globToRegExp(glob) {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        source += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

const globs = allowedGlobs(readFileSync(packetPath, "utf8"));
if (!globs.length) {
  console.error(`packet-scope: ${packetPath} has no fenced list under "## Allowed files".`);
  process.exit(1);
}
const patterns = globs.map(globToRegExp);
const changed = execFileSync("git", ["diff", "--name-only", `${baseSha}...${headSha}`], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const outside = changed.filter((file) => !patterns.some((pattern) => pattern.test(file)));

console.log(`packet-scope: ${packetPath} allows ${globs.join(", ")}; ${changed.length} changed file(s).`);
if (outside.length) {
  console.error("packet-scope: files outside the packet's allowed set:");
  for (const file of outside) console.error(`  ${file}`);
  console.error("Move the change into the packet's scope or ask the integrator with a [QUESTION] comment.");
  process.exit(1);
}
console.log("packet-scope: all changed files are within scope.");
