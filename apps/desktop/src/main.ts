import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  native,
  chooseFile,
  chooseDocumentOutput,
  chooseResultOutput,
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
} from "./bridge";
import { WorkbenchController, type WorkbenchApi } from "./workbench/controller";
import {
  activeTab,
  type TabState,
  type WorkspaceState,
} from "./workbench/state";
import {
  bundledTools,
  definition,
  validation,
  type ToolDefinition,
} from "./workbench/tools";
import { findMatches, nextMatch, replaceAll } from "./workbench/findReplace";

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
let renderedResultStale = false;
let renderedOptionsKey = "";
let renderedToolsKey = "";
let renderedActionsKey = "";
const palette = $("#palette") as HTMLDialogElement;
const paletteSearch = $("#palette-search") as HTMLInputElement;
const notify = (message: string) => {
  $("#status").textContent = message;
};

function promptClose(tab: TabState): Promise<"save" | "discard" | "cancel"> {
  const dialog = $("#unsaved-dialog") as HTMLDialogElement;
  $("#unsaved-message").textContent = `${tab.name} has unsaved changes.`;
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
    button.title = tab.source?.path ?? tab.name;
    button.innerHTML = `<span class="file-dot ${tab.source?.format ?? "text"}" aria-hidden="true"></span><span class="tab-name">${esc(tab.name)}</span>${tab.dirty ? '<span class="dirty-indicator" aria-label="Unsaved changes">●</span>' : ""}`;
    button.onclick = () => controller.activate(tab.id);
    button.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        controller.activate(tab.id);
      }
    };
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${tab.name}`);
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
  const toolsKey = `${query}|${state.activeId}|${state.tabs.map((tab) => `${tab.id}:${tab.toolId}`).join(",")}`;
  if (toolsKey === renderedToolsKey) return;
  renderedToolsKey = toolsKey;
  nav.innerHTML = "";
  const visible = bundledTools.filter(
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
function renderOptions(tab: TabState, tool: ReturnType<typeof definition>) {
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
    for (const value of ["preserve", "lf", "cr_lf", "ignore"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent =
        value === "cr_lf"
          ? "Normalize CRLF"
          : value[0].toUpperCase() + value.slice(1);
      option.selected = value === tab.options.newline;
      select.append(option);
    }
    select.onchange = () =>
      controller.options(tab.id, tab.operation, {
        ...tab.options,
        newline: select.value,
      });
    label.append(select);
    host.append(label);
  }
}
function renderSources(tab: TabState, tool: ReturnType<typeof definition>) {
  const host = $("#tool-source");
  if (!tool?.compare) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const left = $("#compare-left") as HTMLTextAreaElement;
  const leftText = tab.text ?? tab.source?.preview ?? "";
  if (left.value !== leftText) left.value = leftText;
  left.readOnly = tab.text === null;
  left.oninput = () => controller.edit(tab.id, left.value);
  const right = $("#compare-right") as HTMLTextAreaElement;
  if (right.value !== tab.rightText) right.value = tab.rightText;
  right.oninput = () => controller.right(tab.id, right.value);
  $("#compare-open-right").onclick = () => void controller.openRight(tab.id);
}
function renderInput(tab: TabState, tool: ReturnType<typeof definition>) {
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
    input.readOnly = tab.text === null || tab.phase === "importing";
    input.disabled = false;
    input.oninput = () => controller.edit(tab.id, input.value);
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
  $("#preview-heading").textContent = tab.text !== null ? "Document" : "Input";
  $("#preview-meta").textContent = tab.source
    ? `${bytes(tab.source.size)} · ${tab.source.mime ?? tab.source.format.toUpperCase()}`
    : "Unsaved document";
  $("#preview-limit").textContent =
    tab.phase === "importing"
      ? "Importing complete pasted input…"
      : tab.pasted && tab.text === null
        ? `Preview of ${bytes(tab.source?.size)} pasted input · Tools process all bytes · Ctrl+A then paste to replace`
        : tab.source?.editable
          ? "Editable UTF-8 document · Ctrl+S to save"
          : tab.source
            ? "Read-only bounded preview · Full-file processing"
            : "Editable blank document";
  $("#encoding").textContent = tab.source?.encoding ?? "UTF-8";
  $("#source-name").textContent = tab.name;
  $("#source-size").textContent = tab.source ? bytes(tab.source.size) : "—";
  $("#source-format").textContent =
    tab.source?.contentKind === "text"
      ? tab.source.format.toUpperCase()
      : (tab.source?.contentKind.toUpperCase() ?? "TEXT");
}
function renderActions(tab: TabState, tool: ReturnType<typeof definition>) {
  const host = $(".toolbar-actions");
  const actionsKey = `${tab.id}:${tab.toolId}:${tab.operation}:${tab.phase}:${tool ? (validation(tab, tool) ?? "") : ""}`;
  if (actionsKey === renderedActionsKey) return;
  renderedActionsKey = actionsKey;
  host.innerHTML = "";
  if (!tool?.operations.length) return;
  if (tool.id === "text.find-replace") return;
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
      controller.options(tab.id, operation.id, { ...tab.options });
    host.append(button);
  }
}
function renderDiffResult(text: string, host: HTMLElement): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as { hunks?: unknown }).hunks)
    )
      return false;
    host.replaceChildren();
    for (const hunk of (value as { hunks: unknown[] }).hunks) {
      if (!hunk || typeof hunk !== "object") continue;
      const record = hunk as {
        oldStart?: number;
        oldLines?: number;
        newStart?: number;
        newLines?: number;
        lines?: unknown[];
      };
      const section = document.createElement("section");
      section.className = "diff-hunk";
      const heading = document.createElement("div");
      heading.className = "diff-hunk-title";
      heading.textContent = `Lines ${record.oldStart ?? "?"},${record.oldLines ?? 0} → ${record.newStart ?? "?"},${record.newLines ?? 0}`;
      section.append(heading);
      for (const line of record.lines ?? []) {
        if (!line || typeof line !== "object") continue;
        const item = line as {
          kind?: string;
          text?: string;
          oldLine?: number | null;
          newLine?: number | null;
        };
        const row = document.createElement("div");
        row.className = `diff-line ${item.kind ?? "context"}`;
        const number = document.createElement("span");
        number.className = "diff-line-number";
        number.textContent = `${item.oldLine ?? ""}  ${item.newLine ?? ""}`;
        const body = document.createElement("span");
        body.className = "diff-line-text";
        body.textContent = `${item.kind === "added" ? "+" : item.kind === "removed" ? "−" : " "}${item.text ?? ""}`;
        row.append(number, body);
        section.append(row);
      }
      host.append(section);
    }
    return host.childElementCount > 0;
  } catch {
    return false;
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
function renderResult(tab: TabState) {
  const result = tab.result;
  const empty = $("#result-empty");
  const content = $("#result-content");
  if (!result) {
    renderedResult = null;
    renderedResultStale = false;
    $("#copy-result").hidden = true;
    $("#open-result").hidden = true;
    $("#save-result").hidden = true;
    $("#result-highlight").hidden = true;
    $("#result-status-message").hidden = true;
    empty.hidden = false;
    content.hidden = true;
    const tool = definition(tab.toolId);
    const problem = tool
      ? validation(tab, tool, controller.manifests.get(tool.id))
      : null;
    const title = $("#result-empty-title");
    const text = $("#result-empty-text");
    if (problem) {
      title.textContent = "Input needs attention";
      text.textContent = problem;
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
  if (result === renderedResult && tab.resultStale === renderedResultStale)
    return;
  renderedResult = result;
  renderedResultStale = tab.resultStale;
  empty.hidden = true;
  content.hidden = false;
  const event = result.event;
  const stateNode = $("#result-state");
  stateNode.className = `result-state ${event.ok ? "ok" : event.cancelled ? "cancelled" : "failed"}`;
  stateNode.textContent = event.ok
    ? "✓ Completed successfully"
    : event.cancelled
      ? "○ Cancelled"
      : `● ${friendlyError(tab, event)}`;
  if (tab.resultStale) stateNode.textContent += " · Updating…";
  $("#result-summary").textContent = readableSummary(event.summary);
  $("#result-metrics").innerHTML = [
    ["Elapsed", `${event.elapsedMs} ms`],
    ["Input", bytes(event.inputBytes)],
    ["Output", bytes(event.outputBytes)],
    ["Status", event.ok ? "Ready to review" : "No output"],
  ]
    .map(([key, value]) => `<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`)
    .join("");
  const media = $("#result-media");
  media.innerHTML = "";
  const structured = $("#result-structured");
  structured.replaceChildren();
  const output = $("#result-output") as HTMLTextAreaElement;
  const highlight = $("#result-highlight");
  const statusMessage = $("#result-status-message");
  const binary = !!result.image;
  const diff =
    !binary &&
    event.renderer === "diff" &&
    renderDiffResult(result.text, structured);
  structured.hidden = !diff;
  media.hidden = !binary;
  if (result.image) {
    const image = document.createElement("img");
    image.className = "binary-preview";
    image.src = result.image.data;
    image.alt = `${result.image.mime} result preview`;
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
  const noOutput =
    event.ok && !event.resultDocumentId && !result.text && !binary && !diff;
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
    tab.resultStale || !event.ok || binary || !result.text;
  $("#copy-result").textContent = "Copy complete result";
  $("#open-result").hidden =
    tab.resultStale || !event.ok || binary || !event.resultDocumentId;
  $("#save-result").hidden =
    tab.resultStale || !event.ok || !event.resultDocumentId;
}
function render() {
  const tab = activeTab(state);
  renderTabs();
  renderTools();
  const tool = tab ? definition(tab.toolId) : undefined;
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
  $("#error").hidden = !tab?.error;
  $("#error").textContent = tab?.error ?? "";
  const save = $("#save-document") as HTMLButtonElement;
  save.disabled = !tab || tab.phase === "importing";
  $("#job-panel").hidden =
    !tab || (tab.phase !== "queued" && tab.phase !== "running");
  if (tab) {
    renderOptions(tab, tool);
    renderSources(tab, tool);
    renderInput(tab, tool);
    renderActions(tab, tool);
    renderResult(tab);
    $("#job-title").textContent =
      `${tool?.label ?? "Processing"} · ${tab.name}`;
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
    $("#job-bytes").textContent = tab.progress
      ? `${bytes(tab.progress.bytesProcessed)} of ${bytes(tab.progress.totalBytes)}`
      : "Starting…";
    $("#job-percent").textContent = tab.progress?.totalBytes
      ? `${Math.round((tab.progress.bytesProcessed / tab.progress.totalBytes) * 100)}%`
      : "—";
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
}
function commands() {
  const list = $("#command-list");
  list.innerHTML = "";
  const actions = [
    { label: "New document", run: () => controller.newDocument() },
    { label: "Open file", run: () => void controller.chooseFile() },
    ...state.tabs.flatMap((tab) =>
      bundledTools
        .filter((tool) => tool.id !== "editor.text")
        .map((tool) => ({
          label: `${tool.label} · ${tab.name}`,
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
    render();
    if (switched && activeTab(state)?.text !== null) {
      const input = $(
        definition(activeTab(state)?.toolId ?? "")?.compare
          ? "#compare-left"
          : "#preview",
      ) as HTMLTextAreaElement;
      if (!input.hidden) input.focus();
    }
  },
  notify,
  confirmClose: promptClose,
};
const api: WorkbenchApi = {
  native,
  chooseFile,
  chooseDocumentOutput,
  chooseResultOutput,
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
};
controller = new WorkbenchController(api, hooks);
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
$("#tool-search").oninput = () => renderTools();
$("#sidebar-collapse").onclick = () => {
  $(".sidebar").classList.toggle("collapsed");
  $("#sidebar-collapse").setAttribute(
    "aria-expanded",
    String(!$(".sidebar").classList.contains("collapsed")),
  );
};
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
    if (state.activeId) void controller.save(state.activeId);
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
  if (state.tabs.some((tab) => tab.dirty)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
void controller.initialize();
render();
$("#browser-notice").hidden = native;
$("#engine-status").textContent = native ? "Local engine" : "Browser preview";
if (native) {
  let closingWindow = false;
  void getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (closingWindow) return;
    closingWindow = true;
    try {
      for (const tab of [...state.tabs])
        if (!(await controller.close(tab.id))) return;
      controller.dispose();
      await getCurrentWindow().destroy();
    } finally {
      closingWindow = false;
    }
  });
  void listen<{ paths?: string[] } | string[]>("tauri://drag-drop", (event) => {
    const payload = event.payload;
    const path = Array.isArray(payload) ? payload[0] : payload.paths?.[0];
    if (path) void controller.openPath(path);
  });
}
const dropTarget = $("#editor-host");
dropTarget.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropTarget.classList.add("drag-over");
});
dropTarget.addEventListener("dragleave", () =>
  dropTarget.classList.remove("drag-over"),
);
dropTarget.addEventListener("drop", (event) => {
  event.preventDefault();
  dropTarget.classList.remove("drag-over");
  const file = event.dataTransfer?.files[0] as
    | (File & { path?: string })
    | undefined;
  if (file?.path) void controller.openPath(file.path);
  else if (file)
    void file.text().then((text) => {
      controller.newDocument();
      const id = state.activeId;
      if (id) controller.edit(id, text);
    });
});
