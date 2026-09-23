// Driving the shell the way a person does: pick a tool, type, set an option, press an
// operation, read the result.
//
// The one subtle part is knowing WHICH result is on screen. The pane keeps the last
// result while a new one is pending and marks it "· Updating…", and the output field
// keeps its text even while the pane is hidden. A reader that ignores either will
// happily report the previous case's output as this one's — plausible, consistent and
// wrong. `settle` therefore waits for three things to agree: the pane is not busy, the
// result is not the one that was there before the action, and (when the input size is
// known) the metrics row names the input under test.

import { sleep } from "./harness.mjs";

export function driver(page) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toolItem = (label) =>
    page.locator(".tool-item").filter({ has: page.locator("strong", { hasText: new RegExp(`^${escape(label)}$`) }) }).first();

  const readResult = () => page.evaluate(() => {
    const visible = (selector) => {
      const node = document.querySelector(selector);
      if (!node || node.hidden) return "";
      return (node.value ?? node.innerText ?? "").trim();
    };
    const error = document.querySelector("#error");
    const media = document.querySelector("#result-media");
    const shown = document.querySelector("#result-content")?.hidden === false;
    return {
      state: visible("#result-state"),
      output: shown ? (document.querySelector("#result-output")?.value ?? "") : "",
      structured: visible("#result-structured"),
      error: error && !error.hidden ? error.textContent.trim() : "",
      mediaTag: media && !media.hidden ? (media.querySelector("img, iframe")?.tagName ?? "empty") : "",
      mediaSrc: media?.querySelector("img")?.src?.slice(0, 120) ?? "",
      highlights: document.querySelectorAll("#editor-highlight mark").length,
      inputBytes: (() => {
        const metrics = (document.querySelector("#result-metrics")?.textContent ?? "") + " " + (document.querySelector("#result-content")?.textContent ?? "");
        const match = /Input\s*([\d,]+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB)\b/i.exec(metrics);
        if (!match) return null;
        return /^B$/i.test(match[2]) ? Number(match[1].replace(/,/g, "")) : null;
      })(),
      signature: [
        document.querySelector("#result-state")?.textContent ?? "",
        (document.querySelector("#result-output")?.value ?? "").slice(0, 120),
        (document.querySelector("#result-metrics")?.textContent ?? "").slice(0, 80),
        (document.querySelector("#result-media")?.innerHTML ?? "").slice(0, 60),
      ].join("|"),
    };
  });

  /** The whole result body, including the collapsed "Operation details" element. */
  const fullResult = () => page.evaluate(() => {
    const body = document.querySelector("#result-content")?.textContent ?? "";
    const structured = document.querySelector("#result-structured")?.textContent ?? "";
    const output = document.querySelector("#result-output")?.value ?? "";
    return `${body} ${structured} ${output}`.replace(/\s+/g, " ").trim();
  });

  async function settle(expectBytes, { changedFrom, timeout = 15_000 } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await readResult();
      const busy = /Running|Queued|Working|Starting|Updating/i.test(last.state) || /Updating/i.test(last.error);
      const sizeAgrees = expectBytes === undefined || last.inputBytes === null || last.inputBytes === expectBytes;
      const isNew = changedFrom === undefined || last.signature !== changedFrom;
      if (!busy && sizeAgrees && isNew && (last.state || last.error)) return last;
      await sleep(120);
    }
    return { ...(last ?? {}), timedOut: true };
  }

  /**
   * Poll until a condition holds. A fixed sleep in place of a condition is the
   * flake that CI finds and a developer machine hides: the runner is slower, the
   * read lands early, and the check reports the previous state as this one's.
   */
  async function until(predicate, { timeout = 10_000, step = 100 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await sleep(step);
    }
    return null;
  }

  async function closeExtraTabs(keep = 3) {
    // The shell caps tabs at 16; a run that hoards them starts testing its own mess.
    while ((await page.locator(".tab-wrap").count()) > keep) {
      const closer = page.locator(".tab-close").first();
      if (!(await closer.count())) break;
      await closer.click();
      await sleep(100);
      if (await page.locator("#unsaved-dialog").isVisible().catch(() => false)) {
        await page.locator("#unsaved-discard").click();
        await sleep(120);
      }
    }
  }

  async function newTab() {
    await closeExtraTabs();
    const before = await page.locator(".tab-wrap").count();
    await page.locator("#tab-new").click();
    for (let waited = 0; waited < 3000; waited += 100) {
      if ((await page.locator(".tab-wrap").count()) > before) return;
      await sleep(100);
    }
    throw new Error("the new-tab button did not create a tab");
  }

  async function selectTool(label) {
    const item = toolItem(label);
    if (!(await item.count())) throw new Error(`no tool named "${label}" in the rail`);
    await item.click();
    await sleep(180);
  }

  async function setInput(text) {
    const editor = page.locator("#preview");
    if (!(await editor.isVisible())) throw new Error("this tool has no plain editor (compare or image workspace)");
    await editor.fill(text, { timeout: 5000 });
    await sleep(100);
  }

  const readOptions = () => page.evaluate(() => {
    const host = document.querySelector(".format-control");
    if (!host) return [];
    return [...host.querySelectorAll("label")].map((label) => {
      const control = label.querySelector("select, input, textarea");
      if (!control) return { label: label.textContent.trim(), kind: "none" };
      if (control.tagName === "SELECT")
        return {
          label: control.getAttribute("aria-label") ?? label.textContent.trim(),
          kind: "enum",
          value: control.value,
          choices: [...control.options].map((option) => option.value),
        };
      return {
        label: control.getAttribute("aria-label") ?? label.textContent.trim(),
        kind: control.type,
        value: control.type === "checkbox" ? control.checked : control.value,
        min: control.min || undefined,
        max: control.max || undefined,
      };
    });
  });

  const readOperations = () => page.evaluate(() =>
    [...document.querySelectorAll(".toolbar-actions button")].map((button) => button.textContent.trim()).filter(Boolean));

  /** A text or number option commits on change, so leave the field as a person would. */
  async function setOption(label, value) {
    const control = page.locator(`.format-control [aria-label="${label}"]`).first();
    if (!(await control.count())) throw new Error(`no option control labelled "${label}"`);
    const tag = await control.evaluate((node) => `${node.tagName}:${node.type ?? ""}`);
    if (tag.startsWith("SELECT")) await control.selectOption(String(value));
    else if (tag.endsWith(":checkbox")) await control.setChecked(Boolean(value));
    else { await control.fill(String(value)); await control.press("Tab"); }
    await sleep(220);
  }

  async function runOperation(name) {
    const button = page.locator(".toolbar-actions button", { hasText: new RegExp(`^${escape(name)}$`) }).first();
    if (!(await button.count())) throw new Error(`no operation button "${name}"`);
    await button.click();
  }

  /** Open a tool in a fresh tab, drive it, and return the result it produced. */
  async function tool(label, { text, operation, options } = {}) {
    await newTab();
    await selectTool(label);
    const before = (await readResult()).signature;
    if (text !== undefined && text !== "") await setInput(text);
    if (options) for (const [key, value] of Object.entries(options)) await setOption(key, value);
    if (operation) await runOperation(operation);
    return settle(text === undefined ? undefined : Buffer.byteLength(text), { changedFrom: before });
  }

  /** Open a real file the way the Open button does, minus the dialog. */
  /**
   * Open a file and wait for its own tab. Waiting for "some document" returns at once
   * when the previous tab already shows one, and the check then acts on that tab.
   */
  async function openPath(path, toolId) {
    const name = path.split(/[\\/]/).pop();
    await page.evaluate(([target, tool]) => globalThis.devtoolsTest.openPath(target, tool), [path.replace(/\\/g, "/"), toolId ?? null]);
    const shown = await until(async () => (await page.locator("#source-name").innerText()).trim() === name);
    if (!shown) throw new Error(`${name} did not open in its own tab`);
  }
  /** The path the next dialog returns; one per dialog, in order. */
  const presetDialogPaths = (paths) =>
    page.evaluate((list) => globalThis.devtoolsTest.presetDialogPaths(list), paths.map((path) => path.replace(/\\/g, "/")));

  return {
    page, toolItem, newTab, closeExtraTabs, selectTool, setInput, setOption,
    runOperation, readOptions, readOperations, readResult, fullResult, settle, tool, until,
    openPath, presetDialogPaths,
  };
}
