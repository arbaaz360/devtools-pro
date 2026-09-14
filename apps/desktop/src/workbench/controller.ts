import type {
  BinaryPreview,
  FileDocument,
  Format,
  JobFinished,
  JobProgress,
  ToolManifest,
  SaveSuggestion,
} from "../bridge";
import {
  EDIT_LIMIT,
  MAX_TABS,
  emptyWorkspace,
  makeTab,
  matches,
  reduce,
  tokenFor,
} from "./state";
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
} from "./tools";

export interface WorkbenchApi {
  native: boolean;
  chooseFile(): Promise<string | null>;
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
  ): Promise<{ jobId: string }>;
  runCompare(
    left: string,
    right: string,
    options: Record<string, unknown>,
  ): Promise<{ jobId: string }>;
  cancelOperation(id: string): Promise<void>;
  jobStatus(id: string): Promise<JobFinished | null>;
  subscribeJobs(
    progress: (e: JobProgress) => void,
    finish: (e: JobFinished) => void,
  ): Promise<() => void>;
  listTools(): Promise<ToolManifest[]>;
  chooseDocumentOutput(name: string): Promise<string | null>;
  saveDocument(id: string, path: string): Promise<void>;
  chooseResultOutput(
    document: FileDocument,
    suggestion: SaveSuggestion,
  ): Promise<string | null>;
  saveResult(id: string, path: string): Promise<void>;
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

/** Effects live here; the reducer owns all tab state. No effect targets the active tab implicitly. */
export class WorkbenchController {
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
  constructor(
    private api: WorkbenchApi,
    private hooks: WorkbenchHooks,
  ) {}

  private dispatch(action: Action) {
    this.state = reduce(this.state, action);
    this.hooks.changed(this.state);
  }
  tab(id: string) {
    return this.state.tabs.find((tab) => tab.id === id);
  }
  private current(token: RunToken) {
    return matches(this.tab(token.tabId), token);
  }
  availableTools() {
    return bundledTools.filter(
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
  async chooseFile() {
    try {
      const path = await this.api.chooseFile();
      if (path) await this.openPath(path);
    } catch (error) {
      this.hooks.notify(errorText(error));
    }
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
  async openPath(path: string) {
    if (!this.api.native) {
      this.hooks.notify("Open the native desktop app to read local files.");
      return;
    }
    let opened: FileDocument | undefined;
    try {
      if (this.state.tabs.length >= MAX_TABS)
        throw new Error("Close a tab before opening another (16-tab limit).");
      opened = await this.api.openDocument(path);
      const text = await this.readEditable(opened);
      if (this.state.tabs.length >= MAX_TABS)
        throw new Error("The tab limit was reached while opening this file.");
      const tab = makeTab(`tab-${++this.nextId}`, opened.name, opened, text);
      const tool = definition(defaultTool(opened))!;
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
      this.hooks.notify(errorText(error));
    }
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
    const tool = definition(toolId);
    if (!tab || !tool || tab.toolId === toolId) return;
    this.invalidate(id);
    this.dispatch({
      type: "tool",
      id,
      toolId,
      operation: tool.defaultOperation,
      options: { ...tool.defaultOptions },
    });
    this.schedule(id, 0);
  }
  edit(id: string, text: string) {
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
  history(id: string, type: "undo" | "redo") {
    this.invalidate(id);
    this.dispatch({ type, id });
    this.schedule(id);
  }
  options(id: string, operation: string, options: Record<string, unknown>) {
    const tab = this.tab(id);
    const tool = tab && definition(tab.toolId);
    if (!tool?.operations.some((op) => op.id === operation)) return;
    this.invalidate(id);
    this.dispatch({ type: "options", id, operation, options });
    this.schedule(id, 0);
  }
  right(id: string, text: string) {
    if (new TextEncoder().encode(text).length > EDIT_LIMIT) {
      this.hooks.notify("Comparison text is limited to 1 MiB.");
      return;
    }
    this.invalidate(id);
    this.dispatch({ type: "right", id, text });
    this.schedule(id);
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
      if (this.tab(id)) this.right(id, text);
    } catch (error) {
      this.dispatch({ type: "error", id, message: errorText(error) });
    } finally {
      if (doc) this.retire(doc.id);
    }
  }
  private schedule(id: string, delay = 350) {
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const tab = this.tab(id);
    const tool = tab && definition(tab.toolId);
    if (!tab || !tool?.auto) return;
    if (tab.text === "" && tool.id !== "encoding.hash" && !tool.compare) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.run(id);
      }, delay),
    );
  }
  run(id: string) {
    const tab = this.tab(id);
    const tool = tab && definition(tab.toolId);
    if (!tab || !tool?.auto) return;
    const problem = validation(tab, tool, this.manifests.get(tool.id));
    if (problem) {
      this.dispatch({ type: "error", id, message: problem });
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
      if (definition(task.tab.toolId)?.compare) {
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
        if (
          event.renderer === "binary" ||
          event.resultMime?.startsWith("image/")
        )
          view.image = await this.api.readBinaryPreview(event.resultDocumentId);
        else {
          const preview = await this.api.readPreview(event.resultDocumentId);
          view.text = preview.preview;
          view.truncated = preview.truncated;
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
            task.tab.result?.event.resultDocumentId === id,
        )
      )
        continue;
      this.retired.delete(id);
      void this.api.closeDocument(id).catch(() => undefined);
    }
  }
  async save(id: string): Promise<boolean> {
    const tab = this.tab(id);
    if (!tab || this.saving.has(id)) return false;
    if (!this.api.native) {
      this.hooks.notify("Use the desktop app to save a document.");
      return false;
    }
    this.saving.add(id);
    let snapshot: FileDocument | undefined;
    try {
      const path = await this.api.chooseDocumentOutput(
        tab.savedPath ?? tab.name,
      );
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
      await this.api.saveDocument(doc.id, path);
      this.dispatch({ type: "saved", id, text: tab.text, path });
      this.hooks.notify(`Saved ${path}`);
      return true;
    } catch (error) {
      this.dispatch({ type: "error", id, message: errorText(error) });
      return false;
    } finally {
      if (snapshot) this.retire(snapshot.id);
      this.saving.delete(id);
    }
  }
  async saveOutput(id: string) {
    const tab = this.tab(id);
    const event = tab?.result?.event;
    if (!tab || !event?.ok || !event.resultDocumentId) return;
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
      await this.api.saveResult(resultId, path);
      this.hooks.notify(`Saved result: ${path}`);
    } catch (error) {
      this.dispatch({ type: "error", id, message: errorText(error) });
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
      if (tab.dirty) {
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
    this.stopEvents?.();
    if (this.poll) clearInterval(this.poll);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const task of this.tasks)
      if (task.jobId)
        void this.api.cancelOperation(task.jobId).catch(() => undefined);
  }
}
