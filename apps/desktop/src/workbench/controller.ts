import type {
  BinaryPreview,
  FileDocument,
  Format,
  JobFinished,
  JobProgress,
  ToolManifest,
  SaveSuggestion,
  SaveReplace,
  ExecutionIdentity,
} from "../bridge";
import {
  EDIT_LIMIT,
  TEXT_IMPORT_LIMIT,
  MAX_TABS,
  compareInputMissing,
  emptyWorkspace,
  makeTab,
  matches,
  reduce,
  tokenFor,
} from "./state.ts";
import type {
  Action,
  ResultView,
  RunToken,
  TabState,
  WorkspaceState,
} from "./state";
import {
  bundledTools,
  defaultTool,
  definition,
  editor,
  resultExtension,
  snapshotFormat,
  validation,
  definitionFromManifest,
  readsDocument,
  runsAutomatically,
  type RunReason,
  type ToolDefinition,
} from "./tools.ts";

export interface WorkbenchApi {
  native: boolean;
  chooseFile(): Promise<string | null>;
  /** Several at once, for Open; the other pickers choose one file for one input. */
  chooseFiles(): Promise<string[]>;
  openDocument(path: string): Promise<FileDocument>;
  createTextDocument(
    text: string,
    name?: string,
    format?: Format,
  ): Promise<FileDocument>;
  closeDocument(id: string): Promise<void>;
  readPreview(id: string, offset?: number): Promise<FileDocument>;
  readBinaryPreview(id: string): Promise<BinaryPreview>;
  runTool(
    id: string,
    tool: string,
    operation: string,
    options: Record<string, unknown>,
  ): Promise<{ jobId: string; identity?: ExecutionIdentity }>;
  runCompare(
    left: string,
    right: string,
    options: Record<string, unknown>,
  ): Promise<{ jobId: string; identity?: ExecutionIdentity }>;
  cancelOperation(id: string): Promise<void>;
  jobStatus(id: string): Promise<JobFinished | null>;
  subscribeJobs(
    progress: (e: JobProgress) => void,
    finish: (e: JobFinished) => void,
  ): Promise<() => void>;
  listTools(): Promise<ToolManifest[]>;
  chooseDocumentOutput(name: string): Promise<string | null>;
  saveDocument(id: string, path: string, replace?: SaveReplace, ownDocument?: string): Promise<FileDocument>;
  chooseResultOutput(
    document: FileDocument,
    suggestion: SaveSuggestion,
  ): Promise<string | null>;
  saveResult(id: string, path: string, replace?: SaveReplace): Promise<void>;
}
interface Task {
  token: RunToken;
  tab: TabState;
  snapshots: string[];
  jobId?: string;
  finishing: boolean;
}
export interface WorkbenchHooks {
  changed(state: WorkspaceState): void;
  notify(message: string): void;
  confirmClose(tab: TabState): Promise<"save" | "discard" | "cancel">;
}
export const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : JSON.stringify(error);

async function readDataUrl(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () =>
        reject(reader.error ?? new Error("Failed to read image file."));
      reader.readAsDataURL(file);
    });
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const nodeBuf = (
    globalThis as unknown as {
      Buffer?: { from(b: ArrayBuffer): { toString(enc: string): string } };
    }
  ).Buffer;
  const base64 =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : (nodeBuf?.from(buffer).toString("base64") ?? "");
  return `data:${file.type || "image/png"};base64,${base64}`;
}

export const IMAGE_IMPORT_LIMIT = 25 * 1024 * 1024;

/** Raster results are read as bytes; an SVG or HTML document is text the shell renders itself. */
export const isBinaryResult = (event: JobFinished) =>
  event.renderer === "binary" || (!!event.resultMime?.startsWith("image/") && event.renderer !== "svg");

/** Effects live here; the reducer owns all tab state. No effect targets the active tab implicitly. */
/** A path as a person writes it: without the `\\?\` prefix Windows gives a canonical one. */
const displayPath = (path: string): string => (path.startsWith("\\\\?\\") ? path.slice(4) : path);
/** The last segment of a Windows or POSIX path. */
const baseName = (path: string): string => path.split(/[\\/]/).pop() || path;

export class WorkbenchController {
  private api: WorkbenchApi;
  private hooks: WorkbenchHooks;
  state: WorkspaceState = emptyWorkspace;
  manifests = new Map<string, ToolManifest>();
  private nextId = 0;
  private tasks: Task[] = [];
  private queue: { token: RunToken; tab: TabState }[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private earlyEvents = new Map<string, JobFinished>();
  private retired = new Set<string>();
  /** Result handles stay live while the explicit Save Result flow is open. */
  private savingResults = new Set<string>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopEvents?: () => void;
  private saving = new Set<string>();
  private closing = new Set<string>();
  private openingPaths = new Set<string>();
  private disposed = false;
  constructor(api: WorkbenchApi, hooks: WorkbenchHooks) {
    this.api = api;
    this.hooks = hooks;
  }

  private dispatch(action: Action) {
    this.state = reduce(this.state, action);
    this.hooks.changed(this.state);
  }
  tab(id: string) {
    return this.state.tabs.find((tab) => tab.id === id);
  }
  private current(token: RunToken) {
    return !this.disposed && matches(this.tab(token.tabId), token);
  }
  toolDefinition(id: string): ToolDefinition | undefined {
    return definition(id, this.manifests);
  }
  availableTools() {
    const dynamic = [...this.manifests.values()]
      .filter((manifest) => !bundledTools.some((tool) => tool.id === manifest.id))
      .map(definitionFromManifest);
    return [...bundledTools, ...dynamic].filter(
      (tool) =>
        tool.id === editor.id ||
        this.manifests.has(tool.id) ||
        !this.api.native,
    );
  }
  async initialize() {
    if (!this.api.native) {
      this.hooks.notify("Browser preview · file tools require the desktop app");
      return;
    }
    try {
      this.stopEvents = await this.api.subscribeJobs(
        (e) => this.progress(e),
        (e) => this.finished(e),
      );
      this.manifests = new Map(
        (await this.api.listTools()).map((manifest) => [manifest.id, manifest]),
      );
      this.poll = setInterval(() => {
        for (const task of this.tasks)
          if (task.jobId && !task.finishing)
            void this.api
              .jobStatus(task.jobId)
              .then((event) => {
                if (event) this.finished(event);
              })
              .catch(() => undefined);
      }, 400);
      this.hooks.changed(this.state);
      this.hooks.notify("Engine connected · Ctrl+N to create a document");
    } catch (error) {
      this.hooks.notify(`Engine connection failed: ${errorText(error)}`);
    }
  }
  newDocument() {
    if (this.state.tabs.length >= MAX_TABS) {
      this.hooks.notify("Close a tab before creating another (16-tab limit).");
      return;
    }
    const number = ++this.nextId;
    this.dispatch({
      type: "add",
      tab: makeTab(`tab-${number}`, `Untitled-${number}.txt`, null, ""),
    });
  }
  activate(id: string) {
    this.dispatch({ type: "activate", id });
  }
  async chooseFile(toolOverride?: string) {
    try {
      if (toolOverride) {
        // A tool asking for its input wants one file.
        const path = await this.api.chooseFile();
        if (path) await this.openPath(path, toolOverride);
        return;
      }
      const paths = await this.api.chooseFiles();
      if (paths.length) await this.openPaths(paths);
    } catch (error) {
      this.hooks.notify(errorText(error));
    }
  }
  /**
   * Open several files at once: a multi-file drop, or several picked in Open. Each
   * gets its own tab, in the order given, until the tab limit. What did not open is
   * reported once, by name, rather than as a notice per file.
   */
  async openPaths(paths: readonly string[]) {
    await this.openMany([...new Set(paths)], (path, quiet) => this.openPath(path, undefined, quiet), baseName);
  }
  async openBrowserFiles(files: readonly File[]) {
    await this.openMany(files, (file, quiet) => this.openBrowserFile(file, undefined, quiet), (file) => file.name);
  }
  private async openMany<T>(
    items: readonly T[],
    open: (item: T, quiet: boolean) => Promise<string | null>,
    name: (item: T) => string,
  ) {
    // One file keeps the single-file behaviour, including its own error notice.
    if (items.length <= 1) {
      if (items[0] !== undefined) await open(items[0], false);
      return;
    }
    const failures: string[] = [];
    let opened = 0;
    let beyondLimit = 0;
    for (const [index, item] of items.entries()) {
      if (this.state.tabs.length >= MAX_TABS) {
        beyondLimit = items.length - index;
        break;
      }
      const error = await open(item, true);
      if (error) failures.push(`${name(item)}: ${error}`);
      else opened += 1;
    }
    const summary =
      opened === items.length ? `Opened ${opened} files` : `Opened ${opened} of ${items.length} files`;
    const limit = beyondLimit ? [`${beyondLimit} more would pass the ${MAX_TABS}-tab limit`] : [];
    this.hooks.notify([summary, ...limit, ...failures].join(" · "));
  }
  async readEditable(document: FileDocument): Promise<string | null> {
    if (
      !document.editable ||
      document.contentKind !== "text" ||
      document.size > EDIT_LIMIT
    )
      return null;
    let text = document.preview;
    let offset = document.bytesRead ?? new TextEncoder().encode(text).length;
    while (offset < document.size) {
      const page = await this.api.readPreview(document.id, offset);
      if (!page.bytesRead)
        throw new Error("The editor could not read the complete document.");
      text += page.preview;
      offset += page.bytesRead;
    }
    return text;
  }
  /** Read a generated text result in bounded pages for the editable result tab. */
  async readResultText(id: string): Promise<string> {
    return this.readResultTextBounded(id, EDIT_LIMIT);
  }
  /** Read a complete textual result for clipboard use, within a safe memory bound. */
  async readResultClipboard(id: string): Promise<string> {
    return this.readResultTextBounded(id, TEXT_IMPORT_LIMIT);
  }
  private async readResultTextBounded(
    id: string,
    maxBytes: number,
  ): Promise<string> {
    const tab = this.tab(id);
    const event = tab?.result?.event;
    if (
      !tab ||
      tab.resultStale ||
      tab.phase !== "success" ||
      !event?.ok ||
      !event.resultDocumentId
    )
      throw new Error("That result is no longer current.");
    if (isBinaryResult(event))
      throw new Error("Binary results cannot be opened as text.");
    const token = tokenFor(tab);
    const resultId = event.resultDocumentId;
    this.savingResults.add(resultId);
    try {
      let page = await this.api.readPreview(resultId, 0);
      const size = page.size;
      const chunks = [page.preview];
      let bytes = new TextEncoder().encode(page.preview).length;
      let offset = page.bytesRead ?? bytes;
      if (size > maxBytes || bytes > maxBytes)
        throw new Error(
          `Result is larger than the ${Math.round(maxBytes / (1024 * 1024))} MiB limit.`,
        );
      while (offset < size) {
        if (
          !this.current(token) ||
          this.tab(id)?.result?.event.resultDocumentId !== resultId ||
          this.tab(id)?.resultStale
        )
          throw new Error("The result changed while it was being read.");
        page = await this.api.readPreview(resultId, offset);
        if (!page.bytesRead)
          throw new Error("The result could not be read completely.");
        chunks.push(page.preview);
        bytes += new TextEncoder().encode(page.preview).length;
        offset += page.bytesRead;
        if (bytes > maxBytes)
          throw new Error(
            `Result is larger than the ${Math.round(maxBytes / (1024 * 1024))} MiB limit.`,
          );
      }
      if (
        !this.current(token) ||
        this.tab(id)?.result?.event.resultDocumentId !== resultId ||
        this.tab(id)?.resultStale
      )
        throw new Error("The result changed while it was being read.");
      return chunks.join("");
    } finally {
      this.savingResults.delete(resultId);
      this.cleanup();
    }
  }
  /** Open a complete generated text result as a new in-memory editable tab. */
  async openResult(id: string): Promise<void> {
    const source = this.tab(id);
    const event = source?.result?.event;
    if (
      !source ||
      source.resultStale ||
      source.phase !== "success" ||
      !event?.ok
    )
      throw new Error("That result is no longer current.");
    const text = await this.readResultText(id);
    if (this.state.tabs.length >= MAX_TABS)
      throw new Error("Close a tab before opening another (16-tab limit).");
    const suffix = source.operation ? `.${source.operation}` : ".result";
    const tab = makeTab(
      `tab-${++this.nextId}`,
      `${source.name}${suffix}.txt`,
      null,
      text,
    );
    this.dispatch({ type: "add", tab });
  }
  /**
   * Open one file in its own tab, or activate the tab that already has it. Returns why
   * it did not open, or null. It reports that itself unless `quiet`, which lets several
   * opens share one summary.
   */
  async openPath(path: string, toolOverride?: string, quiet = false): Promise<string | null> {
    if (!this.api.native) {
      const message = "Open the native desktop app to read local files.";
      if (!quiet) this.hooks.notify(message);
      return message;
    }
    if (this.openingPaths.has(path)) return null;
    this.openingPaths.add(path);
    let opened: FileDocument | undefined;
    try {
      if (this.state.tabs.length >= MAX_TABS)
        throw new Error("Close a tab before opening another (16-tab limit).");
      const existing = this.state.tabs.find(
        (tab) => tab.source?.path === path || tab.savedPath === path,
      );
      if (existing) {
        this.activate(existing.id);
        return null;
      }
      opened = await this.api.openDocument(path);
      const existingCanonical = this.state.tabs.find(
        (tab) =>
          tab.source?.path === opened!.path || tab.savedPath === opened!.path,
      );
      if (existingCanonical) {
        this.retire(opened.id);
        this.activate(existingCanonical.id);
        return null;
      }
      const defaultToolId =
        opened.contentKind === "binary" ? "encoding.hash" : defaultTool(opened);
      const toolId = toolOverride ?? defaultToolId;
      const tool = this.toolDefinition(toolId);
      if (!tool) {
        throw new Error(`Tool "${toolId}" is not available in the current engine.`);
      }
      if (tool.input === "image" && opened.contentKind !== "image") {
        throw new Error(
          `${tool.label} requires a PNG or JPEG image. Open an image or choose another tool.`,
        );
      }
      if (tool.input === "text" && opened.contentKind !== "text") {
        throw new Error(
          `${tool.label} requires a text document. Open a text file or choose another tool.`,
        );
      }
      const text = await this.readEditable(opened);
      if (this.state.tabs.length >= MAX_TABS)
        throw new Error("The tab limit was reached while opening this file.");
      const tab = makeTab(`tab-${++this.nextId}`, opened.name, opened, text);
      this.dispatch({
        type: "add",
        tab: {
          ...tab,
          toolId: tool.id,
          operation: tool.defaultOperation,
          options: tool.defaultOptions,
        },
      });
      if (opened.contentKind === "image")
        void this.loadImage(tab.id, opened.id);
      this.schedule(tab.id, 0);
    } catch (error) {
      if (opened) this.retire(opened.id);
      const message = errorText(error);
      if (!quiet) this.hooks.notify(message);
      return message;
    } finally {
      this.openingPaths.delete(path);
    }
    return null;
  }
  /** The browser-preview counterpart of openPath, with the same return and `quiet`. */
  async openBrowserFile(file: File, toolOverride?: string, quiet = false): Promise<string | null> {
    try {
      if (this.state.tabs.length >= MAX_TABS) {
        throw new Error("Close a tab before opening another (16-tab limit).");
      }
      // Reliable identity check: if a real filesystem path is available, deduplicate by path.
      // Do NOT deduplicate by filename alone, so two distinct files with the same name
      // can each be opened in their own tabs.
      const filePath = (file as unknown as { path?: string }).path;
      if (filePath && typeof filePath === "string") {
        const existing = this.state.tabs.find(
          (t) => t.source?.path === filePath || t.savedPath === filePath,
        );
        if (existing) {
          this.activate(existing.id);
          return null;
        }
      }
      const isImage =
        file.type.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      if (isImage) {
        if (file.size > IMAGE_IMPORT_LIMIT) {
          throw new Error(
            `Image exceeds the ${Math.round(IMAGE_IMPORT_LIMIT / (1024 * 1024))} MiB import limit.`,
          );
        }
        const dataUrl = await readDataUrl(file);
        const doc: FileDocument = {
          id: `browser-doc-${++this.nextId}`,
          name: file.name,
          path: filePath || file.name,
          size: file.size,
          preview: "",
          truncated: false,
          format: "text",
          encoding: "Binary",
          contentKind: "image",
          mime: file.type || "image/png",
          editable: false,
        };
        const tab = makeTab(`tab-${++this.nextId}`, file.name, doc, null);
        const tool = this.toolDefinition(
          toolOverride ?? "encoding.image-base64",
        )!;
        if (tool.input === "text") {
          throw new Error(`${tool.label} requires a text document.`);
        }
        this.dispatch({
          type: "add",
          tab: {
            ...tab,
            toolId: tool.id,
            operation: tool.defaultOperation,
            options: tool.defaultOptions,
            image: {
              mime: file.type || "image/png",
              data: dataUrl,
              bytes: file.size,
              truncated: false,
            },
          },
        });
        return null;
      }
      const isText =
        file.type.startsWith("text/") ||
        file.type === "application/json" ||
        file.type === "application/javascript" ||
        file.type === "application/xml" ||
        /\.(txt|json|csv|md|js|ts|html|css|xml|yaml|yml|log|py|sh|rs)$/i.test(
          file.name,
        ) ||
        !file.type;
      if (isText) {
        if (file.size > TEXT_IMPORT_LIMIT) {
          throw new Error(
            `File exceeds the ${Math.round(TEXT_IMPORT_LIMIT / (1024 * 1024))} MiB import limit.`,
          );
        }
        const text = await file.text();
        const isJson =
          file.type === "application/json" || /\.json$/i.test(file.name);
        const isCsv = file.type === "text/csv" || /\.csv$/i.test(file.name);
        const doc: FileDocument = {
          id: `browser-doc-${++this.nextId}`,
          name: file.name,
          path: filePath || file.name,
          size: file.size,
          preview: text.slice(0, EDIT_LIMIT),
          truncated: file.size > EDIT_LIMIT,
          format: isJson ? "json" : isCsv ? "csv" : "text",
          encoding: "UTF-8",
          contentKind: "text",
          mime: isJson
            ? "application/json"
            : isCsv
              ? "text/csv"
              : "text/plain",
          editable: file.size <= EDIT_LIMIT,
        };
        const tab = makeTab(
          `tab-${++this.nextId}`,
          file.name,
          doc,
          file.size <= EDIT_LIMIT ? text : null,
        );
        const detectedTool = isJson
          ? "structured.json"
          : isCsv
            ? "structured.csv"
            : editor.id;
        const tool = this.toolDefinition(toolOverride ?? detectedTool)!;
        if (tool.input === "image") {
          throw new Error(`${tool.label} requires a PNG or JPEG image.`);
        }
        this.dispatch({
          type: "add",
          tab: {
            ...tab,
            toolId: tool.id,
            operation: tool.defaultOperation,
            options: tool.defaultOptions,
          },
        });
        if (file.size <= EDIT_LIMIT) {
          this.schedule(tab.id, 0);
        }
        return null;
      }
      // Binary file (e.g. .bin)
      if (file.size > TEXT_IMPORT_LIMIT) {
        throw new Error(
          `File exceeds the ${Math.round(TEXT_IMPORT_LIMIT / (1024 * 1024))} MiB import limit.`,
        );
      }
      const doc: FileDocument = {
        id: `browser-doc-${++this.nextId}`,
        name: file.name,
        path: filePath || file.name,
        size: file.size,
        preview: "",
        truncated: false,
        format: "text",
        encoding: "Binary",
        contentKind: "binary",
        mime: file.type || "application/octet-stream",
        editable: false,
      };
      const tab = makeTab(`tab-${++this.nextId}`, file.name, doc, null);
      const tool = this.toolDefinition(toolOverride ?? "encoding.hash")!;
      if (tool.input === "text") {
        throw new Error(`${tool.label} requires a text document.`);
      }
      if (tool.input === "image") {
        throw new Error(`${tool.label} requires a PNG or JPEG image.`);
      }
      this.dispatch({
        type: "add",
        tab: {
          ...tab,
          toolId: tool.id,
          operation: tool.defaultOperation,
          options: tool.defaultOptions,
        },
      });
      this.schedule(tab.id, 0);
    } catch (error) {
      const message = errorText(error);
      if (!quiet) this.hooks.notify(message);
      return message;
    }
    return null;
  }
  private async loadImage(tabId: string, documentId: string) {
    try {
      const image = await this.api.readBinaryPreview(documentId);
      this.dispatch({ type: "image", id: tabId, image, error: null });
    } catch (error) {
      this.dispatch({
        type: "image",
        id: tabId,
        image: null,
        error: errorText(error),
      });
    }
  }
  selectTool(id: string, toolId: string) {
    const tab = this.tab(id);
    const tool = this.toolDefinition(toolId);
    if (!tab || !tool || tab.toolId === toolId) return;
    this.invalidate(id);
    this.dispatch({
      type: "tool",
      id,
      toolId,
      operation: tool.defaultOperation,
      options: { ...tool.defaultOptions },
    });
    this.schedule(id, 0, "select");
  }
  edit(id: string, text: string) {
    const existing = this.tab(id);
    if (!existing || existing.text === text) return;
    if (new TextEncoder().encode(text).length > EDIT_LIMIT) {
      this.hooks.notify(
        "Editable documents are limited to 1 MiB. Your previous text is unchanged.",
      );
      this.hooks.changed(this.state);
      return;
    }
    this.invalidate(id);
    this.dispatch({ type: "edit", id, text });
    this.schedule(id);
  }
  /** Paste is an explicit input transaction. Large input goes straight to an
   * immutable host snapshot, with only a bounded preview retained by the tab. */
  async paste(
    id: string,
    pastedText: string,
    start: number,
    end: number,
  ): Promise<void> {
    const tab = this.tab(id);
    if (!tab || tab.phase === "importing" || this.disposed || !pastedText)
      return;
    if (tab.source && tab.source.contentKind !== "text") {
      this.hooks.notify("Create a text tab before pasting text.");
      return;
    }
    if (
      tab.text === null &&
      (start !== 0 || end !== tab.source?.preview.length)
    ) {
      this.hooks.notify(
        "This is a preview. Select all (Ctrl+A) before pasting to replace the complete input.",
      );
      return;
    }
    const original = tab.text ?? "";
    const from = Math.max(0, Math.min(original.length, start));
    const to = Math.max(from, Math.min(original.length, end));
    const text = original.slice(0, from) + pastedText + original.slice(to);
    const size = new TextEncoder().encode(text).length;
    if (size > TEXT_IMPORT_LIMIT) {
      this.hooks.notify(
        "Pasted input exceeds 36 MiB. Open it as a file instead. Your input is unchanged.",
      );
      return;
    }
    if (size <= EDIT_LIMIT && tab.text !== null) {
      this.edit(id, text);
      this.hooks.notify("Pasted complete input");
      return;
    }
    if (!this.api.native) {
      this.hooks.notify(
        "Use the desktop app to paste input larger than the editor limit.",
      );
      return;
    }
    this.invalidate(id);
    this.dispatch({ type: "import-start", id });
    const token = tokenFor(this.tab(id)!);
    this.hooks.notify("Importing complete pasted input…");
    let source: FileDocument | undefined;
    try {
      source = await this.api.createTextDocument(
        text,
        tab.name,
        snapshotFormat(tab),
      );
      if (!this.current(token)) {
        this.retire(source.id);
        return;
      }
      this.dispatch({
        type: "imported",
        token,
        source,
        text: size <= EDIT_LIMIT ? text : null,
      });
      if (tab.source) this.retire(tab.source.id);
      this.hooks.notify(
        `Pasted ${(size / (1024 * 1024)).toFixed(2)} MiB · tools use the complete input`,
      );
      this.schedule(id, 0);
    } catch (error) {
      if (source) this.retire(source.id);
      if (this.current(token)) {
        this.dispatch({
          type: "failed",
          token,
          message: `Paste failed: ${errorText(error)} Your previous input is unchanged.`,
        });
      }
    }
  }
  history(id: string, type: "undo" | "redo") {
    this.invalidate(id);
    this.dispatch({ type, id });
    this.schedule(id);
  }
  /**
   * An option change or an operation press. `explicit` marks the press: it runs
   * whatever the manifest says, while an option change only runs an operation
   * that declared it may. Switching operations takes the new operation's
   * defaults, keeping any value the user set for an option both declare.
   */
  options(
    id: string,
    operation: string,
    options: Record<string, unknown>,
    explicit = false,
  ) {
    const tab = this.tab(id);
    const tool = tab && this.toolDefinition(tab.toolId);
    if (!tab || !tool?.operations.some((op) => op.id === operation)) return;
    let next = options;
    if (operation !== tab.operation) {
      const target = tool.operations.find((op) => op.id === operation);
      const defaults = this.manifests.get(tool.id)?.operations.find((op) => op.id === operation)?.defaultOptions ?? {};
      next = { ...defaults };
      for (const option of target?.options ?? [])
        if (options[option.id] !== undefined) next[option.id] = options[option.id];
    }
    this.invalidate(id);
    this.dispatch({ type: "options", id, operation, options: next });
    this.schedule(id, 0, explicit ? "explicit" : "option");
  }
  right(id: string, text: string, baseline?: string | null) {
    if (new TextEncoder().encode(text).length > EDIT_LIMIT) {
      this.hooks.notify("Comparison text is limited to 1 MiB.");
      return;
    }
    this.invalidate(id);
    this.dispatch({ type: "right", id, text, baseline });
    this.schedule(id);
  }
  findOptions(
    id: string,
    patch: Partial<
      Pick<
        TabState,
        "findQuery" | "findReplacement" | "findCaseSensitive" | "findWholeWord"
      >
    >,
  ) {
    if (!this.tab(id)) return;
    this.dispatch({ type: "find-options", id, patch });
  }
  async openRight(id: string) {
    let doc: FileDocument | undefined;
    try {
      const path = await this.api.chooseFile();
      if (!path) return;
      doc = await this.api.openDocument(path);
      const text = await this.readEditable(doc);
      if (text === null)
        throw new Error(
          "Choose a UTF-8 text file up to 1 MiB for the right comparison editor.",
        );
      if (this.tab(id)) this.right(id, text, text);
    } catch (error) {
      this.dispatch({ type: "error", id, message: errorText(error) });
    } finally {
      if (doc) this.retire(doc.id);
    }
  }
  private schedule(id: string, delay = 350, reason: RunReason = "input") {
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const tab = this.tab(id);
    const tool = tab && this.toolDefinition(tab.toolId);
    if (!tab || !tool || tab.phase === "importing") return;
    const waits =
      !runsAutomatically(tool, tab.operation, reason) ||
      (tab.text === "" && tool.id !== "encoding.hash" && !tool.compare && !tool.emptyInput);
    if (waits) {
      // Nothing will run, so a result kept from before this change must not say it
      // is updating. It is still the answer if the change was an edit to a document
      // the operation never reads; otherwise it is out of date until the next run.
      if (tab.resultStale)
        this.dispatch({ type: "idle", id, current: reason === "input" && !readsDocument(tool, tab.operation) });
      return;
    }
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.run(id, reason);
      }, delay),
    );
  }
  run(id: string, reason: RunReason = "explicit") {
    const tab = this.tab(id);
    const tool = tab && this.toolDefinition(tab.toolId);
    if (!tab || !tool || tab.phase === "importing") return;
    if (!runsAutomatically(tool, tab.operation, reason)) return;
    const problem = validation(tab, tool, this.manifests.get(tool.id));
    if (problem) {
      this.dispatch({ type: "error", id, message: problem });
      return;
    }
    // The empty-side gate also holds at the host boundary: an empty side
    // never becomes a snapshot or a job. The shell reports the gap as status
    // and the stale result is dropped, as a failed run would have dropped it.
    if (tool.compare && compareInputMissing(tab)) {
      this.invalidate(id);
      this.dispatch({ type: "gated", id });
      return;
    }
    if (!this.api.native) {
      this.dispatch({
        type: "error",
        id,
        message: "The native desktop engine is needed to run this tool.",
      });
      return;
    }
    if (!this.manifests.has(tool.id)) {
      this.dispatch({
        type: "error",
        id,
        message: "This tool is not available in the current engine.",
      });
      return;
    }
    this.invalidate(id);
    this.dispatch({ type: "queue", id });
    const snapshot = this.tab(id)!;
    this.queue.push({ token: tokenFor(snapshot), tab: snapshot });
    this.pump();
  }
  cancel(id: string) {
    this.invalidate(id);
    this.dispatch({ type: "cancel", id });
  }
  private invalidate(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.queue = this.queue.filter((item) => item.token.tabId !== id);
    const resultId = this.tab(id)?.result?.event.resultDocumentId;
    if (resultId) this.retire(resultId);
    for (const task of this.tasks)
      if (task.token.tabId === id && task.jobId)
        void this.api.cancelOperation(task.jobId).catch(() => undefined);
  }
  private pump() {
    while (this.tasks.length < 2 && this.queue.length) {
      const item = this.queue.shift()!;
      if (!this.current(item.token)) continue;
      const task: Task = { ...item, snapshots: [], finishing: false };
      this.tasks.push(task);
      void this.start(task);
    }
  }
  private async start(task: Task) {
    try {
      let input = task.tab.source;
      if (task.tab.text !== null) {
        input = await this.api.createTextDocument(
          task.tab.text,
          task.tab.name,
          snapshotFormat(task.tab),
        );
        task.snapshots.push(input.id);
      }
      if (!input) throw new Error("There is no input document.");
      let right: FileDocument | undefined;
      if (this.toolDefinition(task.tab.toolId)?.compare) {
        right = await this.api.createTextDocument(
          task.tab.rightText,
          "comparison.txt",
          "text",
        );
        task.snapshots.push(right.id);
      }
      if (!this.current(task.token)) {
        this.release(task);
        return;
      }
      const started = right
        ? await this.api.runCompare(input.id, right.id, { ...task.tab.options })
        : await this.api.runTool(
            input.id,
            task.tab.toolId,
            task.tab.operation,
            { ...task.tab.options },
          );
      task.jobId = started.jobId;
      if (!this.current(task.token))
        void this.api.cancelOperation(started.jobId).catch(() => undefined);
      else
        this.dispatch({
          type: "started",
          token: task.token,
          jobId: started.jobId,
          identity: started.identity,
        });
      const early = this.earlyEvents.get(started.jobId);
      this.earlyEvents.delete(started.jobId);
      if (early) this.finished(early);
      else
        void this.api
          .jobStatus(started.jobId)
          .then((event) => {
            if (event) this.finished(event);
          })
          .catch(() => undefined);
    } catch (error) {
      this.dispatch({
        type: "failed",
        token: task.token,
        message: errorText(error),
      });
      this.release(task);
    }
  }
  private progress(event: JobProgress) {
    const task = this.tasks.find((task) => task.jobId === event.jobId);
    if (task && !task.finishing)
      this.dispatch({ type: "progress", token: task.token, progress: event });
  }
  private finished(event: JobFinished) {
    const task = this.tasks.find((task) => task.jobId === event.jobId);
    if (!task) {
      // Only retain completion-before-invoke events while a request is starting.
      if (this.tasks.some((task) => !task.jobId)) {
        this.earlyEvents.set(event.jobId, event);
        if (this.earlyEvents.size > 8)
          this.earlyEvents.delete(this.earlyEvents.keys().next().value!);
      }
      return;
    }
    if (task.finishing) return;
    task.finishing = true;
    void this.complete(task, event);
  }
  private async complete(task: Task, event: JobFinished) {
    const view: ResultView = { event, text: "", truncated: false };
    try {
      if (this.current(task.token) && event.ok && event.resultDocumentId) {
        if (isBinaryResult(event))
          view.image = await this.api.readBinaryPreview(event.resultDocumentId);
        else {
          const preview = await this.api.readPreview(event.resultDocumentId);
          view.text = preview.preview;
          view.truncated = preview.truncated;
          // Small generated results must be complete so ordinary selection and
          // copy/paste round-trips do not copy only the first preview page.
          if (preview.size <= EDIT_LIMIT && preview.truncated) {
            let offset =
              preview.bytesRead ??
              new TextEncoder().encode(preview.preview).length;
            while (offset < preview.size && this.current(task.token)) {
              const page = await this.api.readPreview(
                event.resultDocumentId,
                offset,
              );
              if (!page.bytesRead)
                throw new Error("The complete result could not be read.");
              view.text += page.preview;
              offset += page.bytesRead;
            }
            view.truncated = offset < preview.size;
          }
        }
      }
    } catch (error) {
      view.previewError = errorText(error);
    }
    if (this.current(task.token))
      this.dispatch({ type: "result", token: task.token, result: view });
    else if (event.resultDocumentId) this.retire(event.resultDocumentId);
    this.release(task);
  }
  private release(task: Task) {
    this.tasks = this.tasks.filter((item) => item !== task);
    for (const id of task.snapshots) this.retire(id);
    this.cleanup();
    this.pump();
  }
  private retire(id: string) {
    this.retired.add(id);
    this.cleanup();
  }
  private cleanup() {
    for (const id of this.retired) {
      if (
        this.savingResults.has(id) ||
        this.tasks.some(
          (task) =>
            task.snapshots.includes(id) ||
            task.tab.source?.id === id ||
            (task.tab.result?.event.resultDocumentId === id &&
              !task.tab.resultStale),
        )
      )
        continue;
      this.retired.delete(id);
      void this.api.closeDocument(id).catch(() => undefined);
    }
  }
  /** The file a Save writes to without asking: the one this tab was last saved to or opened from. */
  saveTarget(id: string): string | null {
    const tab = this.tab(id);
    if (!tab || tab.text === null) return null;
    return tab.savedPath ?? (tab.source && !tab.pasted ? tab.source.path : null);
  }
  /**
   * Save writes back to the tab's own file when it has one, the way an editor does;
   * Save As (`as`), or a tab with no file yet, asks where. Every write is atomic, and
   * the host refuses to replace a file another program changed since it was opened.
   * A save that fails says why and leaves the tab exactly as it was.
   */
  async save(id: string, { as = false }: { as?: boolean } = {}): Promise<boolean> {
    const tab = this.tab(id);
    if (!tab || tab.phase === "importing" || this.saving.has(id)) return false;
    if (!this.api.native) {
      this.hooks.notify("Use the desktop app to save a document.");
      return false;
    }
    // The file the tab was opened from; pasted text and opened results have none.
    const own = tab.source && !tab.pasted ? tab.source : null;
    const target = as ? null : this.saveTarget(id);
    if (target && !tab.dirty) {
      this.hooks.notify("No changes to save.");
      return true;
    }
    this.saving.add(id);
    let snapshot: FileDocument | undefined;
    try {
      const path =
        target ??
        (await this.api.chooseDocumentOutput(tab.savedPath ?? own?.path ?? tab.name));
      if (!path) return false;
      let doc = tab.source;
      if (tab.text !== null) {
        snapshot = await this.api.createTextDocument(
          tab.text,
          tab.name,
          snapshotFormat(tab),
        );
        doc = snapshot;
      }
      if (!doc) throw new Error("There is no document to save.");
      const saved = await this.api.saveDocument(doc.id, path, target ? "inPlace" : "confirmed", own?.id);
      // The tab now belongs to the file it wrote. Adopting that document is what lets
      // the next Save check the file for outside changes, and lets the file it came
      // from be opened again as itself rather than finding this tab.
      this.dispatch({ type: "saved", id, text: tab.text, path: saved.path, source: saved });
      if (tab.source && tab.source.id !== saved.id) this.retire(tab.source.id);
      this.hooks.notify(`Saved ${displayPath(saved.path)}`);
      return true;
    } catch (error) {
      // A failed save is not a failed tool run: the result and the edits stay.
      this.hooks.notify(`Not saved: ${errorText(error)}`);
      return false;
    } finally {
      if (snapshot) this.retire(snapshot.id);
      this.saving.delete(id);
    }
  }
  async saveOutput(id: string) {
    const tab = this.tab(id);
    const event = tab?.result?.event;
    if (
      !tab ||
      tab.resultStale ||
      tab.phase !== "success" ||
      !event?.ok ||
      !event.resultDocumentId
    )
      return;
    const token = tokenFor(tab);
    const resultId = event.resultDocumentId;
    this.savingResults.add(resultId);
    try {
      const extension = resultExtension(tab, event.resultMime);
      const document = tab.source ?? ({ path: tab.name } as FileDocument);
      const path = await this.api.chooseResultOutput(document, {
        title: "Save result as",
        suffix: `.${tab.operation}.${extension}`,
        filterName: extension.toUpperCase(),
        extensions: [extension],
      });
      if (!path) return;
      if (!this.current(token)) {
        this.hooks.notify(
          "The result changed while choosing a destination. Save the current result instead.",
        );
        return;
      }
      // The dialog asked before replacing an existing file, so a chosen path is confirmed.
      await this.api.saveResult(resultId, path, "confirmed");
      this.hooks.notify(`Saved result: ${path}`);
    } catch (error) {
      // Keep the result: the save failed, not the tool, and the user may want to try elsewhere.
      this.hooks.notify(`Result not saved: ${errorText(error)}`);
    } finally {
      this.savingResults.delete(resultId);
      this.cleanup();
    }
  }
  async close(id: string): Promise<boolean> {
    const tab = this.tab(id);
    if (!tab || this.closing.has(id)) return false;
    this.closing.add(id);
    try {
      if (tab.dirty || tab.rightDirty) {
        const answer = await this.hooks.confirmClose(tab);
        if (answer === "cancel") return false;
        if (
          answer === "save" &&
          (!(await this.save(id)) || this.tab(id)?.dirty)
        )
          return false;
      }
      this.invalidate(id);
      this.dispatch({ type: "close", id });
      if (tab.source) this.retire(tab.source.id);
      return true;
    } finally {
      this.closing.delete(id);
    }
  }
  dispose() {
    this.disposed = true;
    this.stopEvents?.();
    if (this.poll) clearInterval(this.poll);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const task of this.tasks)
      if (task.jobId)
        void this.api.cancelOperation(task.jobId).catch(() => undefined);
  }
}
