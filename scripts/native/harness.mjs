// Launches the real desktop executable and connects to its webview over WebView2's
// debugging port. Everything a check needs to run against the shipped window lives
// here; the checks themselves are in checks.mjs.
//
// A debug build of the desktop crate loads build.devUrl (127.0.0.1:1420), not the
// embedded bundle, so this serves the built dist there with `vite preview` for the
// duration of the run.

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const desktop = resolve(root, "apps", "desktop");
export const artifacts = resolve(desktop, "test-results");
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const previewPort = 1420;

/** Say what the machine had, so a missing runtime reads differently from a slow start. */
function diagnose(port, browserLog, appLog, connectBudgetMs, app) {
  const probe = (command) => {
    try { return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch (error) { return `(${String(error.message).split("\n")[0]})`; }
  };
  console.error("WebView2 runtime (HKLM):", probe(String.raw`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`));
  console.error("WebView2 runtime (HKCU):", probe(String.raw`reg query "HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`));
  console.error("processes:", probe('tasklist /fi "IMAGENAME eq devtools-desktop.exe" /fo csv /nh'), probe('tasklist /fi "IMAGENAME eq msedgewebview2.exe" /fo csv /nh'));
  console.error("listening on the port:", probe(`netstat -ano | findstr :${port}`) || "(nothing)");
  if (existsSync(browserLog)) console.error("webview2 log tail:", readFileSync(browserLog, "utf8").split("\n").slice(-40).join("\n"));
  else console.error("webview2 log: none written at", browserLog);
  console.error("executable output:", (existsSync(appLog) ? readFileSync(appLog, "utf8").trim() : "") || "(empty)");
  // A picture of the desktop: a dialog or an unpainted window says more than any log.
  const shot = resolve(artifacts, "native-suite.png");
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${shot.replace(/'/g, "''")}'); Write-Output ("screen " + $b.Width + "x" + $b.Height)`;
  console.error("desktop screenshot:", probe(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`), existsSync(shot) ? shot : "(not written)");
  console.error(`could not connect to WebView2 over CDP within ${Math.round(connectBudgetMs / 1000)} s (executable ${app.exitCode === null ? "still running" : `exited ${app.exitCode}`})`);
}

/**
 * Starts the preview server and the executable, and resolves once the webview's page
 * is reachable. Throws with diagnostics printed when it is not.
 */
export async function startApp() {
  const { chromium } = createRequire(resolve(desktop, "package.json"))("@playwright/test");
  const exe = resolve(root, "target", process.env.NATIVE_PROFILE ?? "debug", "devtools-desktop.exe");
  const port = Number(process.env.NATIVE_CDP_PORT ?? 9333);
  const children = [];
  const stopChild = (child) => {
    if (!child || child.exitCode !== null) return;
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  };
  const stop = () => children.forEach(stopChild);
  process.on("exit", stop);

  if (!existsSync(exe)) throw new Error(`${exe} is missing; run cargo build -p devtools-desktop first`);
  if (!existsSync(resolve(desktop, "dist", "index.html"))) throw new Error("apps/desktop/dist is missing; run the desktop build first");

  const preview = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], { cwd: desktop, stdio: "ignore", shell: true });
  children.push(preview);
  let served = false;
  for (let attempt = 0; attempt < 60 && !served; attempt += 1) {
    await sleep(500);
    try { served = (await fetch(`http://127.0.0.1:${previewPort}/`)).ok; } catch { /* not yet */ }
  }
  if (!served) { stop(); throw new Error(`vite preview did not answer on ${previewPort}`); }

  // A CI runner has no usable GPU and runs the process under a service-like session;
  // WebView2's browser process then stalls at start-up unless told to skip both.
  mkdirSync(artifacts, { recursive: true });
  const browserLog = resolve(artifacts, "webview2-suite.log");
  const appLog = resolve(artifacts, "native-suite.log");
  const ciArguments = process.env.CI ? ` --disable-gpu --disable-gpu-compositing --no-sandbox --enable-logging --v=0 --log-file=${browserLog}` : "";
  const browserArguments = `--remote-debugging-port=${port}${ciArguments}`;
  const appOut = openSync(appLog, "w");
  // DEVTOOLS_SMOKE_BROWSER_ARGS is read by a debug build of the host and passed to the
  // webview builder; WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is the runtime's own hook,
  // honoured on some machines and ignored on the CI runner.
  const app = spawn(exe, [], {
    env: {
      ...process.env,
      DEVTOOLS_SMOKE_BROWSER_ARGS: browserArguments,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
      // Lets a check name the file a dialog would have returned. A debug build only.
      DEVTOOLS_TEST_HOOKS: "1",
    },
    stdio: ["ignore", appOut, appOut],
  });
  children.push(app);

  let browser = null;
  const connectBudgetMs = Number(process.env.NATIVE_CONNECT_MS ?? 120_000);
  for (let waited = 0; waited < connectBudgetMs && !browser; waited += 500) {
    await sleep(500);
    if (app.exitCode !== null) { stop(); throw new Error(`the executable exited early with code ${app.exitCode}`); }
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* not yet */ }
  }
  if (!browser) {
    diagnose(port, browserLog, appLog, connectBudgetMs, app);
    stop();
    throw new Error("could not connect to the webview");
  }

  // The connection can land before the webview has attached its page; wait for it.
  let page = null;
  for (let waited = 0; waited < 30_000 && !page; waited += 500) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith("devtools://")) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) {
    await browser.close().catch(() => undefined);
    stop();
    throw new Error("no page in the WebView2 context after 30 s");
  }

  const errors = [];
  const dialogs = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  // The shell declares no favicon; the webview asks for one anyway and the preview
  // server answers 404. Every other failed resource is a real error.
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon\.ico|404|Blocked script execution in 'about:srcdoc'/.test(message.text()))
      errors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !/\/favicon\.ico$/.test(response.url())) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });

  await page.waitForSelector("#tabs", { timeout: 20_000 });
  await page.locator("#status").filter({ hasText: "Engine connected" }).waitFor({ timeout: 20_000 });
  const hooks = await page.evaluate(() => Boolean(globalThis.devtoolsTest));
  if (!hooks) throw new Error("the window did not expose its test hooks; is this a debug build?");

  return {
    page,
    errors,
    dialogs,
    async close() {
      await browser.close().catch(() => undefined);
      stop();
    },
  };
}
