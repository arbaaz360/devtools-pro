#!/usr/bin/env node
// The release smoke: what only a release build has, checked in a release window.
//
// The native suite drives a debug build, which loads its bundle from a dev server with
// no CSP and exposes test hooks. The shipped app serves an embedded bundle over the
// custom protocol with the CSP from tauri.conf.json. A regression in that — a loosened
// CSP, a preview frame given permissions, test hooks compiled into a release — would
// pass every debug check. (Finding AST-021 of the independent review.)
//
// Build first, with the only difference from the installer being the debugging port:
//   pnpm --dir apps/desktop build
//   cargo build -p devtools-desktop --release --features custom-protocol,smoke-hooks
//   node scripts/release-smoke.mjs
//
// A loopback server stands in for "the network": it answers with a marker and records
// every request, so "nothing left the page" is observed from outside the app.

import http from "node:http";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { startApp, artifacts, sleep } from "./native/harness.mjs";
import { driver as makeDriver } from "./native/driver.mjs";

if (process.platform !== "win32") {
  console.log("release smoke: skipped, the desktop host is verified on Windows only.");
  process.exit(0);
}

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  response.end("release-smoke-marker");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const reached = (path) => requests.some((url) => url.startsWith(path));
const verdict = (ok, note) => ({ status: ok ? "pass" : "fail", note });

const checks = [
  {
    // The window is the shipped kind: embedded bundle, custom protocol, no test hooks.
    id: "REL-01",
    async run({ page, app }) {
      const origin = new URL(page.url()).origin;
      const flags = await page.evaluate(() => ({
        hooks: typeof globalThis.devtoolsTest,
        injected: typeof globalThis.__DEVTOOLS_TEST_HOOKS__,
      }));
      return verdict(origin === "http://tauri.localhost" && !app.hooks && flags.hooks === "undefined" && flags.injected === "undefined",
        `origin ${origin}; devtoolsTest ${flags.hooks}; __DEVTOOLS_TEST_HOOKS__ ${flags.injected}`);
    },
  },
  {
    // The CSP binds the page: connect-src allows only the IPC, so a fetch to the network
    // is refused before it is sent.
    id: "REL-02",
    async run({ page }) {
      const outcome = await page.evaluate(async (url) => {
        try { return `answered: ${await (await fetch(`${url}/page`)).text()}`; } catch (error) { return `refused: ${error.name}`; }
      }, endpoint);
      await sleep(300);
      return verdict(outcome.startsWith("refused") && !reached("/page"), `page fetch ${outcome}; the server saw ${JSON.stringify(requests)}`);
    },
  },
  {
    // The preview frame has every sandbox permission withheld: a document's image and
    // script reach nothing. Its heading still renders, so the frame did load.
    id: "REL-03",
    async run({ driver, page }) {
      const html = `<h1>Release sandbox</h1><img src="${endpoint}/image"><script>fetch("${endpoint}/script")</script>`;
      const result = await driver.tool("Markdown & HTML Preview", { text: html, operation: "Preview HTML" });
      const frame = page.locator("#result-media iframe");
      const sandbox = await frame.getAttribute("sandbox").catch(() => null);
      const heading = await driver.until(async () => {
        const handle = await frame.elementHandle().catch(() => null);
        const content = handle ? await handle.contentFrame() : null;
        return content ? (await content.locator("h1").innerText().catch(() => null)) : null;
      }, { timeout: 8000 });
      // Nothing should arrive, so there is no event to wait for: give the frame time to try.
      await sleep(1500);
      return verdict(result.mediaTag === "IFRAME" && sandbox === "" && heading === "Release sandbox" && !reached("/image") && !reached("/script"),
        `frame sandbox="${sandbox}", heading ${JSON.stringify(heading)}; the server saw ${JSON.stringify(requests)}`);
    },
  },
  {
    // A tool runs end to end from the embedded bundle. JSON.parse is the oracle.
    id: "REL-04",
    async run({ driver }) {
      const source = { name: "release", items: [1, 2, 3], nested: { ok: true } };
      const result = await driver.tool("JSON", { text: JSON.stringify(source), operation: "Format" });
      let parsed = null;
      try { parsed = JSON.parse(result.output); } catch { /* reported below */ }
      return verdict(JSON.stringify(parsed) === JSON.stringify(source) && result.output.includes("\n"),
        `formatted ${result.output.length} characters; they parse back to the input: ${JSON.stringify(parsed) === JSON.stringify(source)}`);
    },
  },
];

const started = Date.now();
let app;
try {
  app = await startApp({ release: true });
} catch (error) {
  server.close();
  console.error(`release smoke failed to start: ${error.message}`);
  process.exit(1);
}
const context = { page: app.page, driver: makeDriver(app.page), app };
const results = [];
for (const check of checks) {
  let outcome;
  try { outcome = await check.run(context); } catch (error) { outcome = { status: "fail", note: `threw: ${String(error.message).split("\n")[0]}` }; }
  results.push({ id: check.id, ...outcome });
  console.log(`${(outcome.status === "pass" ? "PASS" : "FAIL").padEnd(5)} ${check.id.padEnd(7)} ${String(outcome.note).slice(0, 170)}`);
}
await app.close();
server.close();

const failures = results.filter((result) => result.status !== "pass");
const seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(resolve(artifacts, "release-smoke.json"), JSON.stringify({ at: new Date().toISOString(), seconds, results }, null, 1));
if (failures.length) {
  console.error(`\nrelease smoke failed in ${seconds} s: ${failures.map((failure) => failure.id).join(", ")}`);
  process.exit(1);
}
console.log(`\nrelease smoke passed in ${seconds} s: ${results.length} checks against a release window.`);
