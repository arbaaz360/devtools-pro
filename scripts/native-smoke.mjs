#!/usr/bin/env node
// Native smoke: launch the real desktop executable, drive it over WebView2's
// debugging port, and prove the two engines work in the shipped window: a Rust
// tool (JSON format) and a package tool on the worker engine (String Case
// Converter). Playwright's rendered suite runs the same shell in Chromium with
// a mocked host; this is the only check that exercises the Tauri host, the
// WebView2 CSP and the worker bundle together.
//
// Run from the repository root:  node scripts/native-smoke.mjs
//
// A debug build of the desktop crate loads build.devUrl (127.0.0.1:1420), not
// the embedded bundle, so this script serves the built dist there with
// `vite preview` for the duration of the check.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = resolve(root, "apps", "desktop");
// Playwright is a desktop dev dependency; resolve it from there whatever the cwd.
const { chromium } = createRequire(resolve(desktop, "package.json"))("@playwright/test");
const exe = resolve(root, "target", process.env.SMOKE_PROFILE ?? "debug", process.platform === "win32" ? "devtools-desktop.exe" : "devtools-desktop");
const port = Number(process.env.SMOKE_CDP_PORT ?? 9333);
const previewPort = 1420;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const started = Date.now();
const children = [];
const stop = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};
process.on("exit", () => children.forEach(stop));

function fail(message) {
  console.error(`native smoke failed: ${message}`);
  process.exit(1);
}

if (process.platform !== "win32") {
  console.log("native smoke: skipped, the desktop host is verified on Windows only.");
  process.exit(0);
}
if (!existsSync(exe)) fail(`${exe} is missing; run cargo build -p devtools-desktop first`);
if (!existsSync(resolve(desktop, "dist", "index.html"))) fail("apps/desktop/dist is missing; run the desktop build first");

// 1. Serve the built bundle where the debug executable expects the dev server.
const preview = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], { cwd: desktop, stdio: "ignore", shell: process.platform === "win32" });
children.push(preview);
let served = false;
for (let attempt = 0; attempt < 60 && !served; attempt += 1) {
  await sleep(500);
  try { served = (await fetch(`http://127.0.0.1:${previewPort}/`)).ok; } catch { /* not yet */ }
}
if (!served) fail(`vite preview did not answer on ${previewPort}`);

// 2. Launch the executable with WebView2's debugging port open. A CI runner has no
// usable GPU and runs the process under a service-like session; WebView2's browser
// process then stalls at start-up unless told to skip the GPU and sandbox. The log
// file is printed if the port never answers.
const browserLog = resolve(desktop, "test-results", "webview2-smoke.log");
mkdirSync(resolve(desktop, "test-results"), { recursive: true });
const ciArguments = process.env.CI ? ` --disable-gpu --disable-gpu-compositing --no-sandbox --enable-logging --v=0 --log-file=${browserLog}` : "";
// The executable's own output is kept: Tauri reports a failed webview creation there.
const appLog = resolve(desktop, "test-results", "desktop-smoke.log");
const appOut = openSync(appLog, "w");
const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}${ciArguments}` }, stdio: ["ignore", appOut, appOut] });
children.push(app);
let browser = null;
// A cold WebView2 start on a CI runner can take well over the local few seconds.
const connectBudgetMs = Number(process.env.SMOKE_CONNECT_MS ?? 120_000);
for (let waited = 0; waited < connectBudgetMs && !browser; waited += 500) {
  await sleep(500);
  if (app.exitCode !== null) fail(`the executable exited early with code ${app.exitCode}`);
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* not yet */ }
}
if (!browser) {
  // Say what the runner had, so a missing runtime reads differently from a slow start.
  const { execSync } = await import("node:child_process");
  const probe = (command) => { try { return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (error) { return `(${String(error.message).split("\n")[0]})`; } };
  console.error("WebView2 runtime (HKLM):", probe(String.raw`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`));
  console.error("WebView2 runtime (HKCU):", probe(String.raw`reg query "HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`));
  console.error("processes:", probe('tasklist /fi "IMAGENAME eq devtools-desktop.exe" /fo csv /nh'), probe('tasklist /fi "IMAGENAME eq msedgewebview2.exe" /fo csv /nh'));
  console.error("listening on the port:", probe(`netstat -ano | findstr :${port}`) || "(nothing)");
  try { console.error("/json/version:", (await (await fetch(`http://127.0.0.1:${port}/json/version`)).text()).slice(0, 300)); } catch (error) { console.error("/json/version:", String(error.cause ?? error.message).slice(0, 200)); }
  if (existsSync(browserLog)) console.error("webview2 log tail:", readFileSync(browserLog, "utf8").split("\n").slice(-40).join("\n"));
  else console.error("webview2 log: none written at", browserLog);
  console.error("executable output:", (existsSync(appLog) ? readFileSync(appLog, "utf8").trim() : "") || "(empty)");
  // A picture of the runner's desktop: a dialog or an unpainted window says more than any log.
  const shot = resolve(desktop, "test-results", "desktop-smoke.png");
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${shot.replace(/'/g, "''")}'); Write-Output ("screen " + $b.Width + "x" + $b.Height)`;
  console.error("desktop screenshot:", probe(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`), existsSync(shot) ? shot : "(not written)");
  fail(`could not connect to WebView2 over CDP within ${Math.round(connectBudgetMs / 1000)} s (executable ${app.exitCode === null ? "still running" : `exited ${app.exitCode}`})`);
}

const errors = [];

try {
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) fail("no page in the WebView2 context");
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && !/favicon\.ico|404|Blocked script execution in 'about:srcdoc'/.test(message.text())) errors.push(`console: ${message.text()}`); });
  // The shell declares no favicon; the webview asks for one anyway and the
  // preview server answers 404. Every other failed resource is a real error.
  page.on("response", (response) => { if (response.status() >= 400 && !/\/favicon\.ico$/.test(response.url())) errors.push(`${response.status()} ${response.url()}`); });
  await page.waitForSelector("#tabs", { timeout: 15_000 });
  await page.locator("#status").filter({ hasText: "Engine connected" }).waitFor({ timeout: 15_000 });

  const names = await page.locator(".tool-item strong").allTextContents();
  for (const required of ["JSON", "String Case Converter", "Diff & Compare"])
    if (!names.includes(required)) fail(`sidebar is missing "${required}"; it lists: ${names.join(" | ")}`);

  // 3. A Rust tool through the host.
  await page.keyboard.press("Control+n");
  await page.locator("#preview").fill('{"b":1,"a":[1,2]}');
  await page.locator(".tool-item").filter({ has: page.locator("strong", { hasText: /^JSON$/ }) }).click();
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.locator("#result-state").filter({ hasText: "Completed successfully" }).waitFor({ timeout: 15_000 });
  const json = await page.locator("#result-content").innerText();
  if (!json.includes('"b": 1')) fail(`JSON format produced unexpected output: ${json.slice(0, 200)}`);

  // 4. A package tool through the worker engine, with an option change.
  await page.keyboard.press("Control+n");
  await page.locator("#preview").fill("userID_loaderHTTPServer v2Api");
  await page.locator(".tool-item").filter({ has: page.locator("strong", { hasText: /^String Case Converter$/ }) }).click();
  await page.locator("#result-state").filter({ hasText: "Completed successfully" }).waitFor({ timeout: 15_000 });
  await page.getByLabel("Target").selectOption("snake");
  await page.locator("#result-content").filter({ hasText: "user_id_loader_http_server_v_2_api" }).waitFor({ timeout: 15_000 });

  if (errors.length) fail(`the webview reported errors:\n${errors.join("\n")}`);
  console.log(`native smoke passed in ${Math.round((Date.now() - started) / 1000)} s: ${names.length} tools listed, JSON on Rust, String Case Converter on the worker engine, no webview errors.`);
} finally {
  await browser.close().catch(() => undefined);
  children.forEach(stop);
}
