// What the suite asserts about the shipped window. Ids match docs/MANUAL_TEST_PLAN.md,
// so a failure here names the case a human would otherwise have run by hand.
//
// Expected values come from an independent computation — node's crypto, an RFC
// constant, a second parse, a re-encode of the same bytes — never from the app's own
// output. A golden recorded by running the app proves it is stable, not that it is
// right; see the plan's section 7 for the distinction.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import jsQR from "../../packages/vendor/jsqr/jsqr.mjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, sleep } from "./harness.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const base64 = (value) => Buffer.from(value).toString("base64");
const verdict = (ok, note) => ({ status: ok ? "pass" : "fail", note });

/** RFC 4122 name-based v5, computed here: SHA-1 of namespace then name, version and variant bits set. */
function uuidV5(namespaceHex, name) {
  const digest = crypto.createHash("sha1").update(Buffer.concat([Buffer.from(namespaceHex, "hex"), Buffer.from(name)])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
const DNS_NAMESPACE = "6ba7b8109dad11d180b400c04fd430c8";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A scratch directory for files a check opens or saves, beside the run's other evidence. */
const scratch = resolve(root, "apps", "desktop", "test-results", "files");
const scratchFile = (name, contents) => {
  mkdirSync(scratch, { recursive: true });
  const file = resolve(scratch, name);
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
};
const digest = (file) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
/**
 * A scratch path with nothing left from an earlier run: a save check that finds last
 * run's file passes whether or not this run wrote anything. With `contents`, the file
 * starts with exactly that; without, it does not exist.
 */
const freshFile = (name, contents) => {
  const file = scratchFile(name);
  if (existsSync(file)) { chmodSync(file, 0o644); rmSync(file); }
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
};
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
/**
 * The status line is a sink that keeps its last message, so a check that reads it can
 * find the previous check's. Blank it before the action; whatever appears after is this
 * action's.
 */
const clearStatus = (driver) => driver.page.evaluate(() => { document.querySelector("#status").textContent = ""; });
/** The next message in the status line, whatever it says. Call clearStatus before acting. */
const nextStatus = (driver) => driver.until(async () => (await driver.page.locator("#status").innerText()).trim() || null);
/** The status line once it starts with `prefix`, or null. Call clearStatus before acting. */
const statusStarting = (driver, prefix) => driver.until(async () => {
  const text = (await driver.page.locator("#status").innerText()).trim();
  return text.startsWith(prefix) ? text : null;
});

/** Windows PowerShell runs STA, which the clipboard needs; pwsh does not by default. */
const clipboardShell = (script) =>
  execFileSync("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ${script}`], { encoding: "utf8" }).trim();
/** Empty the clipboard, so an image found after a copy is that copy's. */
const clearClipboard = () => clipboardShell("[System.Windows.Forms.Clipboard]::Clear()");
/**
 * The clipboard's image as RGBA pixels, read by .NET: a path through neither the app
 * nor Chromium, so what it finds is what another program pasting would get.
 */
function clipboardImage() {
  const out = scratchFile("clipboard.bgra");
  const answer = clipboardShell([
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if (-not $image) { 'none'; exit }",
    "$bitmap = New-Object System.Drawing.Bitmap $image",
    "$rect = New-Object System.Drawing.Rectangle 0, 0, $bitmap.Width, $bitmap.Height",
    "$data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)",
    "$bytes = New-Object byte[] ($data.Stride * $bitmap.Height)",
    "[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)",
    `[IO.File]::WriteAllBytes('${out}', $bytes)`,
    "'{0} {1} {2}' -f $bitmap.Width, $bitmap.Height, $data.Stride",
  ].join("; "));
  if (answer === "none") return null;
  const [width, height, stride] = answer.split(" ").map(Number);
  const bgra = readFileSync(out);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const from = y * stride + x * 4, to = (y * width + x) * 4;
      rgba[to] = bgra[from + 2]; rgba[to + 1] = bgra[from + 1]; rgba[to + 2] = bgra[from]; rgba[to + 3] = bgra[from + 3];
    }
  return { width, height, rgba };
}

/** A PNG of the given opaque RGBA pixels, encoded here: the check knows every pixel it should get back. */
function pngOf(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) Buffer.from(pixel(x, y)).copy(rows, y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Ids the native host serves itself. The engine lets a native id win over a package of
 * the same name, so the rail shows the bundled tool's panel and the package manifest
 * describes something the user never sees. Listed in PLUGIN_HOST_IMPLEMENTATION.md.
 */
const NATIVE_IDS = new Set([
  "structured.json", "text.compare", "text.url",
  "text.json-string", "encoding.hash", "text.find-replace",
]);

/** Every package tool as its manifest declares it, keyed by the title in the rail. */
function declaredTools() {
  const declared = new Map();
  for (const dir of readdirSync(resolve(root, "plugins"))) {
    const file = resolve(root, "plugins", dir, "manifest.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const tool of manifest.tools ?? []) {
      const operations = (manifest.operations ?? []).filter((operation) => (tool.operationIds ?? []).includes(operation.id));
      if (NATIVE_IDS.has(tool.id)) continue;
      declared.set(tool.title, {
        id: tool.id,
        operations: operations.map((operation) => ({
          id: operation.id,
          title: operation.title,
          options: (operation.options ?? []).map((option) => option.label),
        })),
      });
    }
  }
  return declared;
}

export const checks = [
  {
    id: "SMK-01",
    smoke: true,
    async run({ page }) {
      const title = await page.title();
      const shell = await page.locator(".app-shell").count();
      return verdict(shell > 0, `title "${title}", app shell present`);
    },
  },
  {
    id: "SMK-02",
    smoke: true,
    async run({ page }) {
      const engine = (await page.locator("#engine-status").innerText()).trim();
      return verdict(/local engine/i.test(engine), `engine reads "${engine}"`);
    },
  },
  {
    id: "SMK-03",
    smoke: true,
    async run({ page, state }) {
      state.tools = await page.locator(".tool-item strong").allTextContents();
      const missing = ["JSON", "String Case Converter", "Diff & Compare", "QR Code", "Regular Expression Tester"]
        .filter((name) => !state.tools.includes(name));
      return verdict(!missing.length, missing.length
        ? `the rail is missing ${missing.join(", ")}; it lists ${state.tools.length}: ${state.tools.join(" | ")}`
        : `${state.tools.length} tools listed`);
    },
  },
  {
    // Every option and operation a manifest declares is reachable, and no operation
    // button is offered twice. This is what made JS minify's Preserve comments
    // unreachable and had JSON to YAML offering a choice it rejects.
    id: "OPT-01",
    async run({ driver, state }) {
      const declared = declaredTools();
      const problems = [];
      let inspected = 0;
      for (const name of state.tools ?? []) {
        if (name === "Text editor") continue;
        const spec = declared.get(name);
        if (!spec) continue;   // bundled Rust tools have no v2 manifest
        inspected += 1;
        await driver.newTab();
        await driver.selectTool(name);
        try { await driver.setInput("a"); } catch { /* compare and image workspaces have no plain editor */ }
        const operations = await driver.readOperations();
        const duplicates = operations.filter((label, index) => operations.indexOf(label) !== index);
        if (duplicates.length) problems.push(`${name}: duplicate operation button ${duplicates.join(", ")}`);
        for (const operation of spec.operations) {
          if (!operations.includes(operation.title)) {
            problems.push(`${name}: no button for operation "${operation.title}"`);
            continue;
          }
          await driver.runOperation(operation.title);
          await sleep(220);
          const shown = (await driver.readOptions()).map((option) => option.label);
          const missing = operation.options.filter((label) => !shown.includes(label));
          const extra = shown.filter((label) => !operation.options.includes(label));
          if (missing.length) problems.push(`${name} / ${operation.title}: missing ${missing.join(", ")}`);
          if (extra.length) problems.push(`${name} / ${operation.title}: offers ${extra.join(", ")}, which it does not declare`);
        }
      }
      return verdict(!problems.length, problems.length ? problems.join(" | ") : `${inspected} package tools: every declared operation and option present, and nothing else`);
    },
  },
  {
    id: "NAV-02",
    async run({ page, state }) {
      await page.locator("#tool-search").fill("json");
      await sleep(220);
      const filtered = await page.locator(".tool-item strong").allTextContents();
      await page.locator("#tool-search").fill("");
      await sleep(220);
      const restored = await page.locator(".tool-item strong").count();
      return verdict(filtered.length > 0 && filtered.length < state.tools.length && restored === state.tools.length,
        `"json" matched ${filtered.length} of ${state.tools.length}; cleared back to ${restored}`);
    },
  },
  {
    id: "NAV-08",
    async run({ driver, page }) {
      await driver.newTab();
      await driver.selectTool("String Case Converter");
      await driver.setInput("keep this text");
      await sleep(400);
      await driver.selectTool("URL Parser");
      await sleep(400);
      const text = await page.locator("#preview").inputValue();
      return verdict(text === "keep this text", `the editor holds "${text}" after switching tools`);
    },
  },
  {
    id: "EDT-14",
    async run({ driver }) {
      await driver.newTab();
      await driver.selectTool("String Case Converter");
      const before = (await driver.readResult()).signature;
      await driver.setInput("auto run me");
      const started = Date.now();
      const result = await driver.settle(Buffer.byteLength("auto run me"), { changedFrom: before, timeout: 5000 });
      return verdict(!result.timedOut && Boolean(result.output), result.timedOut
        ? "a tool declaring inputChange produced no result within 5 s of typing"
        : `ran ${Date.now() - started} ms after typing stopped`);
    },
  },
  {
    // trigger.modes is a contract, not a hint: CSS declares explicit-only execution
    // for inputs that run to 16 MiB, so typing must not start a run.
    id: "EDT-15",
    async run({ driver }) {
      await driver.newTab();
      await driver.selectTool("CSS");
      await driver.setInput(".a{color:red}");
      await sleep(2000);
      const idle = await driver.readResult();
      if (idle.output) return { status: "fail", note: `CSS declares trigger ["explicit"] and ran anyway: ${idle.output.slice(0, 80)}` };
      await driver.runOperation("Beautify");
      const pressed = await driver.settle(Buffer.byteLength(".a{color:red}"), { changedFrom: idle.signature });
      return verdict(pressed.output.includes("color"), `waited for its button, then produced ${JSON.stringify(pressed.output.slice(0, 60))}`);
    },
  },
  {
    id: "RES-02",
    async run({ driver }) {
      const result = await driver.tool("JSON", { text: '{"a": }', operation: "Format" });
      const message = result.error || result.state;
      return verdict(Boolean(message) && !result.output, `reported ${JSON.stringify(message.slice(0, 90))} and left the output empty`);
    },
  },
  {
    id: "RES-03",
    async run({ driver }) {
      await driver.newTab();
      await driver.selectTool("JSON");
      await driver.setInput('{"a": }');
      await driver.runOperation("Format");
      const bad = await driver.settle(Buffer.byteLength('{"a": }'));
      await driver.setInput('{"a":1}');
      await driver.runOperation("Format");
      const good = await driver.settle(Buffer.byteLength('{"a":1}'), { changedFrom: bad.signature });
      return verdict(!good.error && good.output.includes('"a"'), `the error cleared and the result is ${JSON.stringify(good.output.slice(0, 40))}`);
    },
  },
  {
    // Opening a real file through the host, and the promise the product makes about it.
    id: "DOC-03",
    async run({ driver, page }) {
      const file = scratchFile("open-me.json", '{"b":1,"a":[1,2]}\n');
      await driver.newTab();
      await driver.openPath(file);
      const name = (await page.locator("#source-name").innerText()).trim();
      const size = (await page.locator("#source-size").innerText()).trim();
      const text = await page.locator("#preview").inputValue();
      return verdict(name.includes("open-me.json") && text.includes('"b"') && size !== "—",
        `the tab shows ${JSON.stringify(name)}, ${size}, and the file's text`);
    },
  },
  {
    // The product's first promise: your input file is never written to.
    id: "DOC-04",
    async run({ driver }) {
      const file = scratchFile("untouched.json", '{"keep":"me"}\n');
      const before = digest(file);
      await driver.newTab();
      await driver.openPath(file);
      await driver.selectTool("JSON");
      await driver.runOperation("Format");
      await driver.settle();
      await driver.selectTool("Hash generator");
      await driver.runOperation("SHA-256");
      await driver.settle();
      const after = digest(file);
      return verdict(before === after, before === after
        ? `the file is byte-identical after two operations (${before.slice(0, 16)}…)`
        : `the file changed on disk: ${before.slice(0, 16)}… became ${after.slice(0, 16)}…`);
    },
  },
  {
    // Save writes back to the file the tab was opened from and asks nothing. A decoy
    // is the dialog's answer, so a dialog that should not have opened leaves a file.
    id: "DOC-17",
    async run({ driver, page }) {
      const file = freshFile("in-place.txt", "first draft\n");
      const decoy = freshFile("in-place-decoy.txt");
      await driver.openPath(file);
      await driver.setInput("second draft\n");
      const label = (await page.locator("#save-document").innerText()).trim();
      await driver.presetDialogPaths([decoy]);
      await page.locator("#preview").press("Control+s");
      const written = await driver.until(() => read(file) === "second draft\n");
      await driver.presetDialogPaths([]);
      return verdict(!!written && !existsSync(decoy) && label === "Save",
        `button "${label}"; the file holds ${JSON.stringify(read(file))}; ${existsSync(decoy) ? "a dialog was asked for" : "no dialog"}`);
    },
  },
  {
    // An untitled tab asks once; after that Save goes where it went.
    id: "DOC-31",
    async run({ driver, page }) {
      const target = freshFile("untitled-saved.txt");
      const decoy = freshFile("untitled-decoy.txt");
      await driver.newTab();
      await driver.selectTool("String Case Converter");
      await driver.setInput("first version\n");
      await driver.presetDialogPaths([target]);
      await page.locator("#preview").press("Control+s");
      const first = await driver.until(() => read(target) === "first version\n");
      if (!first) return verdict(false, `the dialog's path holds ${JSON.stringify(read(target))}`);
      await driver.setInput("second version\n");
      await driver.presetDialogPaths([decoy]);
      await page.locator("#preview").press("Control+s");
      const second = await driver.until(() => read(target) === "second version\n");
      await driver.presetDialogPaths([]);
      return verdict(!!second && !existsSync(decoy),
        `after the second Ctrl+S the file holds ${JSON.stringify(read(target))}; ${existsSync(decoy) ? "it asked again" : "it did not ask again"}`);
    },
  },
  {
    // A read-only file is refused in words; the file and the edits both survive.
    id: "DOC-20",
    async run({ driver, page }) {
      const file = freshFile("read-only.txt", "locked\n");
      chmodSync(file, 0o444);
      try {
        await driver.openPath(file);
        await driver.setInput("locked, edited\n");
        await clearStatus(driver);
        await page.locator("#preview").press("Control+s");
        const status = await statusStarting(driver, "Not saved:");
        const kept = await page.locator("#preview").inputValue();
        const dirty = await page.locator(".tab-wrap.active .dirty-indicator").count();
        return verdict(/read-only/.test(status ?? "") && read(file) === "locked\n" && kept === "locked, edited\n" && dirty === 1,
          `status "${status}"; file ${JSON.stringify(read(file))}; editor ${JSON.stringify(kept)}; ${dirty ? "still unsaved" : "marked saved"}`);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  },
  {
    // Another program wrote the file after the app read it. A silent Save must not
    // replace that; the refusal says what happened and what to do instead.
    id: "DOC-32",
    async run({ driver, page }) {
      const file = freshFile("changed-elsewhere.txt", "as opened\n");
      await driver.openPath(file);
      writeFileSync(file, "written by another program\n");
      await driver.setInput("edited in the app\n");
      await clearStatus(driver);
      await page.locator("#preview").press("Control+s");
      const status = await statusStarting(driver, "Not saved:");
      return verdict(/changed on disk/.test(status ?? "") && /Save As/.test(status ?? "") && read(file) === "written by another program\n",
        `status "${status}"; the other program's file holds ${JSON.stringify(read(file))}`);
    },
  },
  {
    // Several files in one drop: each gets a tab, in order; a folder among them is
    // refused by name in the one notice (DOC-29). The OS drag cannot be scripted, so
    // this enters where the drop event does, in the shell's handler.
    id: "DOC-28",
    async run({ driver, page }) {
      await driver.closeExtraTabs(1);
      const names = ["drop-one.json", "drop-two.txt", "drop-three.md"];
      const paths = names.map((name, i) => scratchFile(name, i === 0 ? '{"n":1}' : `file ${i + 1}`));
      const folder = scratchFile("drop-folder");
      mkdirSync(folder, { recursive: true });
      const before = await page.locator(".tab-wrap").count();
      await page.evaluate(() => { document.querySelector("#status").textContent = ""; });
      await page.evaluate((list) => globalThis.devtoolsTest.dropPaths(list), [...paths, folder].map((path) => path.replace(/\\/g, "/")));
      const status = await driver.until(async () => {
        const text = (await page.locator("#status").innerText()).trim();
        return text.startsWith("Opened") ? text : null;
      });
      const tabs = await page.locator(".tab-wrap .tab-name").allInnerTexts();
      const added = tabs.slice(before).map((text) => text.trim());
      return verdict(
        JSON.stringify(added) === JSON.stringify(names) && /^Opened 3 of 4 files · drop-folder: /.test(status ?? ""),
        `new tabs ${JSON.stringify(added)}; status "${status}"`,
      );
    },
  },
  {
    // AST-006: a file the tab saved, not opened, is guarded like one it opened. Another
    // program changes it; the next Ctrl+S must refuse, and that program's text survive.
    id: "DOC-33",
    async run({ driver, page }) {
      const file = freshFile("saved-then-changed.txt");
      await driver.newTab();
      await driver.selectTool("String Case Converter");
      await driver.setInput("first saved text\n");
      await driver.presetDialogPaths([file]);
      await page.locator("#preview").press("Control+s");
      if (!(await driver.until(() => read(file) === "first saved text\n"))) return verdict(false, `the first save did not land: ${JSON.stringify(read(file))}`);
      writeFileSync(file, "EXTERNAL EDIT, MUST SURVIVE\n");
      await driver.setInput("edited inside app\n");
      await clearStatus(driver);
      await page.locator("#preview").press("Control+s");
      const status = await nextStatus(driver);
      return verdict(/changed on disk/.test(status ?? "") && read(file) === "EXTERNAL EDIT, MUST SURVIVE\n",
        `status "${status}"; the file holds ${JSON.stringify(read(file))}`);
    },
  },
  {
    // AST-006: after Save As A -> B the tab is B's. B is guarded, and A opens as itself.
    id: "DOC-34",
    async run({ driver, page }) {
      const a = freshFile("save-as-source.txt", "contents of A\n");
      const b = freshFile("save-as-target.txt");
      await driver.openPath(a);
      await driver.setInput("contents for B\n");
      await driver.presetDialogPaths([b]);
      await page.locator("#preview").press("Control+Shift+s");
      if (!(await driver.until(() => read(b) === "contents for B\n"))) return verdict(false, `Save As did not land: ${JSON.stringify(read(b))}`);
      writeFileSync(b, "EXTERNAL EDIT OF B\n");
      await driver.setInput("more edits\n");
      await clearStatus(driver);
      await page.locator("#preview").press("Control+s");
      const status = await nextStatus(driver);
      const guarded = /changed on disk/.test(status ?? "") && read(b) === "EXTERNAL EDIT OF B\n";
      let shown = null;
      try {
        await driver.openPath(a);
        shown = await page.locator("#preview").inputValue();
      } catch (error) {
        shown = `(${error.message})`;
      }
      return verdict(guarded && shown === "contents of A\n" && read(a) === "contents of A\n",
        `B: status "${status}", holds ${JSON.stringify(read(b))}; opening A shows ${JSON.stringify(shown)}`);
    },
  },
  {
    // A saved result keeps the extension its type implies, and the whole payload.
    id: "RES-08",
    async run({ driver, page }) {
      const target = freshFile("saved-result.json");
      await driver.tool("JSON", { text: '{"b":1,"a":[1,2]}', operation: "Format" });
      await driver.presetDialogPaths([target]);
      const save = page.locator("#save-result");
      if (await save.isHidden()) return { status: "fail", note: "Save result is not offered for a successful result" };
      await save.click();
      const written = await driver.until(() => existsSync(target));
      if (!written) return { status: "fail", note: "no file appeared at the path the dialog returned" };
      const contents = readFileSync(target, "utf8");
      let parsed = null;
      try { parsed = JSON.parse(contents); } catch { /* not JSON */ }
      return verdict(parsed?.b === 1 && contents.includes(String.fromCharCode(10)),
        `the saved file re-parses to the formatted value (${contents.length} bytes)`);
    },
  },
  {
    // The dialog asked and the user confirmed: the old file is replaced by the result.
    id: "RES-09",
    async run({ driver, page }) {
      const target = freshFile("replaced-result.json", "old contents that must go\n");
      await driver.tool("JSON", { text: '{"replaced":true}', operation: "Format" });
      await driver.presetDialogPaths([target]);
      await page.locator("#save-result").click();
      const replaced = await driver.until(() => read(target) !== "old contents that must go\n");
      let parsed = null;
      try { parsed = JSON.parse(read(target) ?? ""); } catch { /* not JSON */ }
      return verdict(!!replaced && parsed?.replaced === true, `the file now holds ${JSON.stringify((read(target) ?? "").slice(0, 40))}`);
    },
  },
  {
    id: "RES-10",
    async run({ driver, page }) {
      await driver.closeExtraTabs();
      await driver.tool("Base64 Text", { text: "chain me" });
      const before = await page.locator(".tab-wrap").count();
      const button = page.locator("#open-result");
      if (await button.isHidden()) return { status: "fail", note: "Open result is not offered for a successful result" };
      await button.click();
      await driver.until(async () => (await page.locator(".tab-wrap").count()) > before);
      const after = await page.locator(".tab-wrap").count();
      const text = await page.locator("#preview").inputValue();
      return verdict(after === before + 1 && text.trim() === base64("chain me"),
        `tabs ${before} to ${after}, the new tab holds ${JSON.stringify(text.slice(0, 30))}`);
    },
  },
  {
    id: "RES-12",
    async run({ driver, page }) {
      await driver.tool("String Case Converter", { text: "toggle me" });
      const toggle = page.locator("#result-toggle");
      if (await toggle.isHidden()) return { status: "fail", note: "no result toggle after a successful run" };
      const before = await toggle.innerText();
      await toggle.click();
      await sleep(220);
      const hidden = await page.locator(".results-pane").isHidden();
      const middle = await toggle.innerText();
      await toggle.click();
      await sleep(220);
      const back = await page.locator(".results-pane").isVisible();
      return verdict(before !== middle && hidden && back, `"${before}" to "${middle}", pane hidden then restored`);
    },
  },
  {
    // A JSON result can be walked as a tree and queried with a path. RES-14 in the
    // plan: a structured result has to be readable, not one unwrapped line.
    id: "RES-14",
    async run({ driver, page }) {
      await driver.tool("JSON", { text: "{\"store\":{\"book\":[{\"title\":\"Sayings\",\"price\":8.95},{\"title\":\"Moby Dick\",\"price\":8.99}],\"bicycle\":{\"color\":\"red\"}}}", operation: "Format" });
      const toggle = page.locator("#view-tree");
      if (await toggle.isHidden()) return { status: "fail", note: "a JSON result offered no tree view" };
      await toggle.click();
      await driver.until(async () => (await page.locator("#tree-body .tree-node").count()) > 1);
      const rows = await page.locator("#tree-body .tree-node").count();

      // Query it. node finds the same two prices, so the count is not the app's opinion.
      const expected = [...JSON.stringify(JSON.parse("{\"store\":{\"book\":[{\"title\":\"Sayings\",\"price\":8.95},{\"title\":\"Moby Dick\",\"price\":8.99}],\"bicycle\":{\"color\":\"red\"}}}")).matchAll(/"price":/g)].length;
      await page.locator("#tree-path").fill("$..price");
      const matched = await driver.until(async () => {
        const status = (await page.locator("#tree-path-status").innerText()).trim();
        return /match/.test(status) ? status : null;
      });
      const shown = (await page.locator("#tree-body").innerText()).replace(/\s+/g, " ");

      // Syntax the evaluator does not implement is refused by name: an empty list
      // would read as "nothing matched", which is a different fact.
      await page.locator("#tree-path").fill("$.store.book[?(@.price<9)]");
      const refused = await driver.until(async () => {
        const status = (await page.locator("#tree-path-status").innerText()).trim();
        return /not supported/i.test(status) ? status : null;
      });

      const ok = rows > 1 && matched === `${expected} matches` && shown.includes("8.95") && Boolean(refused);
      return verdict(ok, `${rows} rows; node counts ${expected} prices and the pane says "${matched}"; a filter expression is refused with "${(refused ?? "").slice(0, 48)}"`);
    },
  },
  {
    // AST-008: the tree shows the result's own digits. The oracle is the input text:
    // 9007199254740993 is not a double, and 1e400 is not Infinity.
    id: "RES-14c",
    async run({ driver, page }) {
      await driver.tool("JSON", { text: '{"id":9007199254740993,"overflow":1e400}', operation: "Format" });
      const text = await driver.fullResult();
      await page.locator("#view-tree").click();
      const shown = await driver.until(async () => {
        const body = (await page.locator("#tree-body").innerText()).replace(/\s+/g, " ");
        return /overflow/.test(body) ? body : null;
      });
      await page.locator("#tree-path").fill("$.id");
      const queried = await driver.until(async () => {
        const status = (await page.locator("#tree-path-status").innerText()).trim();
        return /match/.test(status) ? (await page.locator("#tree-body").innerText()).replace(/\s+/g, " ") : null;
      });
      await page.locator("#tree-path").fill("");
      await page.locator("#view-text").click();
      const exact = (body) => /9007199254740993/.test(body ?? "") && !/9007199254740992/.test(body ?? "");
      return verdict(text.includes("9007199254740993") && exact(shown) && /1e400/.test(shown ?? "") && !/Infinity/.test(shown ?? "") && exact(queried),
        `tree: ${JSON.stringify((shown ?? "").slice(0, 90))}; $.id: ${JSON.stringify((queried ?? "").slice(0, 60))}`);
    },
  },
  {
    // AST-009: 5,000 matching ids, by construction, are 5,000 matches — not "no matches".
    id: "RES-14d",
    async run({ driver, page }) {
      const ids = Array.from({ length: 5_000 }, (_, id) => ({ id }));
      await driver.tool("JSON", { text: JSON.stringify(ids), operation: "Minify" });
      await page.locator("#view-tree").click();
      await driver.until(async () => (await page.locator("#tree-body .tree-node").count()) > 0);
      await page.locator("#tree-path").fill("$[*].id");
      const status = await driver.until(async () => {
        const now = (await page.locator("#tree-path-status").innerText()).trim();
        return /match|stopped/.test(now) ? now : null;
      });
      await page.locator("#tree-path").fill("");
      await page.locator("#view-text").click();
      return verdict(status === `${ids.length} matches`, `$[*].id over ${ids.length} objects: the pane says "${status}"`);
    },
  },
  {
    id: "RES-21",
    async run({ driver, page }) {
      const text = "2024-02-29 and 1999-12-31";
      await driver.newTab();
      await driver.selectTool("Regular Expression Tester");
      await driver.setInput(text);
      const empty = await driver.settle(Buffer.byteLength(text));
      await driver.setOption("Pattern", "[0-9]{4}");
      await driver.settle(Buffer.byteLength(text), { changedFrom: empty.signature });
      const expected = [...text.matchAll(/[0-9]{4}/g)].length;
      const layer = await page.evaluate(() => ({
        hidden: document.querySelector("#editor-highlight")?.hidden,
        marks: document.querySelectorAll("#editor-highlight mark").length,
      }));
      return verdict(layer.hidden === false && layer.marks === expected,
        `node finds ${expected} matches; the editor shows ${layer.marks} highlights (layer hidden=${layer.hidden})`);
    },
  },

  // ---- tools, each against an oracle the app had no part in producing
  {
    id: "TL-CASE-01",
    smoke: true,
    async run({ driver }) {
      const result = await driver.tool("String Case Converter", { text: "userID_loaderHTTPServer v2Api", options: { Target: "snake" } });
      return verdict(result.output.trim() === "user_id_loader_http_server_v_2_api", `got ${JSON.stringify(result.output.trim().slice(0, 60))}`);
    },
  },
  {
    id: "TL-B64TEXT-01",
    async run({ driver }) {
      const result = await driver.tool("Base64 Text", { text: "hello" });
      return verdict(result.output.trim() === base64("hello"), `expected ${base64("hello")}, got ${JSON.stringify(result.output.trim())}`);
    },
  },
  {
    id: "TL-B64TEXT-02",
    async run({ driver }) {
      const result = await driver.tool("Base64 Text", { text: base64("hello"), options: { Mode: "decode" } });
      return verdict(result.output.trim() === "hello", `got ${JSON.stringify(result.output.trim())}`);
    },
  },
  {
    id: "TL-HASH-01",
    async run({ driver }) {
      const result = await driver.tool("Hash generator", { text: "hello", operation: "SHA-256" });
      const body = result.output || result.structured;
      return verdict(body.toLowerCase().includes(sha256("hello")), `node computes ${sha256("hello").slice(0, 20)}…; the app shows ${body.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    // AST-007: an unedited file is hashed as its bytes, BOM included; once edited, as
    // its text in UTF-8. The result says which. node:crypto supplies both digests.
    id: "TL-HASH-07",
    async run({ driver, page }) {
      const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
      const file = freshFile("bom-hello.txt");
      writeFileSync(file, bytes);
      const readRow = () => page.evaluate(() => {
        const term = [...document.querySelectorAll("#result-metrics dt")].find((dt) => dt.textContent.trim() === "Read");
        return term?.nextElementSibling?.textContent.trim() ?? null;
      });
      const before = (await driver.readResult()).signature;
      await driver.openPath(file, "encoding.hash");
      await driver.runOperation("SHA-256");
      const first = await driver.settle(bytes.length, { changedFrom: before });
      const fileDigest = crypto.createHash("sha256").update(bytes).digest("hex");
      const unedited = (first.output || first.structured).toLowerCase().includes(fileDigest) && (await readRow()) === "the file's bytes";
      await driver.setInput("hello, edited");
      const second = await driver.settle(Buffer.byteLength("hello, edited"), { changedFrom: first.signature });
      const edited = (second.output || second.structured).toLowerCase().includes(sha256("hello, edited")) && (await readRow()) === "the text, as UTF-8";
      return verdict(unedited && edited,
        `unedited: expected ${fileDigest.slice(0, 16)}…, shows ${(first.output || first.structured).replace(/\s+/g, " ").slice(0, 70)} (input ${first.inputBytes} B); edited: ${edited ? "text digest, labelled" : (second.output || second.structured).slice(0, 60)}`);
    },
  },
  {
    // AST-020: every document tab is reachable from the keyboard. Real key presses; the
    // expectation is the WAI-ARIA tabs pattern, not whatever the strip happens to do.
    id: "A11Y-10",
    async run({ driver, page }) {
      await driver.closeExtraTabs(1);
      // Three documents at least, whatever the run started with.
      while ((await page.locator("#tabs .tab").count()) < 3) await driver.newTab();
      const state = () => page.evaluate(() => {
        const tabs = [...document.querySelectorAll("#tabs .tab")];
        return {
          active: tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true"),
          focused: tabs.indexOf(document.activeElement),
          count: tabs.length,
        };
      });
      const start = await state();
      await page.locator("#tabs .tab[aria-selected=true]").focus();
      const steps = [];
      for (const key of ["ArrowLeft", "ArrowLeft", "End", "Home", "ArrowRight"]) {
        await page.keyboard.press(key);
        steps.push([key, await state()]);
      }
      // From the editor: Ctrl+Tab moves to the next tab and leaves focus in the editor.
      await page.locator("#preview").focus();
      const before = (await state()).active;
      await page.keyboard.press("Control+Tab");
      const after = await state();
      const n = start.count, last = n - 1;
      const expected = [last - 1, last - 2, last, 0, 1];
      const moved = steps.every(([, s], i) => s.active === expected[i] && s.focused === expected[i]);
      const ctrlTab = after.active === (before + 1) % n && after.focused === -1;
      return verdict(n >= 3 && start.active === last && moved && ctrlTab,
        `${n} tabs; ${steps.map(([k, s]) => `${k}->${s.active}${s.focused === s.active ? "" : `(focus ${s.focused})`}`).join(", ")}; Ctrl+Tab ${before}->${after.active}`);
    },
  },
  {
    id: "TL-NUMBASE-01",
    async run({ driver }) {
      // Exercises the option controls too: the defaults would answer this one by accident.
      const result = await driver.tool("Number Base Converter", { text: "ff", options: { "From Base": "16", "To Base": "2" } });
      const body = (result.output || "") + " " + (await driver.fullResult());
      return verdict(body.includes((255).toString(2)), `0xff in base 2 is ${(255).toString(2)}; result: ${body.replace(/\s+/g, " ").slice(0, 110)}`);
    },
  },
  {
    id: "TL-URL-01",
    async run({ driver }) {
      const result = await driver.tool("URL encode / decode", { text: "https://example.com/search?q=hello world", operation: "Encode" });
      return verdict(/hello(%20|\+)world/.test(result.output), `got ${JSON.stringify(result.output.slice(0, 80))}`);
    },
  },
  {
    id: "TL-JSON-01",
    smoke: true,
    async run({ driver }) {
      const result = await driver.tool("JSON", { text: '{"b":1,"a":[1,2]}', operation: "Format" });
      let same = false;
      try { same = JSON.stringify(JSON.parse(result.output)) === JSON.stringify({ b: 1, a: [1, 2] }); } catch { /* not JSON */ }
      return verdict(same && result.output.includes("\n"), same ? "re-parses to the same value and is indented" : `output: ${result.output.slice(0, 80)}`);
    },
  },
  {
    id: "TL-JSON-06",
    async run({ driver }) {
      const big = "123456789012345678901234567890";
      const result = await driver.tool("JSON", { text: `{"n":${big}}`, operation: "Format" });
      return verdict(result.output.includes(big), `a 30-digit integer is ${result.output.includes(big) ? "preserved exactly" : `changed: ${result.output.slice(0, 80)}`}`);
    },
  },
  {
    id: "TL-YAML-01",
    async run({ driver }) {
      const result = await driver.tool("YAML ↔ JSON", { text: "store:\n  book:\n    - title: Sample\n      price: 8.95\n  open: true\n", operation: "YAML to JSON" });
      let parsed = null;
      try { parsed = JSON.parse(result.output); } catch { /* not JSON */ }
      const ok = parsed?.store?.book?.[0]?.price === 8.95 && parsed?.store?.open === true;
      return verdict(ok, ok ? "types survive the conversion (number 8.95, boolean true)" : `output: ${result.output.slice(0, 110)}`);
    },
  },
  {
    id: "TL-TIME-02",
    async run({ driver }) {
      await driver.tool("Unix Timestamp Converter", { text: "1700000000" });
      await sleep(300);
      const body = await driver.fullResult();
      const day = new Date(1700000000 * 1000).toISOString().slice(0, 10);
      return verdict(body.includes(day), `epoch 1700000000 is ${day}; result: ${body.slice(0, 120)}`);
    },
  },
  {
    id: "TL-UUID-04",
    async run({ driver }) {
      // RFC 4122 v5 of the DNS namespace + example.com, computed here, not read back.
      const expected = uuidV5(DNS_NAMESPACE, "example.com");
      await driver.newTab();
      await driver.selectTool("UUID Generator");
      const defaults = await driver.settle(0);
      for (const [label, value] of [["Version", "v5"], ["Namespace", "dns"], ["Name", "example.com"]]) await driver.setOption(label, value);
      await driver.settle(0, { changedFrom: defaults.signature });
      const body = await driver.fullResult();
      return verdict(body.toLowerCase().includes(expected), `RFC 4122 gives ${expected}; result: ${body.slice(0, 120)}`);
    },
  },
  {
    id: "TL-UUID-09",
    async run({ driver, page }) {
      // DU-10: typing beside Generate used to run it, and every keystroke failed with
      // "UUID must be canonical". Nothing should happen now, so there is no change to
      // wait for: give a run longer than its debounce to show itself, and look for any sign.
      await driver.newTab();
      await driver.selectTool("UUID Generator");
      const generated = await driver.settle(0);
      const first = generated.output.trim();
      if (!UUID_V4.test(first)) return verdict(false, `selecting Generate gave "${first}" (error "${generated.error}")`);
      await driver.setInput("not a uuid");
      const disturbed = await driver.until(async () => {
        const now = await driver.readResult();
        return now.error || now.signature !== generated.signature ? now : null;
      }, { timeout: 2500 });
      if (disturbed) return verdict(false, `typing beside Generate changed the result to "${disturbed.state}" (error "${disturbed.error}")`);
      if (!(await page.locator("#copy-result").isVisible())) return verdict(false, "typing beside Generate hid Copy on the value it generated");
      // AST-013: a visible button is not a working one. Press it, and read what reached
      // the system clipboard through .NET; then open the value as a tab.
      clearClipboard();
      await clearStatus(driver);
      await page.locator("#copy-result").click();
      const copied = await driver.until(() => clipboardShell("[System.Windows.Forms.Clipboard]::GetText()") || null, { timeout: 6000, step: 300 });
      if (copied?.trim() !== first) return verdict(false, `Copy after typing put ${JSON.stringify(copied)} on the clipboard (status "${(await page.locator("#status").innerText()).trim()}"); the value was ${first}`);
      const tabs = await page.locator(".tab-wrap").count();
      await page.locator("#open-result").click();
      const opened = await driver.until(async () => (await page.locator(".tab-wrap").count()) > tabs);
      const openedText = opened ? (await page.locator("#preview").inputValue()).trim() : null;
      if (openedText !== first) return verdict(false, `Open as tab after typing gave ${JSON.stringify(openedText)}; the value was ${first}`);
      await page.locator(".tab-wrap").nth(tabs - 1).locator(".tab-button, button").first().click();
      await driver.runOperation("Generate");
      const next = await driver.settle(undefined, { changedFrom: generated.signature });
      const value = next.output.trim();
      return verdict(!next.error && UUID_V4.test(value) && value !== first, `with text in the editor, Generate gave "${value}" (error "${next.error}"); the first was ${first}`);
    },
  },
  {
    id: "TL-UUID-10",
    async run({ driver }) {
      // Decode reads the UUID from the document and follows it. Each expected version is
      // the value's own version nibble: v5 by construction, and the 4 in f47ac10b-58cc-4372-...
      const five = uuidV5(DNS_NAMESPACE, "example.com");
      const four = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
      const reports = (body, version) => new RegExp(`version\\W{0,3}${version}\\b`, "i").test(body);
      await driver.newTab();
      await driver.selectTool("UUID Generator");
      const generated = await driver.settle(0);
      await driver.setInput(five);
      await driver.runOperation("Decode");
      const decoded = await driver.settle(five.length, { changedFrom: generated.signature });
      const first = await driver.fullResult();
      if (decoded.error || !reports(first, 5)) return verdict(false, `Decode of ${five}: ${decoded.error || first.slice(0, 160)}`);
      await driver.setInput(four);
      const followed = await driver.settle(four.length, { changedFrom: decoded.signature });
      const second = await driver.fullResult();
      return verdict(!followed.error && !followed.timedOut && reports(second, 4), `after the edit, with no press: ${followed.error || second.slice(0, 160)}`);
    },
  },
  {
    id: "RES-31",
    async run({ driver, page }) {
      // A kept result that nothing is about to replace must say so. CSS Beautify runs only
      // when pressed, so after an edit the old result is out of date, not updating.
      const css = "a{color:red}";
      await driver.newTab();
      await driver.selectTool("CSS");
      await driver.setInput(css);
      const before = (await driver.readResult()).signature;
      await driver.runOperation("Beautify");
      const done = await driver.settle(Buffer.byteLength(css), { changedFrom: before });
      if (done.error || done.timedOut) return verdict(false, `Beautify did not complete: ${done.error || "timed out"}`);
      await driver.setInput("a{color:blue}");
      const relabelled = await driver.until(async () => {
        const now = await driver.readResult();
        return now.state !== done.state ? now : null;
      }, { timeout: 3000 });
      const state = relabelled?.state ?? done.state;
      const copyHidden = await page.locator("#copy-result").isHidden();
      return verdict(/Out of date/.test(state) && !/Updating/.test(state) && copyHidden, `after an edit Beautify will not act on, the result reads "${state}", Copy ${copyHidden ? "hidden" : "shown"}`);
    },
  },
  {
    id: "TL-REGEX-01",
    async run({ driver }) {
      const text = "2024-02-29 and 1999-12-31";
      await driver.newTab();
      await driver.selectTool("Regular Expression Tester");
      await driver.setInput(text);
      const empty = await driver.settle(Buffer.byteLength(text));
      await driver.setOption("Pattern", "([0-9]{4})-([0-9]{2})-([0-9]{2})");
      await driver.settle(Buffer.byteLength(text), { changedFrom: empty.signature });
      const body = await driver.fullResult();
      const expected = [...text.matchAll(/([0-9]{4})-([0-9]{2})-([0-9]{2})/g)].length;
      return verdict(body.includes(`count: ${expected}`), `node finds ${expected} matches; result: ${body.slice(0, 120)}`);
    },
  },
  {
    id: "TL-JWT-01",
    async run({ driver }) {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: "1234567890", name: "Test User", iat: 1700000000 })).toString("base64url");
      const signature = crypto.createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url");
      await driver.tool("JWT Decoder & Verifier", { text: `${header}.${payload}.${signature}` });
      const body = await driver.fullResult();
      return verdict(body.includes("Test User") && body.includes("1234567890"), `the decoded payload is shown: ${body.slice(0, 120)}`);
    },
  },
  {
    id: "TL-JWT-08",
    async run({ page }) {
      const type = await page.locator('.format-control [aria-label="Key"]').first().getAttribute("type").catch(() => null);
      return verdict(type === "password", `the Key field is an input of type "${type}"`);
    },
  },
  {
    id: "TL-PREVIEW-01",
    async run({ driver, page }) {
      await driver.tool("Markdown & HTML Preview", { text: "# Title\n\nSome **bold** text and a [link](https://example.com).\n", operation: "Preview Markdown" });
      const frames = await page.locator("#result-media iframe").count();
      return verdict(frames > 0, frames > 0 ? "rendered in a sandboxed frame" : "no preview frame appeared");
    },
  },
  {
    id: "TL-PREVIEW-05",
    async run({ driver, page, dialogs }) {
      const before = await driver.readResult();
      const hostile = "# Heading\n\n<script>window.__pwned = 1;</script>\n\n[click](javascript:window.__pwned=2)\n";
      await driver.setInput(hostile);
      const rendered = await driver.settle(Buffer.byteLength(hostile), { changedFrom: before.signature });
      if (rendered.timedOut) return { status: "fail", note: "the preview never rendered the document under test, so nothing was proven" };
      await sleep(600);   // give an injected script the chance this check exists to deny it
      const pwned = await page.evaluate(() => window.__pwned ?? null);
      return verdict(pwned === null && dialogs.length === 0, `the document rendered and its script did not run (window.__pwned is ${String(pwned)}, ${dialogs.length} dialogs)`);
    },
  },
  {
    id: "TL-QR-01",
    async run({ driver }) {
      const result = await driver.tool("QR Code", { text: "https://example.com" });
      return verdict(result.mediaTag === "IMG" && /svg/i.test(result.mediaSrc), `result media is ${result.mediaTag || "absent"}`);
    },
  },
  {
    // Copy image puts a picture on the clipboard that another program can use: .NET
    // reads the pixels back and jsQR, outside the app, decodes the text from them.
    id: "RES-32",
    async run({ driver, page }) {
      const text = `https://example.com/copied-${Date.now()}`;
      await driver.tool("QR Code", { text });
      const button = page.locator("#copy-image");
      if (await button.isHidden()) return verdict(false, "Copy image is not offered for a QR code");
      clearClipboard();
      await button.click();
      const image = await driver.until(async () => clipboardImage(), { timeout: 8000, step: 400 });
      if (!image) return verdict(false, "no image reached the clipboard");
      const decoded = jsQR(image.rgba, image.width, image.height);
      return verdict(decoded?.data === text, `${image.width}x${image.height} on the clipboard; jsQR reads ${JSON.stringify(decoded?.data ?? null)}`);
    },
  },
  {
    // A PNG result is copied as the same picture: every pixel the check encoded comes back.
    id: "RES-33",
    async run({ driver, page }) {
      const width = 24, height = 16;
      const pixel = (x, y) => [x * 10, y * 15, (x * y) % 256, 255];
      const png = pngOf(width, height, pixel);
      const uri = `data:image/png;base64,${png.toString("base64")}`;
      await driver.tool("Base64 to Image", { text: uri });
      const button = page.locator("#copy-image");
      if (await button.isHidden()) return verdict(false, "Copy image is not offered for an image result");
      clearClipboard();
      await button.click();
      const image = await driver.until(async () => clipboardImage(), { timeout: 8000, step: 400 });
      if (!image) return verdict(false, "no image reached the clipboard");
      let wrong = 0;
      for (let y = 0; y < height && image.width === width && image.height === height; y += 1)
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4, want = pixel(x, y);
          if (image.rgba[at] !== want[0] || image.rgba[at + 1] !== want[1] || image.rgba[at + 2] !== want[2]) wrong += 1;
        }
      return verdict(image.width === width && image.height === height && wrong === 0,
        `${image.width}x${image.height} on the clipboard (encoded ${width}x${height}); ${wrong} of ${width * height} pixels differ`);
    },
  },
  {
    id: "TL-DIFF-01",
    async run({ driver, page }) {
      await driver.newTab();
      await driver.selectTool("Diff & Compare");
      const before = (await driver.readResult()).signature;
      await page.locator("#compare-left").fill("alpha\nbravo\ncharlie\n");
      await page.locator("#compare-right").fill("alpha\nbravo CHANGED\ncharlie\n");
      const result = await driver.settle(undefined, { changedFrom: before, timeout: 20_000 });
      const body = (result.structured || (await driver.fullResult())).replace(/\s+/g, " ");
      return verdict(/bravo/i.test(body) && !/no differences/i.test(body), `reported: ${body.slice(0, 110)}`);
    },
  },
  {
    id: "TL-CSS-01",
    async run({ driver }) {
      const result = await driver.tool("CSS", { text: ".a{color:red;background:#fff}  .b , .c{margin:0 auto}", operation: "Beautify" });
      return verdict(result.output.includes("\n") && result.output.includes("color"), `output: ${result.output.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    id: "TL-JS-05",
    async run({ driver }) {
      // Division, a regex literal, a string containing a comment opener and a kept
      // licence comment: the four the tokenizer got wrong before AG-115 round two.
      const source = 'a = b / c / d; x = /b[/]c/g; s = "/*"; /*! keep */ const t = 1;';
      const result = await driver.tool("JavaScript Formatter", { text: source, operation: "Minify JavaScript" });
      const dense = result.output.replace(/\s+/g, "");
      return verdict(dense.includes("a=b/c/d") && dense.includes("/b[/]c/g") && dense.includes('s="/*"') && result.output.includes("/*!"),
        `minified: ${result.output.slice(0, 110)}`);
    },
  },
  {
    id: "REG-13",
    async run({ driver }) {
      // An option declared on minify alone was unreachable while the form was built
      // from the first operation's schema.
      await driver.newTab();
      await driver.selectTool("JavaScript Formatter");
      await driver.setInput("const a = 1; // note");
      const beautify = (await driver.readOptions()).map((option) => option.label);
      await driver.runOperation("Minify JavaScript");
      const minify = (await driver.until(async () => {
        const labels = (await driver.readOptions()).map((option) => option.label);
        return labels.join("|") === beautify.join("|") ? null : labels;
      })) ?? beautify;
      return verdict(minify.includes("Preserve comments") && !beautify.includes("Preserve comments"),
        `Beautify offers [${beautify.join(", ")}], Minify offers [${minify.join(", ")}]`);
    },
  },
  {
    id: "REG-14",
    async run({ driver }) {
      // JSON to YAML rejects "minified"; offering it produced a run that always failed.
      await driver.newTab();
      await driver.selectTool("YAML ↔ JSON");
      await driver.setInput('{"a":{"b":[1,2]}}');
      await driver.runOperation("JSON to YAML");
      const indent = await driver.until(async () => (await driver.readOptions()).find((option) => /indent/i.test(option.label)));
      const choices = indent?.choices ?? [];
      if (!choices.length) return { status: "fail", note: "JSON to YAML offers no indent control" };
      const before = await driver.settle(Buffer.byteLength('{"a":{"b":[1,2]}}'));
      await driver.setOption(indent.label, choices[choices.length - 1]);
      const result = await driver.settle(Buffer.byteLength('{"a":{"b":[1,2]}}'), { changedFrom: before.signature });
      return verdict(!choices.includes("minified") && !result.error,
        `offers [${choices.join(", ")}]; choosing "${choices[choices.length - 1]}" ${result.error ? `fails: ${result.error.slice(0, 60)}` : "runs cleanly"}`);
    },
  },
  {
    id: "TL-XML-01",
    async run({ driver }) {
      const result = await driver.tool("XML", { text: '<?xml version="1.0"?><root><item id="1"><name>a</name></item><empty/></root>', operation: "Beautify" });
      return verdict(result.output.includes("\n") && result.output.includes("<name>a</name>"), `output: ${result.output.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    id: "TL-SQL-01",
    async run({ driver }) {
      const result = await driver.tool("SQL Formatter", { text: "select a.id, b.name from users a join orders b on b.user_id=a.id where a.active=1", operation: "Beautify SQL" });
      return verdict(/SELECT/.test(result.output) && result.output.includes("\n"), `output: ${result.output.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    id: "TL-JSX-01",
    async run({ driver }) {
      const result = await driver.tool("HTML/SVG to JSX", { text: '<div class="a"><p>Hello</p><!-- note --></div>' });
      return verdict(result.output.includes("className") && result.output.includes("{/*"), `output: ${result.output.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    // The plan marked 01 and 02 as automated; no check existed until now. The expected
    // text is written from the HTML specification, not recorded from the tool.
    id: "TL-HTMLESC-01",
    async run({ driver }) {
      const result = await driver.tool("HTML Escape / Unescape", { text: '<p class="sample">Hello & bye</p>', options: { Mode: "escape" } });
      const expected = "&lt;p class=&quot;sample&quot;&gt;Hello &amp; bye&lt;/p&gt;";
      return verdict(result.output.trim() === expected, `escape gave ${JSON.stringify(result.output.trim().slice(0, 70))}`);
    },
  },
  {
    // AST-019: named references beyond the five XML ones. © is U+00A9 and é U+00E9 in
    // the HTML specification's named character reference table.
    id: "TL-HTMLESC-06",
    async run({ driver }) {
      const result = await driver.tool("HTML Escape / Unescape", { text: "&copy; &eacute; &amp; &#x1F642; &lt;b&gt;", options: { Mode: "unescape" } });
      const expected = "\u00A9 \u00E9 & \u{1F642} <b>";
      return verdict(!result.error && result.output.trim() === expected, `unescape gave ${JSON.stringify(result.output.trim())} (error "${result.error}")`);
    },
  },
  {
    id: "TL-HTMLFMT-01",
    async run({ driver }) {
      const result = await driver.tool("HTML Beautify/Minify", { text: "<div><p>Hello <b>world</b></p></div>", operation: "Beautify" });
      return verdict(result.output.includes("\n"), `output: ${result.output.replace(/\s+/g, " ").slice(0, 90)}`);
    },
  },
  {
    id: "TL-EXAMPLES-01",
    async run({ driver }) {
      await driver.tool("Example String Generator", { text: "", options: { Category: "email" } });
      await sleep(400);
      const body = await driver.fullResult();
      return verdict(/@/.test(body), `category email produced: ${body.slice(0, 100)}`);
    },
  },
  {
    id: "PAGE-ERRORS",
    smoke: true,
    async run({ errors }) {
      const unique = [...new Set(errors)];
      return verdict(!unique.length, unique.length ? `${unique.length} webview errors: ${unique.slice(0, 5).join(" | ")}` : "no webview console or page errors during the run");
    },
  },
];
