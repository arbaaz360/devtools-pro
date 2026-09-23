import "./styles.css";
import "./toolViews.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  native,
  chooseFile,
  chooseFiles,
  chooseDocumentOutput,
  chooseResultOutput,
  presetDialogPaths,
  openDocument,
  createTextDocument,
  closeDocument,
  readPreview,
  readBinaryPreview,
  saveDocument,
  saveResult,
  runTool,
  runCompare,
  cancelOperation,
  jobStatus,
  subscribeJobs,
  listTools,
  type FileDocument,
} from "./bridge";
import {
  WorkbenchController,
  errorText,
  type WorkbenchApi,
} from "./workbench/controller";
import {
  activeTab,
  type TabState,
  type WorkspaceState,
} from "./workbench/state";
import {
  validation,
  type ToolDefinition,
  optionSchemaFor,
} from "./workbench/tools";
import { WorkerEngine } from "./plugins/engine";
import { annotationMarkup } from "./ui/annotations";
import { renderJsonTree, renderMatches } from "./ui/jsonTree";
import { JsonPathError, evaluateJsonPath } from "./ui/jsonPath";
import type { OptionSpec } from "../../../packages/plugin-contract/ts/generated.ts";
import { findMatches, nextMatch, replaceAll } from "./workbench/findReplace";
import { delayedIndicator } from "./ui/delayedIndicator";
import { imageAsPng, type ImageSource } from "./ui/imageClipboard";
import {
  SIDE_TITLES,
  byteLength,
  compareInputProblem,
  describeCompare,
  granularityControl,
  lineCount,
  mountCompareWorkspace,
  parseCompareResult,
  renderCompareResult,
  type CompareSide,
  type CompareSideView,
  type CompareWorkspace,
} from "./toolViews/diffView";

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char] ?? char,
  );
const bytes = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i ? n.toFixed(n >= 100 ? 0 : 1) : n.toFixed(0)} ${units[i]}`;
};
let state: WorkspaceState;
let controller: WorkbenchController;
let paletteOpener: HTMLElement | null = null;
let renderedResult: object | null = null;
let renderedStaleNote = "";
/** What a retained result says about itself: a run is coming to replace it, or none is. */
const staleNote = (tab: TabState): string =>
  !tab.resultStale ? "" : tab.resultOutdated ? " · Out of date — run to update" : " · Updating…";
/** The view a result was last drawn in; switching it has to redraw the pane. */
let renderedView = "";
let renderedOptionsKey = "";
let renderedToolsKey = "";
let renderedActionsKey = "";
const layoutStorage = {
  split: "devtoolspro.workspace.split",
  compareSplit: "devtoolspro.workspace.compare-split",
  sidebar: "devtoolspro.sidebar.collapsed",
};
const readNumber = (key: string, fallback: number) => {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null || stored.trim() === "") return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
};
let splitRatio = Math.min(0.72, Math.max(0.28, readNumber(layoutStorage.split, 0.56)));
// Compare tabs stack sources above the result, so they keep their own ratio.
let compareSplitRatio = Math.min(0.72, Math.max(0.28, readNumber(layoutStorage.compareSplit, 0.5)));
const collapsedResults = new Set<string>();
/** Per-tab compare view state that the workbench reducer does not own: which
 * file backs each side, and the selected change. Pruned when a tab closes. */
interface CompareSourceMeta {
  label: string | null;
  baseline: string | null;
  issue: string | null;
}
interface CompareMeta {
  left: CompareSourceMeta;
  right: CompareSourceMeta;
  /** Once a tab has compared, its result pane stays so editing does not reflow the editors. */
  hadResult: boolean;
  change: number;
  changeResult: object | null;
  statusFor: object | null;
  status: string;
}
const compareMetas = new Map<string, CompareMeta>();
const emptySide = (): CompareSourceMeta => ({ label: null, baseline: null, issue: null });
function compareMeta(id: string): CompareMeta {
  let meta = compareMetas.get(id);
  if (!meta) {
    meta = { left: emptySide(), right: emptySide(), hadResult: false, change: -1, changeResult: null, statusFor: null, status: "" };
    compareMetas.set(id, meta);
  }
  return meta;
}
try {
  if (localStorage.getItem(layoutStorage.sidebar) === "true")
    document.querySelector(".sidebar")?.classList.add("collapsed");
} catch {
  /* local storage is optional in browser preview */
}
function displayTabName(tab: TabState): string {
  if (!/^Untitled-\d+\.txt$/i.test(tab.name)) return tab.name;
  const tool = controller.toolDefinition(tab.toolId);
  const number = tab.name.match(/\d+/)?.[0] ?? "";
  return `${tool?.label ?? "Document"}${number ? ` ${number}` : ""}`;
}
function persistLayout() {
  try {
    localStorage.setItem(layoutStorage.split, String(splitRatio));
    localStorage.setItem(layoutStorage.compareSplit, String(compareSplitRatio));
  } catch {
    /* optional */
  }
}
const palette = $("#palette") as HTMLDialogElement;
const paletteSearch = $("#palette-search") as HTMLInputElement;
const notify = (message: string) => {
  $("#status").textContent = message;
};
const jobIndicator = delayedIndicator((visible) => {
  const panel = $("#job-panel");
  // If a job finishes while Cancel has focus, return to its editor.
  const returnFocus = !visible && panel.contains(document.activeElement);
  panel.hidden = !visible;
  if (returnFocus) {
    const input = $("#preview") as HTMLTextAreaElement;
    if (!input.hidden) input.focus({ preventScroll: true });
  }
});

function promptClose(tab: TabState): Promise<"save" | "discard" | "cancel"> {
  const dialog = $("#unsaved-dialog") as HTMLDialogElement;
  const rightOnly = !tab.dirty && tab.rightDirty;
  $("#unsaved-message").textContent = rightOnly
    ? `${displayTabName(tab)} has unsaved text on the right / revised side. Closing discards it.`
    : tab.rightDirty
      ? `${displayTabName(tab)} has unsaved changes. Save writes the document; the right / revised text is discarded with the tab.`
      : `${displayTabName(tab)} has unsaved changes.`;
  // Save writes the left document only, so offer it only when that is what is unsaved.
  $("#unsaved-save").hidden = rightOnly;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (answer: "save" | "discard" | "cancel") => {
      dialog.close();
      resolve(answer);
    };
    $("#unsaved-save").onclick = () => finish("save");
    $("#unsaved-discard").onclick = () => finish("discard");
    $("#unsaved-cancel").onclick = () => finish("cancel");
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish("cancel");
    };
  });
}
/**
 * The tab after (or before) `from`, wrapping — or the first or last. The tab strip is
 * a WAI-ARIA tablist with a roving tabIndex: only the active tab is in the Tab order,
 * so without arrow keys the others could not be reached from the keyboard at all.
 */
function neighbourTab(from: string, key: string): string | undefined {
  const order = state.tabs.map((tab) => tab.id);
  const at = order.indexOf(from);
  if (at < 0 || !order.length) return undefined;
  if (key === "ArrowRight" || key === "next") return order[(at + 1) % order.length];
  if (key === "ArrowLeft" || key === "previous") return order[(at - 1 + order.length) % order.length];
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  return undefined;
}
/** Show a tab and put keyboard focus on its button, as the tabs pattern expects. */
function selectTabFromKeyboard(id: string, focusButton: boolean) {
  controller.activate(id);
  if (focusButton) document.querySelector<HTMLButtonElement>(`#tabs .tab[data-tab-id="${CSS.escape(id)}"]`)?.focus();
}
function renderTabs() {
  const root = $("#tabs");
  root.innerHTML = "";
  if (!state.tabs.length) {
    root.innerHTML = '<span class="empty-tab">Your workspace</span>';
    return;
  }
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `tab-wrap${tab.id === state.activeId ? " active" : ""}`;
    const button = document.createElement("button");
    button.className = "tab";
    button.type = "button";
    button.role = "tab";
    button.ariaSelected = String(tab.id === state.activeId);
    button.tabIndex = tab.id === state.activeId ? 0 : -1;
    const tabName = displayTabName(tab);
    button.title = tab.source?.path ?? tabName;
    button.innerHTML = `<span class="file-dot ${tab.source?.format ?? "text"}" aria-hidden="true"></span><span class="tab-name">${esc(tabName)}</span>${tab.dirty || tab.rightDirty ? '<span class="dirty-indicator" aria-label="Unsaved changes">●</span>' : ""}`;
    button.dataset.tabId = tab.id;
    button.onclick = () => controller.activate(tab.id);
    button.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        controller.activate(tab.id);
        return;
      }
      const target = neighbourTab(tab.id, event.key);
      if (!target) return;
      event.preventDefault();
      selectTabFromKeyboard(target, true);
    };
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${tabName}`);
    close.textContent = "×";
    close.onclick = (event) => {
      event.stopPropagation();
      void controller.close(tab.id);
    };
    item.append(button, close);
    root.append(item);
  }
}
function renderTools() {
  const nav = $(".tool-nav");
  const query = ($("#tool-search") as HTMLInputElement).value
    .trim()
    .toLowerCase();
  // The native manifest request completes after the first shell render. Include
  // the manifest identities in the cache key so the sidebar is rebuilt when
  // the engine catalog arrives; otherwise a native launch can be stuck showing
  // only the editor even though list_tools succeeded.
  const manifestKey = [...controller.manifests.values()]
    .map((manifest) => `${manifest.id}:${manifest.contractVersion}`)
    .sort()
    .join(",");
  const toolsKey = `${query}|${state.activeId}|${manifestKey}|${state.tabs.map((tab) => `${tab.id}:${tab.toolId}`).join(",")}`;
  if (toolsKey === renderedToolsKey) return;
  renderedToolsKey = toolsKey;
  nav.innerHTML = "";
  const visible = controller.availableTools().filter(
    (tool) =>
      !query || `${tool.label} ${tool.id}`.toLowerCase().includes(query),
  );
  if (!visible.length) {
    nav.innerHTML =
      '<p class="search-empty" role="status">No tools match your search.</p>';
    return;
  }
  const groups = new Map<string, ToolDefinition[]>();
  for (const tool of visible) {
    const list = groups.get(tool.group) ?? [];
    list.push(tool);
    groups.set(tool.group, list);
  }
  for (const [group, tools] of groups) {
    const section = document.createElement("section");
    section.className = "tool-group";
    const heading = document.createElement("div");
    heading.className = "group-label";
    heading.textContent = group;
    section.append(heading);
    for (const tool of tools) {
      const active =
        state.tabs.find((tab) => tab.id === state.activeId)?.toolId === tool.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tool-item${active ? " active" : ""}`;
      button.setAttribute("aria-current", String(active));
      button.setAttribute("aria-label", tool.label);
      button.innerHTML = `<span class="tool-item-icon" aria-hidden="true">${esc(tool.icon)}</span><span><strong>${esc(tool.label)}</strong><small>${esc(tool.operations.map((operation) => operation.label).join(" · ") || "New document")}</small></span>`;
      button.onclick = () => {
        if (!state.activeId) {
          if (tool.input === "image") {
            void controller.chooseFile();
            return;
          }
          controller.newDocument();
        }
        if (state.activeId) controller.selectTool(state.activeId, tool.id);
      };
      section.append(button);
    }
    nav.append(section);
  }
}
/* ------------------------------------------------------- Editor annotations */
let renderedAnnotationsKey = "";
// Highlights belong to the text they were computed for: a stale result (the text
// changed since) hides them until the next result lands, so nothing drifts.
function renderEditorAnnotations(tab: TabState, input: HTMLTextAreaElement, text: string) {
  const layer = $("#editor-highlight");
  const annotations = tab.result && !tab.resultStale && tab.result.event.ok ? (tab.result.event.annotations ?? []) : [];
  const show = annotations.length > 0 && tab.text !== null;
  const key = show ? `${tab.id}:${tab.result?.event.jobId}:${text.length}` : "";
  if (key === renderedAnnotationsKey && show === !layer.hidden) return;
  renderedAnnotationsKey = key;
  layer.hidden = !show;
  input.classList.toggle("annotated", show);
  if (!show) { layer.replaceChildren(); return; }
  // A trailing newline needs a visible line so the two scroll heights match.
  layer.innerHTML = annotationMarkup(text, annotations) + (text.endsWith("\n") ? " " : "");
  layer.scrollTop = input.scrollTop;
  layer.scrollLeft = input.scrollLeft;
}
function syncOverlay(source: HTMLElement, layer: HTMLElement) {
  source.addEventListener("scroll", () => {
    if (layer.hidden) return;
    layer.scrollTop = source.scrollTop;
    layer.scrollLeft = source.scrollLeft;
  }, { passive: true });
}
syncOverlay($("#preview"), $("#editor-highlight"));
syncOverlay($("#result-output"), $("#result-highlight"));
function renderOptions(tab: TabState, tool: ToolDefinition | undefined) {
  const host = $(".format-control");
  const optionsKey = `${tab.id}:${tab.toolId}:${tab.operation}:${JSON.stringify(tab.options)}:${tool?.id === "text.find-replace" ? tab.revision : ""}`;
  if (optionsKey === renderedOptionsKey) return;
  renderedOptionsKey = optionsKey;
  host.innerHTML = "";
  if (!tool?.operations.length) return;
  if (tool.id === "text.find-replace") {
    const query = document.createElement("input");
    query.type = "search";
    query.placeholder = "Find…";
    query.setAttribute("aria-label", "Find text");
    query.className = "find-query";
    query.value = tab.findQuery;
    const replacement = document.createElement("input");
    replacement.placeholder = "Replace with…";
    replacement.setAttribute("aria-label", "Replace text");
    replacement.className = "find-replacement";
    replacement.value = tab.findReplacement;
    const caseSensitive = document.createElement("label");
    caseSensitive.className = "check-option";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = tab.findCaseSensitive;
    caseSensitive.append(check, document.createTextNode("Aa"));
    const wholeWord = document.createElement("label");
    wholeWord.className = "check-option";
    const whole = document.createElement("input");
    whole.type = "checkbox";
    whole.checked = tab.findWholeWord;
    wholeWord.append(whole, document.createTextNode("Whole word"));
    const findButton = document.createElement("button");
    findButton.className = "outline-button";
    findButton.textContent = "Find";
    const replaceButton = document.createElement("button");
    replaceButton.className = "outline-button";
    replaceButton.textContent = "Replace all";
    const report = document.createElement("span");
    report.className = "find-report";
    const refresh = () => {
      try {
        const current = controller.tab(tab.id);
        const source = current?.text ?? current?.source?.preview ?? "";
        controller.findOptions(tab.id, {
          findQuery: query.value,
          findReplacement: replacement.value,
          findCaseSensitive: check.checked,
          findWholeWord: whole.checked,
        });
        const found = findMatches(source, query.value, {
          caseSensitive: check.checked,
          wholeWord: whole.checked,
        });
        report.textContent = `${found.matches.length}${found.truncated ? "+" : ""} match${found.matches.length === 1 ? "" : "es"}`;
        findButton.disabled = !found.matches.length;
        replaceButton.disabled = !found.matches.length;
        findButton.onclick = () => {
          const match = nextMatch(
            found.matches,
            (input as HTMLTextAreaElement).selectionStart,
            (input as HTMLTextAreaElement).selectionEnd,
          );
          if (match) {
            input.focus();
            (input as HTMLTextAreaElement).setSelectionRange(
              match.start,
              match.end,
            );
          }
        };
        replaceButton.onclick = () => {
          const latest = controller.tab(tab.id);
          const result = replaceAll(
            latest?.text ?? "",
            query.value,
            replacement.value,
            { caseSensitive: check.checked, wholeWord: whole.checked },
          );
          if (result.count) controller.edit(tab.id, result.text);
        };
      } catch (error) {
        report.textContent =
          error instanceof Error ? error.message : String(error);
      }
    };
    const input = $("#preview") as HTMLTextAreaElement;
    query.oninput = refresh;
    replacement.oninput = refresh;
    check.onchange = refresh;
    whole.onchange = refresh;
    host.append(
      query,
      replacement,
      caseSensitive,
      wholeWord,
      findButton,
      replaceButton,
      report,
    );
    refresh();
    return;
  }
  if (tool.id === "text.compare") {
    const label = document.createElement("label");
    label.className = "dynamic-option";
    label.textContent = "Newlines";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Compare newline handling");
    const newlineLabels: Record<string, string> = {
      preserve: "Preserve",
      lf: "Normalize to LF",
      cr_lf: "Normalize to CRLF",
      ignore: "Ignore line endings",
    };
    for (const value of ["preserve", "lf", "cr_lf", "ignore"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = newlineLabels[value];
      option.selected = value === tab.options.newline;
      select.append(option);
    }
    select.onchange = () =>
      controller.options(tab.id, tab.operation, {
        ...tab.options,
        newline: select.value,
      });
    label.append(select);
    host.append(label, granularityControl());
    return;
  }
  // The controls belong to the operation on screen: a sibling operation may
  // declare different options, and offering its choices produces runs that fail.
  const schema = optionSchemaFor(tool, tab.operation);
  if (schema.length) host.append(...optionControls(tab, schema));
}
/** Controls for a package tool's declared options: one dense control per option. */
function optionControls(tab: TabState, schema: readonly OptionSpec[]): HTMLElement[] {
  const set = (id: string, value: unknown) =>
    controller.options(tab.id, tab.operation, { ...tab.options, [id]: value });
  const controls: HTMLElement[] = [];
  for (const option of schema) {
    if (option.type === "boolean") {
      const label = document.createElement("label");
      label.className = "check-option";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = tab.options[option.id] === true;
      check.setAttribute("aria-label", option.label);
      check.onchange = () => set(option.id, check.checked);
      label.append(check, document.createTextNode(option.label));
      controls.push(label);
      continue;
    }
    if (option.type !== "enum" && option.type !== "string" && option.type !== "integer" && option.type !== "decimal") continue;
    const label = document.createElement("label");
    label.className = "dynamic-option";
    label.textContent = option.label;
    if (option.type === "enum") {
      const select = document.createElement("select");
      select.setAttribute("aria-label", option.label);
      for (const choice of option.choices) {
        const item = document.createElement("option");
        item.value = choice.id;
        item.textContent = choice.label;
        item.selected = choice.id === (tab.options[option.id] ?? option.default);
        select.append(item);
      }
      select.onchange = () => set(option.id, select.value);
      label.append(select);
    } else {
      const input = document.createElement("input");
      const numeric = option.type !== "string";
      // A sensitive option (a signing key, a secret) is masked and never
      // offered to autofill; its value lives only in the tab's options.
      input.type = numeric ? "number" : option.sensitive ? "password" : "text";
      if (option.sensitive) input.autocomplete = "off";
      input.setAttribute("aria-label", option.label);
      const current = tab.options[option.id];
      input.value = current === undefined ? String(option.default) : String(current);
      if (numeric) {
        if (option.minimum !== undefined) input.min = option.minimum;
        if (option.maximum !== undefined) input.max = option.maximum;
        if (option.type === "integer") input.step = "1";
      }
      input.onchange = () => set(option.id, numeric ? Number(input.value) : input.value);
      label.append(input);
    }
    controls.push(label);
  }
  return controls;
}
/* ------------------------------------------------------- Diff & Compare */
let compareWorkspace: CompareWorkspace | null = null;
function compareSurface(): CompareWorkspace {
  if (compareWorkspace) return compareWorkspace;
  // Handlers capture the tab id at event time: a file dialog may resolve after
  // the user has switched tabs, and the result must land in the original tab.
  compareWorkspace = mountCompareWorkspace($("#tool-source"), {
    input(side, area) {
      const id = state.activeId;
      if (!id) return;
      compareMeta(id)[side].issue = null;
      if (side === "left") controller.edit(id, area.value);
      else controller.right(id, area.value);
    },
    paste(side, event, area) {
      const id = state.activeId;
      const text = event.clipboardData?.getData("text/plain");
      if (!id || side !== "left" || text === undefined) return;
      // Route left pastes through the import transaction so oversized clipboard
      // text becomes a host snapshot instead of being rejected by the editor.
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      const previous = controller.tab(id)?.text;
      compareMeta(id).left.issue = null;
      void controller.paste(id, text, start, end).then(() => {
        const current = controller.tab(id);
        if (state.activeId !== id || current?.text === null || current?.text === previous) return;
        const caret = Math.min(start + text.length, current?.text?.length ?? 0);
        area.setSelectionRange(caret, caret);
      });
    },
    open(side) {
      if (state.activeId) void openCompareSource(state.activeId, side);
    },
    clipboard(side) {
      if (state.activeId) void pasteCompareSource(state.activeId, side);
    },
    clear(side) {
      const id = state.activeId;
      if (!id) return;
      compareMeta(id)[side] = emptySide();
      if (side === "left") controller.edit(id, "");
      else controller.right(id, "", null);
      render();
    },
  });
  return compareWorkspace;
}
const sideName = (side: CompareSide) => SIDE_TITLES[side].toLowerCase();
function compareSideView(tab: TabState, side: CompareSide, meta: CompareMeta): CompareSideView {
  const source = meta[side];
  const text = side === "left" ? (tab.text ?? tab.source?.preview ?? "") : tab.rightText;
  const readOnly = side === "left" ? tab.text === null || tab.phase === "importing" : false;
  const documentName = side === "left" && (tab.source || tab.savedPath) ? tab.name : null;
  const label = source.label ?? (text ? (documentName ?? "Unsaved text") : "No source");
  const dirty = side === "right"
    ? tab.rightBaseline !== null && text !== tab.rightBaseline
    : source.label !== null
      ? source.baseline !== null && text !== source.baseline
      : documentName !== null && tab.dirty;
  const size = side === "left" && tab.text === null ? tab.source?.size : byteLength(text);
  const lines = lineCount(text);
  return {
    label,
    dirty,
    text,
    readOnly,
    meta: readOnly && tab.source
      ? `${bytes(tab.source.size)} · read-only preview`
      : `${lines} line${lines === 1 ? "" : "s"} · ${bytes(size)}`,
    issue: source.issue,
  };
}
/** Empty-side gate shared by the actions, the status line and the host
 * boundary. Only emptiness matters here, so character counts stand in for
 * byte sizes and a 1 MiB side is not re-encoded on every render. */
function compareProblem(tab: TabState): string | null {
  const leftSize = tab.text !== null ? tab.text.length : tab.source?.size;
  return compareInputProblem(leftSize, tab.rightText.length);
}
function compareStatus(tab: TabState): { text: string; tone: "" | "compare-gate" | "compare-ok" } {
  const problem = compareProblem(tab);
  if (problem) return { text: problem, tone: "compare-gate" };
  if (tab.phase === "queued" || tab.phase === "running")
    return { text: "Comparing the complete text of both sides…", tone: "" };
  const result = tab.result;
  if (result?.event.ok && result.text) {
    const meta = compareMeta(tab.id);
    if (meta.statusFor !== result) {
      const model = parseCompareResult(result.text);
      const description = model ? describeCompare(model) : null;
      meta.statusFor = result;
      meta.status = description ? `${description.headline} · ${description.detail}` : "";
    }
    if (meta.status)
      return {
        text: `${meta.status}${staleNote(tab)}`,
        tone: meta.status.startsWith("No differences") ? "compare-ok" : "",
      };
  }
  return { text: "Two sources · Editable up to 1 MiB each · Compare runs after you edit either side", tone: "" };
}
async function openCompareSource(id: string, side: CompareSide) {
  const meta = compareMeta(id);
  if (!native) {
    meta[side].issue = "Open the desktop app to read local files.";
    render();
    return;
  }
  let opened: FileDocument | undefined;
  try {
    const path = await chooseFile();
    if (!path) return;
    opened = await openDocument(path);
    const text = await controller.readEditable(opened);
    if (text === null)
      throw new Error(`Choose a UTF-8 text file up to 1 MiB for the ${sideName(side)} editor.`);
    const tab = controller.tab(id);
    if (!tab) return;
    if (side === "left" && tab.text === null)
      throw new Error("The left side is a read-only preview. Open a smaller file in a new tab to edit it.");
    meta[side] = { label: opened.name, baseline: text, issue: null };
    if (side === "left") controller.edit(id, text);
    else controller.right(id, text, text);
    notify(`Opened ${opened.name} as ${sideName(side)}`);
  } catch (error) {
    meta[side].issue = errorText(error);
  } finally {
    // The side keeps its own copy; the host handle is only needed for the read.
    if (opened) void closeDocument(opened.id).catch(() => undefined);
    render();
  }
}
async function pasteCompareSource(id: string, side: CompareSide) {
  const meta = compareMeta(id);
  try {
    const text = await navigator.clipboard.readText();
    const tab = controller.tab(id);
    if (!tab) return;
    if (!text) throw new Error("The clipboard has no text to paste.");
    if (side === "left" && tab.text === null)
      throw new Error("The left side is a read-only preview. Open a smaller file in a new tab to edit it.");
    // The clipboard becomes the whole source for that side.
    meta[side] = emptySide();
    if (side === "left") await controller.paste(id, text, 0, (tab.text ?? "").length);
    else controller.right(id, text, null);
  } catch (error) {
    meta[side].issue = errorText(error);
  } finally {
    render();
  }
}
function swapCompareSources(id: string) {
  const tab = controller.tab(id);
  if (!tab) return;
  if (tab.text === null) {
    notify("Swap needs an editable left side. This tab shows a read-only file preview.");
    return;
  }
  const meta = compareMeta(id);
  const leftView = compareSideView(tab, "left", meta);
  const rightView = compareSideView(tab, "right", meta);
  const documentName = tab.source || tab.savedPath ? tab.name : null;
  const previousLeft: CompareSourceMeta = {
    label: meta.left.label ?? (leftView.text ? documentName : null),
    baseline: meta.left.label !== null ? meta.left.baseline : documentName ? tab.savedText : null,
    issue: null,
  };
  meta.left = { label: meta.right.label ?? (rightView.text ? "Unsaved text" : null), baseline: meta.right.baseline, issue: null };
  meta.right = previousLeft;
  const left = tab.text;
  const right = tab.rightText;
  controller.right(id, left, previousLeft.baseline);
  controller.edit(id, right);
  render();
  notify("Swapped the left and right sources");
}
function renderSources(tab: TabState, tool: ToolDefinition | undefined) {
  const host = $("#tool-source");
  if (!tool?.compare) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const meta = compareMeta(tab.id);
  compareSurface().update({
    left: compareSideView(tab, "left", meta),
    right: compareSideView(tab, "right", meta),
  });
}
function renderInput(tab: TabState, tool: ToolDefinition | undefined) {
  const image = $("#input-image") as HTMLImageElement;
  const wrap = $("#input-image-wrap");
  const input = $("#preview") as HTMLTextAreaElement;
  const message = $("#input-message");
  const messageText = $("#input-message-text");
  const openCompatible = $("#input-open-compatible") as HTMLButtonElement;
  const empty = $("#empty-state");
  const imageInput = tab.source?.contentKind === "image";
  const binaryInput = tab.source?.contentKind === "binary";
  const imageTool = tool?.input === "image";
  const quickActions = $(".input-quick-actions") as HTMLElement;
  empty.hidden = true;
  $("#editor-host").hidden = !!tool?.compare;
  wrap.hidden = !imageInput;
  input.hidden =
    imageInput || binaryInput || !!tool?.compare || tool?.input === "image";
  message.hidden = !(binaryInput || (tool?.input === "image" && !imageInput));
  quickActions.hidden = imageTool || binaryInput || !!tool?.compare;
  openCompatible.hidden = true;
  openCompatible.onclick = () => void controller.chooseFile();
  if (binaryInput)
    messageText.textContent =
      "Binary file · Choose a compatible tool such as Hash generator. Text editing is unavailable for this file.";
  else if (imageTool && !imageInput) {
    const detected = tab.source?.contentKind === "text"
      ? `This tab contains ${tab.source.format.toUpperCase()} text.`
      : "This tab does not contain an image.";
    messageText.textContent = `${detected} Open a PNG or JPEG image to use Image to Base64.`;
    openCompatible.hidden = false;
  } else if (imageInput && !tab.image) {
    messageText.textContent = tab.imageError ?? "Loading image preview…";
  }
  $("#source-mode").textContent =
    tab.text !== null
      ? tab.dirty
        ? "EDITING"
        : "TEXT"
      : tab.source
        ? "READ ONLY"
        : "NEW";
  if (imageInput) {
    input.value = "";
    if (tab.image) {
      if (image.getAttribute("src") !== tab.image.data)
        image.src = tab.image.data;
      image.alt = `${tab.image.mime} image preview`;
      message.hidden = true;
    } else {
      image.removeAttribute("src");
      message.hidden = false;
      messageText.textContent = tab.imageError ?? "Loading image preview…";
    }
  } else if (!tool?.compare) {
    const text = tab.text ?? tab.source?.preview ?? "";
    if (input.value !== text) input.value = text;
    renderEditorAnnotations(tab, input, text);
    input.readOnly = tab.text === null || tab.phase === "importing";
    input.disabled = false;
    input.oninput = () => controller.edit(tab.id, input.value);
    input.onselect = () => updateCaretStatus(tab);
    input.onkeyup = () => updateCaretStatus(tab);
    input.onclick = () => updateCaretStatus(tab);
    input.onpaste = (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const previous = tab.text;
      void controller.paste(tab.id, text, start, end).then(() => {
        const current = controller.tab(tab.id);
        if (
          state.activeId !== tab.id ||
          current?.text === null ||
          current?.text === previous
        )
          return;
        const caret = Math.min(start + text.length, current?.text?.length ?? 0);
        input.setSelectionRange(caret, caret);
      });
    };
  }
  $("#preview-heading").textContent = tool?.compare
    ? "Sources"
    : tab.text !== null
      ? "Document"
      : "Input";
  $("#preview-meta").textContent = tool?.compare
    ? "Left and right stay separate · Files remain unchanged"
    : tab.source
      ? `${bytes(tab.source.size)} · ${tab.source.mime ?? tab.source.format.toUpperCase()}`
      : "Unsaved document";
  const limit = $("#preview-limit");
  const status = tool?.compare ? compareStatus(tab) : null;
  limit.classList.toggle("compare-gate", status?.tone === "compare-gate");
  limit.classList.toggle("compare-ok", status?.tone === "compare-ok");
  limit.title = status?.text ?? "";
  limit.textContent = status
    ? status.text
    : tab.phase === "importing"
      ? "Importing complete pasted input…"
      : tab.pasted && tab.text === null
        ? `Preview of ${bytes(tab.source?.size)} pasted input · Tools process all bytes · Ctrl+A then paste to replace`
        : tab.source?.editable
          ? "Editable UTF-8 document · Ctrl+S to save"
          : tab.source
            ? "Read-only bounded preview · Full-file processing"
            : "Editable blank document";
  $("#encoding").textContent = tab.source?.encoding ?? "UTF-8";
  $("#source-name").textContent = displayTabName(tab);
  $("#source-size").textContent = tab.source ? bytes(tab.source.size) : "—";
  $("#source-format").textContent =
    tab.source?.contentKind === "text"
      ? tab.source.format.toUpperCase()
      : (tab.source?.contentKind.toUpperCase() ?? "TEXT");
}
function renderActions(tab: TabState, tool: ToolDefinition | undefined) {
  const host = $(".toolbar-actions");
  const gate = tool?.compare ? `${compareProblem(tab) ?? ""}:${tab.text === null}` : "";
  const actionsKey = `${tab.id}:${tab.toolId}:${tab.operation}:${tab.phase}:${tool ? (validation(tab, tool) ?? "") : ""}:${gate}`;
  if (actionsKey === renderedActionsKey) return;
  renderedActionsKey = actionsKey;
  host.innerHTML = "";
  if (!tool?.operations.length) return;
  if (tool.id === "text.find-replace") return;
  if (tool.compare) {
    const busy = tab.phase === "queued" || tab.phase === "importing" || tab.phase === "running";
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "outline-button";
    swap.textContent = "Swap";
    swap.title = tab.text === null
      ? "Swap needs an editable left side."
      : "Exchange the left and right sources and their labels";
    swap.disabled = tab.text === null || tab.phase === "importing";
    swap.onclick = () => swapCompareSources(tab.id);
    const problem = validation(tab, tool) ?? compareProblem(tab);
    const compare = document.createElement("button");
    compare.type = "button";
    compare.className = "primary-button";
    compare.textContent = "Compare";
    compare.title = problem ?? "Compare both sides (runs automatically after edits)";
    compare.disabled = busy || !!problem;
    compare.onclick = () => controller.options(tab.id, "compare", { ...tab.options }, true);
    host.append(swap, compare);
    return;
  }
  for (const operation of tool.operations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      operation.id === tab.operation ? "primary-button" : "outline-button";
    button.textContent = operation.label;
    button.disabled =
      tab.phase === "queued" ||
      tab.phase === "importing" ||
      tab.phase === "running" ||
      !!validation(tab, tool);
    button.onclick = () =>
      controller.options(tab.id, operation.id, { ...tab.options }, true);
    host.append(button);
  }
}
function readableSummary(summary: unknown): string {
  if (typeof summary !== "string")
    return JSON.stringify(summary ?? {}, null, 2);
  try {
    const value = JSON.parse(summary) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.entries(value as Record<string, unknown>)
        .map(
          ([key, item]) =>
            `${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
        )
        .join("\n");
  } catch {
    /* plain text summary */
  }
  return summary;
}
function friendlyError(tab: TabState, event: NonNullable<TabState["result"]>["event"]): string {
  const error = event.error ?? "Operation failed";
  if (tab.toolId === "encoding.base64-image" && /base64|multiple of four|alphabet/i.test(error))
    return "Invalid Base64 input. Paste a complete Base64 string or a data URI, then try Decode again.";
  if (tab.toolId === "structured.csv" && /CSV record|field|row/i.test(error))
    return "CSV inspection failed. Check that every row has the same number of columns and that quoted values are balanced.";
  return error;
}
/** Which view each tab is reading its result in, and the path it last typed. */
const treeState = new Map<string, { view: "text" | "tree"; query: string }>();
const treeFor = (id: string) => {
  let state = treeState.get(id);
  if (!state) { state = { view: "text", query: "" }; treeState.set(id, state); }
  return state;
};

/**
 * Parse a result as JSON, or say it is not. A result that does not parse has no
 * tree: the toggle is hidden rather than offering a view that cannot be built.
 */
function parsedResult(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed || !"{[\"-0123456789tfn".includes(trimmed[0]!)) return { ok: false };
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch { return { ok: false }; }
}

/** Draw the tree for the active tab, applying its query if it has one. */
function renderTree(tabId: string, value: unknown): void {
  const state = treeFor(tabId);
  const body = $("#tree-body");
  const status = $("#tree-path-status");
  status.classList.remove("tree-path-error");
  const copyPath = (path: string) => {
    void navigator.clipboard.writeText(path).then(
      () => notify(`Copied ${path}`),
      (error: unknown) => notify(errorText(error)),
    );
  };
  if (!state.query.trim()) {
    const top = renderJsonTree(body, value, { onCopyPath: copyPath });
    status.textContent = top === 1 ? "1 entry" : `${top} entries`;
    return;
  }
  try {
    const { matches, truncated } = evaluateJsonPath(value, state.query);
    renderMatches(body, matches, { onCopyPath: copyPath });
    status.textContent = matches.length === 0
      ? "no matches"
      : `${matches.length}${truncated ? "+" : ""} match${matches.length === 1 ? "" : "es"}`;
    if (!matches.length) status.classList.add("tree-path-error");
  } catch (error) {
    // A path the evaluator does not implement is reported as such: an empty list
    // would read as "nothing matched", which is a different fact entirely.
    body.replaceChildren();
    status.textContent = error instanceof JsonPathError ? error.message : errorText(error);
    status.classList.add("tree-path-error");
  }
}

function renderResult(tab: TabState) {
  const result = tab.result;
  const empty = $("#result-empty");
  const content = $("#result-content");
  if (!result) {
    renderedResult = null;
    renderedStaleNote = "";
    $("#copy-result").hidden = true;
    $("#copy-image").hidden = true;
    $("#open-result").hidden = true;
    $("#save-result").hidden = true;
    $("#result-highlight").hidden = true;
    $("#result-status-message").hidden = true;
    empty.hidden = false;
    content.hidden = true;
    const tool = controller.toolDefinition(tab.toolId);
    const problem = tool
      ? validation(tab, tool, controller.manifests.get(tool.id))
      : null;
    const title = $("#result-empty-title");
    const text = $("#result-empty-text");
    if (problem) {
      title.textContent = "Input needs attention";
      text.textContent = problem;
    } else if (tool?.compare) {
      const gate = compareProblem(tab);
      if (gate) {
        title.textContent = "Both sources are needed";
        text.textContent = gate;
      } else if (tab.error) {
        title.textContent = "Compare could not run";
        text.textContent = tab.error;
      } else if (tab.phase === "queued" || tab.phase === "running") {
        title.textContent = "Comparing…";
        text.textContent = "Line changes appear here as soon as the comparison completes.";
      } else {
        title.textContent = "Ready to compare";
        text.textContent = "Compare runs after you edit either side, or press Compare.";
      }
    } else if (tool?.input === "image") {
      title.textContent = "Open an image to begin";
      text.textContent =
        "PNG and JPEG files are supported. The encoded result will appear here automatically.";
    } else if (tool?.operations.length) {
      title.textContent = "Ready when you are";
      text.textContent = `Run ${tool.operations.map((operation) => operation.label).join(", ")} to see the result here.`;
    } else {
      title.textContent = "Tools at your fingertips";
      text.textContent =
        "Choose a tool on the left. Your document stays in this tab, and the result appears here.";
    }
    return;
  }
  const view = treeFor(tab.id);
  const viewKey = `${tab.id}:${view.view}:${view.query}`;
  if (result === renderedResult && staleNote(tab) === renderedStaleNote && viewKey === renderedView)
    return;
  renderedResult = result;
  renderedStaleNote = staleNote(tab);
  renderedView = viewKey;
  empty.hidden = true;
  content.hidden = false;
  const event = result.event;
  const stateNode = $("#result-state");
  const readable = event.ok && !result.previewError;
  stateNode.className = `result-state ${readable ? "ok" : event.cancelled ? "cancelled" : "failed"}`;
  stateNode.textContent = result.previewError
    ? `Could not load result: ${result.previewError}`
    : event.ok
    ? "✓ Completed successfully"
    : event.cancelled
      ? "○ Cancelled"
      : `● ${friendlyError(tab, event)}`;
  stateNode.textContent += staleNote(tab);
  $("#result-summary").textContent = readableSummary(event.summary);
  $("#result-metrics").innerHTML = [
    ["Elapsed", `${event.elapsedMs} ms`],
    ["Input", bytes(event.inputBytes)],
    // For a byte tool the two readings differ (a BOM, CRLF), so say which one it was.
    ...(result.inputFrom
      ? [["Read", result.inputFrom === "file" ? "the file's bytes" : "the text, as UTF-8"]]
      : []),
    ["Output", bytes(event.outputBytes)],
    ["Status", event.ok ? "Ready to review" : "No output"],
  ]
    .map(([key, value]) => `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`)
    .join("");
  const media = $("#result-media");
  media.innerHTML = "";
  const structured = $("#result-structured");
  structured.replaceChildren();
  structured.classList.remove("diff-result");
  const output = $("#result-output") as HTMLTextAreaElement;
  const highlight = $("#result-highlight");
  const statusMessage = $("#result-status-message");
  const framed = event.ok && event.renderer === "preview";
  const vector = event.ok && event.renderer === "svg";
  const binary = !!result.image || framed || vector;
  let diff = false;
  if (!binary && event.renderer === "diff" && event.ok) {
    // A truncated preview never parses; it falls back to the bounded raw text
    // below rather than pretending to be a complete diff.
    const model = parseCompareResult(result.text);
    if (model) {
      const meta = compareMeta(tab.id);
      if (meta.changeResult !== result) {
        meta.changeResult = result;
        meta.change = -1;
      }
      renderCompareResult(structured, {
        result: model,
        raw: result.text,
        current: meta.change,
        stats: `${event.elapsedMs} ms · in ${bytes(event.inputBytes)} · out ${bytes(event.outputBytes)}`,
        onNavigate: (index) => {
          meta.change = index;
        },
      });
      diff = true;
    }
  }
  structured.hidden = !diff;
  media.hidden = !binary;
  $(".result-preview-block").classList.toggle("binary-output", binary);
  media.classList.toggle("preview-stage", framed);
  if (result.image) {
    const image = document.createElement("img");
    image.className = "binary-preview";
    image.src = result.image.data;
    image.alt = `${result.image.mime} result preview`;
    media.append(image);
  } else if (framed) {
    // The document is shown in a frame with every sandbox permission withheld: no
    // scripts, forms, navigation or same-origin access, and no network beyond the
    // shell's own CSP. The text stays behind Copy and Save unchanged.
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "Rendered preview";
    frame.srcdoc = result.text;
    media.append(frame);
  } else if (vector) {
    const image = document.createElement("img");
    image.className = "binary-preview";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.text)}`;
    image.alt = "SVG result preview";
    media.append(image);
  }
  output.hidden = binary || diff;
  output.classList.toggle(
    "json-output",
    !binary && !diff && event.renderer === "json",
  );
  if (!binary && !diff && event.renderer === "json") {
    highlight.hidden = false;
    highlight.innerHTML = result.text.replace(
      /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*"\s*)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
      (token, key, string, number, literal) => {
        const kind = key
          ? "json-key"
          : string
            ? "json-string"
            : number
              ? "json-number"
              : `json-${literal}`;
        return `<span class="${kind}">${esc(token)}</span>`;
      },
    );
  } else {
    highlight.hidden = true;
    highlight.replaceChildren();
  }
  // A result that parses as JSON can also be walked as a tree. The toggle appears
  // only then, so it never offers a view that cannot be built.
  const parsed = !binary && !diff && event.ok ? parsedResult(result.text) : { ok: false as const };
  const treeable = parsed.ok && !result.truncated;
  const views = $("#result-views");
  views.hidden = !treeable;
  if (!treeable && view.view === "tree") view.view = "text";
  const showTree = treeable && view.view === "tree";
  $("#view-text").setAttribute("aria-pressed", String(!showTree));
  $("#view-tree").setAttribute("aria-pressed", String(showTree));
  ($("#tree-path") as HTMLInputElement).value = view.query;
  $("#tree-panel").hidden = !showTree;
  if (showTree && parsed.ok) renderTree(tab.id, parsed.value);
  else $("#tree-body").replaceChildren();

  const noOutput =
    event.ok && !event.resultDocumentId && !result.text && !binary && !diff;
  $(".result-code").hidden = !readable || binary || diff || noOutput || showTree;
  statusMessage.hidden = !noOutput;
  statusMessage.textContent = noOutput
    ? event.operationId === "inspect"
      ? "✓ Input is valid. Review the operation details for the inspection summary."
      : "✓ Operation completed without a generated output document."
    : "";
  if (noOutput) output.hidden = true;
  if (output.value !== result.text) output.value = result.text;
  output.wrap = result.text.length > 2_000 ? "soft" : "off";
  $("#result-output-meta").textContent =
    result.previewError ??
    (result.truncated
      ? `Preview: ${bytes(new TextEncoder().encode(result.text).length)} of ${bytes(event.outputBytes)} · Copy button or Ctrl+A/Ctrl+C copies complete result`
      : event.ok
        ? "Complete result"
        : "No result");
  $("#copy-result").hidden =
    tab.resultStale || !event.ok || !!result.image || !result.text;
  $("#copy-result").textContent = event.renderer === "svg" ? "Copy SVG" : "Copy complete result";
  // A picture copies as a picture: a binary image, or an SVG drawn to PNG.
  $("#copy-image").hidden =
    tab.resultStale || !event.ok || !(result.image || (event.renderer === "svg" && result.text && !result.truncated));
  $("#open-result").hidden =
    tab.resultStale || !event.ok || !!result.image || !event.resultDocumentId;
  $("#save-result").hidden =
    tab.resultStale || !event.ok || !event.resultDocumentId;
}
function updateCaretStatus(tab: TabState | undefined) {
  const input = $("#preview") as HTMLTextAreaElement;
  const value = input.value ?? "";
  const offset = Math.max(0, Math.min(input.selectionStart ?? value.length, value.length));
  const before = value.slice(0, offset);
  const lines = before.split(/\n/);
  $("#status-position").textContent = `Ln ${lines.length}, Col ${(lines.at(-1)?.length ?? 0) + 1}`;
  $("#status-encoding").textContent = tab?.source?.encoding ?? "UTF-8";
  const tool = tab ? controller.toolDefinition(tab.toolId) : undefined;
  $("#status-format").textContent = tab?.source?.format?.toUpperCase() ?? (tool?.input === "image" ? "IMAGE" : "TEXT");
  const gated = !!tab && !!tool?.compare && !!compareProblem(tab);
  const validity = (tab?.error && !gated) || tab?.result?.previewError
    ? "Error"
    : tab?.phase === "running" || tab?.phase === "queued"
      ? "Processing"
      : tab?.result?.event.ok
        ? "Valid"
        : tab
          ? "Ready"
          : "No document";
  $("#status-validity").textContent = validity;
}
function renderWorkspaceLayout(tab: TabState | undefined, tool: ToolDefinition | undefined) {
  const workspace = $("#document-panel");
  const resultPane = $(".results-pane") as HTMLElement;
  const splitter = $("#workspace-splitter") as HTMLElement;
  const hasResult = !!tab?.result;
  const compare = !!tool?.compare;
  const meta = tab && compare ? compareMeta(tab.id) : null;
  if (meta && hasResult) meta.hadResult = true;
  // The result pane appears with the first result and then stays, so clearing
  // a side while comparing does not bounce the editors between two heights.
  const showResult = !!tab && (hasResult || !!meta?.hadResult) && !collapsedResults.has(tab.id);
  workspace.classList.toggle("compare-layout", compare);
  workspace.style.setProperty("--split-position", `${Math.round((compare ? compareSplitRatio : splitRatio) * 100)}%`);
  workspace.classList.toggle("result-absent", !showResult);
  workspace.classList.toggle("result-collapsed", !!tab && !showResult && (hasResult || !!meta?.hadResult));
  resultPane.hidden = !showResult;
  splitter.hidden = !showResult;
  splitter.setAttribute("aria-orientation", splitIsVertical() ? "horizontal" : "vertical");
  const toggle = $("#result-toggle") as HTMLButtonElement;
  toggle.hidden = !(hasResult || !!meta?.hadResult);
  toggle.textContent = showResult ? "Hide result" : "Show result";
  toggle.setAttribute("aria-expanded", String(showResult));
  const collapse = $("#result-collapse") as HTMLButtonElement;
  collapse.setAttribute("aria-label", showResult ? "Collapse result pane" : "Show result pane");
  collapse.title = showResult ? "Collapse result pane" : "Show result pane";
  collapse.textContent = showResult ? "›" : "‹";
  updateCaretStatus(tab);
}
function render() {
  const tab = activeTab(state);
  renderTabs();
  renderTools();
  const tool = tab ? controller.toolDefinition(tab.toolId) : undefined;
  $(".app-title").textContent = tool?.label ?? "DevTools Pro";
  $("#document-panel").classList.toggle(
    "single-pane",
    tool?.id === "editor.text" || tool?.id === "text.find-replace",
  );
  $("#active-tool-icon").textContent = tool?.icon ?? "Aa";
  $("#active-tool-label").textContent = (
    tool?.group ?? "WORKSPACE"
  ).toUpperCase();
  $("#active-tool-title").textContent =
    tool?.label ?? "Create or open a document";
  $("#active-tool-subtitle").textContent = tool
    ? "Choose an operation or edit the document in place."
    : "Press Ctrl+N for a blank document or choose a file.";
  // Operation failures already have a result diagnostic. Other errors use the
  // fixed source footer so toggling them never pushes the document down.
  // The compare gate is guidance, not a failure: the status line explains the
  // empty side in place, so the red diagnostic stays for real errors.
  const gated = !!tab && !!tool?.compare && !!compareProblem(tab);
  const sourceError = !!tab?.error && (!tab.result || tab.resultStale) && !gated;
  $("#error").hidden = !sourceError;
  $("#error").textContent = tab?.error ?? "";
  $("#error").title = tab?.error ?? "";
  $("#preview-limit").hidden = sourceError;
  const save = $("#save-document") as HTMLButtonElement;
  save.disabled = !tab || tab.phase === "importing";
  // The button says whether it will ask: a tab with a file saves straight to it.
  const target = tab ? controller.saveTarget(tab.id) : null;
  const saveLabel = target ? "Save" : "Save as…";
  if (save.textContent?.trim() !== saveLabel) save.textContent = saveLabel;
  save.title = target
    ? `Save to ${target.split(/[\\/]/).pop()} (Ctrl+S) · Save as: Ctrl+Shift+S`
    : "Save as (Ctrl+S)";
  jobIndicator.update(tab && (tab.phase === "queued" || tab.phase === "running")
    ? `${tab.id}:${tab.generation}` : null);
  if (tab) {
    renderOptions(tab, tool);
    renderSources(tab, tool);
    renderInput(tab, tool);
    renderActions(tab, tool);
    renderResult(tab);
    $("#job-panel").title =
      `${tool?.label ?? "Processing"} · ${displayTabName(tab)}`;
    $("#job-phase").textContent =
      tab.phase === "queued"
        ? "Queued…"
        : (tab.progress?.phase ?? "Processing…");
    const progress = $("#job-progress") as HTMLProgressElement;
    progress.value = tab.progress?.totalBytes
      ? Math.min(
          100,
          (tab.progress.bytesProcessed / tab.progress.totalBytes) * 100,
        )
      : 0;
    progress.title = tab.progress
      ? `${bytes(tab.progress.bytesProcessed)} of ${bytes(tab.progress.totalBytes)}`
      : "Starting…";
  } else {
    $("#editor-host").hidden = false;
    $("#tool-source").hidden = true;
    $(".format-control").replaceChildren();
    $(".toolbar-actions").replaceChildren();
    $("#empty-state").hidden = false;
    $("#preview").hidden = true;
    $("#input-image-wrap").hidden = true;
    $("#input-message").hidden = true;
    $("#result-empty").hidden = false;
    $("#result-content").hidden = true;
  }
  renderWorkspaceLayout(tab, tool);
}
function commands() {
  const list = $("#command-list");
  list.innerHTML = "";
  const actions = [
    { label: "New document", run: () => controller.newDocument() },
    { label: "Open file", run: () => void controller.chooseFile() },
    ...(state.activeId
      ? [
          { label: "Save", run: () => void controller.save(state.activeId!) },
          { label: "Save as…", run: () => void controller.save(state.activeId!, { as: true }) },
        ]
      : []),
    ...state.tabs.flatMap((tab) =>
      controller.availableTools()
        .filter((tool) => tool.id !== "editor.text")
        .map((tool) => ({
          label: `${tool.label} · ${displayTabName(tab)}`,
          run: () => {
            controller.activate(tab.id);
            controller.selectTool(tab.id, tool.id);
          },
        })),
    ),
  ];
  actions
    .filter(
      (action) =>
        !paletteSearch.value ||
        action.label.toLowerCase().includes(paletteSearch.value.toLowerCase()),
    )
    .forEach((action, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "option";
      button.id = `command-${index}`;
      button.textContent = action.label;
      button.onclick = () => {
        closePalette();
        action.run();
      };
      list.append(button);
    });
}
function openPalette(opener?: HTMLElement) {
  paletteOpener = opener ?? (document.activeElement as HTMLElement);
  commands();
  palette.showModal();
  paletteSearch.focus();
}
function closePalette() {
  if (palette.open) palette.close();
  paletteOpener?.focus();
  paletteOpener = null;
}
const hooks = {
  changed(next: WorkspaceState) {
    const switched = state?.activeId !== next.activeId;
    state = next;
    for (const id of compareMetas.keys())
      if (!next.tabs.some((tab) => tab.id === id)) compareMetas.delete(id);
    render();
    if (switched && activeTab(state)?.text !== null) {
      const input = $(
        controller.toolDefinition(activeTab(state)?.toolId ?? "")?.compare
          ? "#compare-left"
          : "#preview",
      ) as HTMLTextAreaElement;
      if (!input.hidden) input.focus();
    }
  },
  notify,
  confirmClose: promptClose,
};
// Compare must see two non-empty sources. The controller snapshots each side
// into a host document before it can ask for a job, so the gate sits on the
// host boundary and fails the run with the same message the workspace shows.
const documentSizes = new Map<string, number>();
const remember = (document: FileDocument) => {
  documentSizes.set(document.id, document.size);
  return document;
};
const api: WorkbenchApi = {
  native,
  chooseFile,
  chooseFiles,
  chooseDocumentOutput,
  chooseResultOutput,
  openDocument: (path) => openDocument(path).then(remember),
  createTextDocument: (text, name, format) =>
    createTextDocument(text, name, format).then(remember),
  closeDocument: (id) => {
    documentSizes.delete(id);
    return closeDocument(id);
  },
  readPreview,
  readBinaryPreview,
  saveDocument,
  saveResult,
  runTool,
  runCompare: (left, right, options) => {
    const problem = compareInputProblem(documentSizes.get(left), documentSizes.get(right));
    return problem ? Promise.reject(new Error(problem)) : runCompare(left, right, options);
  },
  cancelOperation,
  jobStatus,
  subscribeJobs,
  listTools,
};
// Package tools run on the webview's worker engine behind the same API; the
// native host keeps every id it serves itself.
const engine = new WorkerEngine(api);
controller = new WorkbenchController(engine.wrap(api), hooks);
// Under test (a debug host started with DEVTOOLS_TEST_HOOKS), expose the two things a
// script cannot do for itself: name the file a dialog would have returned, and open a
// path directly. Everything after that is the same code a person drives.
if ((globalThis as Record<string, unknown>).__DEVTOOLS_TEST_HOOKS__ === true) {
  (globalThis as Record<string, unknown>).devtoolsTest = {
    openPath: (path: string, toolId?: string) => controller.openPath(path, toolId),
    // What a native drop hands the shell, minus the drag: the OS gesture cannot be scripted.
    dropPaths: (paths: string[]) => dropPaths(paths),
    presetDialogPaths,
  };
}
state = controller.state;
$("#new-document").onclick = () => controller.newDocument();
$("#empty-new").onclick = () => controller.newDocument();
$("#open-file").onclick = () => void controller.chooseFile();
$("#empty-open").onclick = () => void controller.chooseFile();
$("#save-document").onclick = () => {
  if (state.activeId) void controller.save(state.activeId);
};
$("#input-clipboard").onclick = () => {
  const id = state.activeId;
  const input = $("#preview") as HTMLTextAreaElement;
  if (!id || input.hidden) return;
  navigator.clipboard
    .readText()
    .then((text) =>
      controller.paste(id, text, input.selectionStart, input.selectionEnd),
    )
    .catch((error) =>
      notify(error instanceof Error ? error.message : String(error)),
    );
};
$("#input-clear").onclick = () => {
  const tab = activeTab(state);
  if (tab && tab.text !== null) controller.edit(tab.id, "");
};
$("#input-sample").onclick = () => {
  const tab = activeTab(state);
  if (!tab || tab.text === null) return;
  const samples: Record<string, string | null> = {
    "structured.json":
      '{"store":{"book":[{"category":"reference","title":"Sample"}]}}',
    "encoding.base64-image":
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "text.json-string": '{"name":"Sample","items":[1,2,3]}',
    "text.url": "https://example.com/search?q=hello world",
    "text.html": "<p class=\"sample\">Hello</p>",
    "text.unicode": "Hello ✓",
    "text.find-replace": "Sample text\nReplace this text",
  };
  const sample =
    Object.prototype.hasOwnProperty.call(samples, tab.toolId)
      ? samples[tab.toolId]
      : "Sample text";
  if (sample === null) return;
  controller.edit(tab.id, sample);
};
$("#palette-open").onclick = (event) =>
  openPalette(event.currentTarget as HTMLElement);
$("#palette-close").onclick = closePalette;
$("#cancel-job").onclick = () => {
  if (state.activeId) controller.cancel(state.activeId);
};
async function copyCompleteResult(id: string) {
  try {
    const text = await controller.readResultClipboard(id);
    await navigator.clipboard.writeText(text);
    notify("Copied complete result to clipboard");
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
}
$("#copy-result").onclick = () => {
  if (state.activeId) void copyCompleteResult(state.activeId);
};
$("#copy-image").onclick = () => {
  const tab = activeTab(state);
  const result = tab?.result;
  if (!tab || !result || tab.resultStale) return;
  const source: ImageSource = result.image
    ? { kind: "bytes", mime: result.image.mime, dataUri: result.image.data }
    : { kind: "svg", markup: result.text };
  // The item takes the PNG as a promise, so the write starts inside the click and
  // keeps its user activation while the image is drawn.
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": imageAsPng(source) })])
    .then(
      () => notify("Copied image to clipboard"),
      (error: unknown) => notify(`Image not copied: ${error instanceof Error ? error.message : String(error)}`),
    );
};
// A preview is never a complete payload. Intercept Select All + Copy so the
// natural clipboard shortcut has the same semantics as Copy complete result.
$("#result-output").addEventListener("copy", (event) => {
  const tab = activeTab(state);
  const output = $("#result-output") as HTMLTextAreaElement;
  if (
    !tab?.result?.truncated ||
    output.selectionStart !== 0 ||
    output.selectionEnd !== output.value.length
  )
    return;
  event.preventDefault();
  if (!tab.resultStale) void copyCompleteResult(tab.id);
});
$("#open-result").onclick = () => {
  if (state.activeId)
    void controller
      .openResult(state.activeId)
      .catch((error: unknown) =>
        notify(error instanceof Error ? error.message : String(error)),
      );
};
$("#save-result").onclick = () => {
  if (state.activeId) void controller.saveOutput(state.activeId);
};
// The view toggle and the path box belong to the active tab, so switching tabs
// shows that tab's view and its own query rather than the last one typed.
$("#view-text").onclick = () => {
  const id = state.activeId;
  if (!id) return;
  treeFor(id).view = "text";
  render();
};
$("#view-tree").onclick = () => {
  const id = state.activeId;
  if (!id) return;
  treeFor(id).view = "tree";
  render();
  $("#tree-path").focus();
};
$("#tree-path").oninput = () => {
  const id = state.activeId;
  const tab = activeTab(state);
  if (!id || !tab?.result) return;
  treeFor(id).query = ($("#tree-path") as HTMLInputElement).value;
  const parsed = parsedResult(tab.result.text);
  if (parsed.ok) renderTree(id, parsed.value);
};

$("#tool-search").oninput = () => renderTools();
$("#sidebar-collapse").onclick = () => {
  $(".sidebar").classList.toggle("collapsed");
  $("#sidebar-collapse").setAttribute(
    "aria-expanded",
    String(!$(".sidebar").classList.contains("collapsed")),
  );
  try {
    localStorage.setItem(layoutStorage.sidebar, String($(".sidebar").classList.contains("collapsed")));
  } catch {
    /* optional */
  }
};
$("#result-toggle").onclick = () => {
  const id = state.activeId;
  if (!id) return;
  if (collapsedResults.has(id)) collapsedResults.delete(id);
  else collapsedResults.add(id);
  render();
};
$("#result-collapse").onclick = () => {
  const id = state.activeId;
  if (!id) return;
  if (collapsedResults.has(id)) collapsedResults.delete(id);
  else collapsedResults.add(id);
  render();
};
const splitter = $("#workspace-splitter");
let draggingSplitter = false;
function splitIsVertical(): boolean {
  return getComputedStyle($("#document-panel")).flexDirection === "column";
}
function applySplit(ratio: number) {
  const clamped = Math.min(0.72, Math.max(0.28, ratio));
  if ($("#document-panel").classList.contains("compare-layout")) compareSplitRatio = clamped;
  else splitRatio = clamped;
  persistLayout();
  $("#document-panel").style.setProperty("--split-position", `${Math.round(clamped * 100)}%`);
}
const currentSplit = () =>
  $("#document-panel").classList.contains("compare-layout") ? compareSplitRatio : splitRatio;
const setSplitFromPointer = (clientX: number, clientY: number) => {
  const rect = $("#document-panel").getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  applySplit(splitIsVertical() ? (clientY - rect.top) / rect.height : (clientX - rect.left) / rect.width);
};
splitter.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  draggingSplitter = true;
  splitter.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  document.body.classList.toggle("resizing-rows", splitIsVertical());
});
splitter.addEventListener("pointermove", (event) => {
  if (draggingSplitter) setSplitFromPointer(event.clientX, event.clientY);
});
splitter.addEventListener("pointerup", () => {
  draggingSplitter = false;
  document.body.classList.remove("resizing", "resizing-rows");
});
splitter.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const grow = event.key === "ArrowRight" || event.key === "ArrowDown";
  if (event.key === "Home") applySplit(0.28);
  else if (event.key === "End") applySplit(0.72);
  else applySplit(currentSplit() + (grow ? 0.04 : -0.04));
  render();
});
paletteSearch.oninput = commands;
$("#tab-new").onclick = () => controller.newDocument();
document.addEventListener("keydown", (event) => {
  if (palette.open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>("#command-list button"),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
        buttons.length
    ]?.focus();
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    ["z", "y"].includes(event.key.toLowerCase()) &&
    state.activeId &&
    ["preview", "compare-left"].includes((event.target as HTMLElement)?.id)
  ) {
    event.preventDefault();
    controller.history(
      state.activeId,
      event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo",
    );
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "w" &&
    state.activeId &&
    !palette.open
  ) {
    event.preventDefault();
    void controller.close(state.activeId);
    return;
  }
  // Next and previous tab from anywhere, as editors do: Ctrl+Tab / Ctrl+Shift+Tab and
  // Ctrl+PageDown / Ctrl+PageUp. Focus stays where the user was working.
  if (
    event.ctrlKey &&
    state.activeId &&
    !palette.open &&
    (event.key === "Tab" || event.key === "PageDown" || event.key === "PageUp")
  ) {
    const backwards = event.key === "PageUp" || (event.key === "Tab" && event.shiftKey);
    const target = neighbourTab(state.activeId, backwards ? "previous" : "next");
    if (target && target !== state.activeId) {
      event.preventDefault();
      selectTabFromKeyboard(target, false);
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    controller.newDocument();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "o"
  ) {
    event.preventDefault();
    void controller.chooseFile();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    if (state.activeId) void controller.save(state.activeId, { as: event.shiftKey });
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "k"
  ) {
    event.preventDefault();
    openPalette(event.target instanceof HTMLElement ? event.target : undefined);
  } else if (event.key === "Escape" && palette.open) closePalette();
  else if (
    palette.open &&
    event.key === "Enter" &&
    document.activeElement === paletteSearch
  ) {
    event.preventDefault();
    (
      document.querySelector<HTMLButtonElement>(
        "#command-list button",
      ) as HTMLButtonElement | null
    )?.click();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.tabs.some((tab) => tab.dirty || tab.rightDirty)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
void controller.initialize();
render();
$("#browser-notice").hidden = native;
$("#engine-status").textContent = native ? "Local engine" : "Browser preview";
const dropTarget = $("#editor-host");
const removeDragOver = () => dropTarget.classList.remove("drag-over");
/** Everything a native drop carries, opened in order; the drop highlight clears either way. */
async function dropPaths(paths: readonly string[]) {
  removeDragOver();
  try {
    if (paths.length) await controller.openPaths(paths);
  } finally {
    removeDragOver();
  }
}
const addDragOver = () => dropTarget.classList.add("drag-over");

if (native) {
  // A window with nothing unsaved closes natively; the host cancels jobs and
  // removes temporary documents when the window is destroyed. Only unsaved
  // work holds the close, and then only until every prompt is answered.
  // The frontend cannot close the window without the `destroy` permission,
  // so intercepting every request and failing there would trap the app.
  let closingWindow = false;
  void getCurrentWindow().onCloseRequested(async (event) => {
    if (closingWindow) {
      event.preventDefault();
      return;
    }
    if (!state.tabs.some((tab) => tab.dirty || tab.rightDirty)) return;
    event.preventDefault();
    closingWindow = true;
    try {
      for (const tab of [...state.tabs])
        if (!(await controller.close(tab.id))) return;
      controller.dispose();
      jobIndicator.dispose();
      await getCurrentWindow().destroy();
    } catch (error) {
      notify(`The window could not be closed: ${errorText(error)}`);
    } finally {
      closingWindow = false;
    }
  });
  void listen("tauri://drag-enter", () => {
    addDragOver();
  });
  void listen("tauri://drag-over", () => {
    addDragOver();
  });
  void listen("tauri://drag-leave", () => {
    removeDragOver();
  });
  void listen<{ paths?: string[] } | string[]>(
    "tauri://drag-drop",
    async (event) => {
      const payload = event.payload;
      await dropPaths(Array.isArray(payload) ? payload : payload.paths ?? []);
    },
  );
}

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  addDragOver();
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  addDragOver();
});
window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || event.relatedTarget === document.documentElement) {
    removeDragOver();
  }
});
dropTarget.addEventListener("dragleave", (event) => {
  if (!dropTarget.contains(event.relatedTarget as Node | null)) {
    removeDragOver();
  }
});
window.addEventListener("dragend", () => {
  removeDragOver();
});
window.addEventListener("blur", () => {
  removeDragOver();
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  removeDragOver();
});
dropTarget.addEventListener("drop", async (event) => {
  event.preventDefault();
  removeDragOver();
  if (native) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  try {
    await controller.openBrowserFiles(files);
  } finally {
    removeDragOver();
  }
});
