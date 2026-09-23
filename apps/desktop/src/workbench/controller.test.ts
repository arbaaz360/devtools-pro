import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { WorkbenchController, IMAGE_IMPORT_LIMIT, type WorkbenchApi } from "./controller.ts";
import { EDIT_LIMIT, TEXT_IMPORT_LIMIT } from "./state.ts";
import type { FileDocument, Format, JobFinished, ToolManifest } from "../bridge.ts";

const PAGE_BYTES = 64 * 1024;
// This value is intentionally larger than the editor limit and is not a
// repeated preview page, so missing/duplicated/out-of-order pages are visible.
const IMAGE_BYTES = Buffer.from(Array.from({ length: 900_001 }, (_, i) => i % 251));
const BASE64 = `data:image/png;base64,${IMAGE_BYTES.toString("base64")}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out: ${message}`);
    // Let pending controller microtasks and zero-delay operation timers run.
    await setImmediate();
  }
}

function manifest(id: string, operation: string): ToolManifest {
  return {
    id, label: id, contractVersion: 1, inputKinds: ["any"],
    limits: { maxInputBytes: TEXT_IMPORT_LIMIT, maxOutputBytes: null },
    capabilities: {
      deterministic: true, supportsPreview: true, supportsStreaming: true,
      cancellation: true, progress: true, needsFilesystem: false,
      needsNetwork: false, needsSecrets: false,
    },
    operations: [{ id: operation, label: operation, defaultOptions: {} }],
    renderer: id === "encoding.base64-image" ? "binary" : "text",
  };
}

/** In-memory host only. All state transitions under test use the real controller. */
async function harness(t: TestContext) {
  let serial = 0;
  let finish: (event: JobFinished) => void = () => { throw new Error("Not initialized"); };
  const documents = new Map<string, { document: FileDocument; text: string }>();
  const paths = new Map<string, FileDocument>();
  const creates: { text: string; name?: string; format?: Format }[] = [];
  const reads: { id: string; offset: number }[] = [];
  const runs: { id: string; tool: string; operation: string; bytes: number; jobId: string }[] = [];
  const closed: string[] = [];
  const notices: string[] = [];
  const effects: {
    create?: WorkbenchApi["createTextDocument"];
    read?: WorkbenchApi["readPreview"];
  } = {};

  function page(id: string, offset = 0): FileDocument {
    const entry = documents.get(id);
    assert.ok(entry, `Host document ${id} must still be open`);
    const bytes = Buffer.from(entry.text);
    const chunk = bytes.subarray(offset, offset + PAGE_BYTES);
    return {
      ...entry.document,
      preview: chunk.toString("utf8"), offset, bytesRead: chunk.length,
      truncated: offset + chunk.length < entry.document.size,
    };
  }
  function register(text: string, changes: Partial<FileDocument> = {}): FileDocument {
    const id = changes.id ?? `doc-${++serial}`;
    const size = Buffer.byteLength(text);
    const document: FileDocument = {
      id, name: `${id}.txt`, path: `/mock/${id}.txt`, size,
      preview: text.slice(0, PAGE_BYTES), truncated: size > PAGE_BYTES,
      format: "text", encoding: "UTF-8", contentKind: "text", mime: "text/plain",
      editable: size <= EDIT_LIMIT, offset: 0,
      bytesRead: Math.min(size, PAGE_BYTES), ...changes,
    };
    documents.set(id, { document, text });
    paths.set(document.path, document);
    return document;
  }
  const api: WorkbenchApi = {
    native: true,
    chooseFile: async () => null,
    openDocument: async (path) => {
      const document = paths.get(path);
      assert.ok(document, `Missing mock path ${path}`);
      return document;
    },
    createTextDocument: async (text, name, format) => {
      creates.push({ text, name, format });
      return effects.create
        ? effects.create(text, name, format)
        : register(text, { name: name ?? "Untitled.txt", format: format ?? "text" });
    },
    closeDocument: async (id) => { closed.push(id); documents.delete(id); },
    readPreview: async (id, offset = 0) => {
      reads.push({ id, offset });
      return effects.read ? effects.read(id, offset) : page(id, offset);
    },
    readBinaryPreview: async (id) => {
      assert.ok(documents.has(id), `Binary source ${id} must be live`);
      return { mime: "image/png", data: "data:image/png;base64,iVBORw0KGgo=", bytes: 8, truncated: false };
    },
    runTool: async (id, tool, operation) => {
      const entry = documents.get(id);
      assert.ok(entry, "Tools must receive a registered full-document handle");
      const jobId = `job-${runs.length + 1}`;
      runs.push({ id, tool, operation, bytes: entry.document.size, jobId });
      return { jobId };
    },
    runCompare: async () => { throw new Error("Unexpected comparison"); },
    cancelOperation: async () => undefined,
    jobStatus: async () => null,
    subscribeJobs: async (_progress, callback) => { finish = callback; return () => undefined; },
    listTools: async () => [
      manifest("encoding.image-base64", "encode"),
      manifest("encoding.base64-image", "decode"),
      manifest("encoding.hash", "sha256"),
      manifest("text.url", "encode"),
      manifest("plugin.echo", "run"),
      {
        ...manifest("format.explicit", "beautify"),
        auto: false,
        operations: [
          { id: "beautify", label: "Beautify", defaultOptions: { indent: "sp2" }, options: [], autoOnInput: false, autoOnOption: false },
          { id: "minify", label: "Minify", defaultOptions: { comments: "license" }, options: [], autoOnInput: false, autoOnOption: false },
        ],
      },
      {
        ...manifest("format.live", "run"),
        auto: true,
        operations: [{ id: "run", label: "Run", defaultOptions: {}, options: [], autoOnInput: true, autoOnOption: true }],
      },
      {
        // Shaped like identity.uuid after AG-126: generate reads no document, decode does.
        ...manifest("gen.value", "generate"),
        auto: true,
        emptyInput: true,
        operations: [
          { id: "generate", label: "Generate", defaultOptions: {}, options: [], autoOnInput: false, autoOnOption: true, readsDocument: false },
          { id: "decode", label: "Decode", defaultOptions: {}, options: [], autoOnInput: true, autoOnOption: true, readsDocument: true },
        ],
      },
      manifest("text.compare", "compare"),
    ],
    chooseDocumentOutput: async () => null,
    saveDocument: async () => undefined,
    chooseResultOutput: async () => null,
    saveResult: async () => undefined,
  };
  const controller = new WorkbenchController(api, {
    changed: () => undefined,
    notify: (message) => { notices.push(message); },
    confirmClose: async () => "discard",
  });
  t.after(() => controller.dispose());
  await controller.initialize();

  function newTab(text = ""): string {
    controller.newDocument();
    const id = controller.state.activeId!;
    if (text) controller.edit(id, text);
    return id;
  }
  function complete(jobId: string, result: FileDocument) {
    finish({
      jobId, ok: true, cancelled: false, summary: "Complete", elapsedMs: 1,
      inputBytes: 8, outputBytes: result.size, resultDocumentId: result.id,
      renderer: "text", resultMime: "text/plain",
    });
  }
  async function resultTab(text: string, changes: Partial<FileDocument> = {}, editable = false) {
    let id: string;
    if (editable) {
      id = newTab("original");
      controller.selectTool(id, "text.url");
    } else {
      const image = register("image", { contentKind: "image", mime: "image/png", editable: false, path: "/mock/input.png", name: "input.png" });
      await controller.openPath(image.path);
      id = controller.state.activeId!;
    }
    await waitFor(() => !!controller.tab(id)?.jobId, "source job to start");
    const result = register(text, changes);
    complete(controller.tab(id)!.jobId!, result);
    await waitFor(() => controller.tab(id)?.phase === "success", "source result to become current");
    return { id, result };
  }
  return { controller, effects, register, page, newTab, resultTab, complete, documents, creates, reads, runs, closed, notices };
}

test("copy complete paged Base64 then replace a 64 KiB fragment and decode the full host handle", async (t) => {
  const h = await harness(t);
  assert.ok(Buffer.byteLength(BASE64) > EDIT_LIMIT);
  const source = await h.resultTab(BASE64);
  assert.equal(h.controller.tab(source.id)?.result?.text.length, PAGE_BYTES);
  assert.equal(h.controller.tab(source.id)?.result?.truncated, true);
  h.reads.length = 0;

  const copied = await h.controller.readResultClipboard(source.id);
  assert.equal(copied, BASE64);
  assert.deepEqual(Buffer.from(copied.split(",")[1], "base64"), IMAGE_BYTES);
  assert.deepEqual(h.reads.map((read) => read.offset),
    Array.from({ length: Math.ceil(BASE64.length / PAGE_BYTES) }, (_, i) => i * PAGE_BYTES));

  const fragment = copied.slice(0, PAGE_BYTES);
  const destination = h.newTab(fragment);
  h.controller.selectTool(destination, "encoding.base64-image");
  const createdBefore = h.creates.length;
  await h.controller.paste(destination, copied, 0, fragment.length);
  const imported = h.controller.tab(destination)!;
  assert.equal(imported.text, null);
  assert.equal(imported.source?.size, Buffer.byteLength(BASE64));
  assert.equal(imported.source?.preview.length, PAGE_BYTES);
  assert.equal(imported.toolId, "encoding.base64-image");
  assert.equal(imported.operation, "decode");
  assert.equal(imported.dirty, true);
  assert.equal(imported.pasted, true);
  assert.deepEqual(imported.undo, []);

  await waitFor(() => h.runs.some((run) => run.tool === "encoding.base64-image"), "decode to start");
  const decode = h.runs.find((run) => run.tool === "encoding.base64-image")!;
  assert.equal(decode.id, imported.source!.id);
  assert.equal(decode.bytes, Buffer.byteLength(BASE64));
  assert.equal(h.creates.length - createdBefore, 1, "No second snapshot of the 64 KiB preview may be created");
  assert.equal(h.creates.at(-1)?.text, BASE64);
  assert.equal(h.documents.get(decode.id)?.text, BASE64);
  assert.ok(!h.closed.includes(decode.id), "Imported source must remain live for the decoder");
});

test("a compare with an empty side never creates a host snapshot or a job", async (t) => {
  const h = await harness(t);
  const id = h.newTab("left text");
  h.controller.selectTool(id, "text.compare");
  const created = h.creates.length;
  h.controller.right(id, "");
  // Let the auto-run debounce elapse, then force a run: the gate must stop
  // both before anything reaches the host.
  await new Promise((resolve) => setTimeout(resolve, 400));
  h.controller.run(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.creates.length, created, "an empty side is never snapshotted");
  assert.equal(h.controller.tab(id)?.phase, "idle");
  assert.equal(h.controller.tab(id)?.jobId, null);
  assert.equal(h.controller.tab(id)?.result, null, "a gated compare keeps no stale result");
  assert.equal(h.controller.tab(id)?.rightDirty, false);

  h.controller.right(id, "right text");
  assert.equal(h.controller.tab(id)?.rightDirty, true);
  h.controller.run(id);
  await waitFor(() => h.creates.length === created + 2, "both sides snapshotted once the gate opens");
  await waitFor(() => h.controller.tab(id)?.phase === "error", "the harness rejects the comparison");
});

test("host manifests add tools to the catalog without shell registration", async (t) => {
  const h = await harness(t);
  const custom = h.controller.availableTools().find((tool) => tool.id === "plugin.echo");
  assert.equal(custom?.label, "plugin.echo");
  assert.deepEqual(custom?.operations, [{ id: "run", label: "run" }]);
  assert.equal(h.controller.toolDefinition("plugin.echo")?.defaultOperation, "run");
  assert.equal(h.controller.availableTools().some((tool) => tool.id === "plugin.missing"), false);
});

test("a pending import stays attached to its original tab after switching tabs", async (t) => {
  const h = await harness(t);
  const first = h.newTab("keep");
  h.controller.selectTool(first, "encoding.base64-image");
  const pending = deferred<FileDocument>();
  h.effects.create = async () => pending.promise;
  const paste = h.controller.paste(first, BASE64, 0, 4);
  assert.equal(h.controller.tab(first)?.phase, "importing");
  const second = h.newTab("other tab");
  const document = h.register(BASE64);
  pending.resolve(document);
  await paste;
  assert.equal(h.controller.state.activeId, second);
  assert.equal(h.controller.tab(first)?.source?.id, document.id);
  assert.equal(h.controller.tab(first)?.toolId, "encoding.base64-image");
  assert.equal(h.controller.tab(first)?.dirty, true);
  assert.equal(h.controller.tab(second)?.text, "other tab");
  assert.equal(h.controller.tab(second)?.source, null);
});

for (const action of ["close", "change-tool", "edit", "dispose"] as const) {
  test(`${action} during a pending import releases the orphan instead of attaching it`, async (t) => {
    const h = await harness(t);
    const id = h.newTab("previous input");
    h.controller.selectTool(id, "encoding.base64-image");
    const pending = deferred<FileDocument>();
    h.effects.create = async () => pending.promise;
    const paste = h.controller.paste(id, BASE64, 0, "previous input".length);
    assert.equal(h.controller.tab(id)?.phase, "importing");
    if (action === "close") assert.equal(await h.controller.close(id), true);
    else if (action === "change-tool") h.controller.selectTool(id, "editor.text");
    else if (action === "edit") h.controller.edit(id, "newer edit");
    else h.controller.dispose();
    const orphan = h.register(BASE64);
    pending.resolve(orphan);
    await paste;
    await waitFor(() => h.closed.includes(orphan.id), "orphan import handle to be closed");
    assert.notEqual(h.controller.tab(id)?.source?.id, orphan.id);
    if (action === "close") assert.equal(h.controller.tab(id), undefined);
    if (action === "change-tool") {
      assert.equal(h.controller.tab(id)?.toolId, "editor.text");
      assert.equal(h.controller.tab(id)?.text, "previous input");
    }
    if (action === "edit") assert.equal(h.controller.tab(id)?.text, "newer edit");
  });
}

test("import failure preserves the original source, text, tool and saved state", async (t) => {
  const h = await harness(t);
  const original = h.register("original input");
  await h.controller.openPath(original.path);
  const id = h.controller.state.activeId!;
  h.controller.selectTool(id, "encoding.base64-image");
  h.effects.create = async () => { throw new Error("disk full"); };
  await h.controller.paste(id, BASE64, 0, original.preview.length);
  const tab = h.controller.tab(id)!;
  assert.equal(tab.source?.id, original.id);
  assert.equal(tab.text, "original input");
  assert.equal(tab.savedText, "original input");
  assert.equal(tab.dirty, false);
  assert.equal(tab.toolId, "encoding.base64-image");
  assert.equal(tab.phase, "error");
  assert.match(tab.error ?? "", /disk full.*previous input is unchanged/i);
  assert.ok(!h.closed.includes(original.id));
  assert.equal(h.runs.length, 0);
});

test("oversize combined paste is rejected before any host allocation or state change", async (t) => {
  const h = await harness(t);
  const id = h.newTab("prefix");
  const before = h.controller.tab(id);
  // The clipboard alone is at the limit; insertion into existing input exceeds it.
  await h.controller.paste(id, "x".repeat(TEXT_IMPORT_LIMIT), 6, 6);
  assert.equal(h.controller.tab(id), before);
  assert.equal(h.creates.length, 0);
  assert.ok(h.notices.some((notice) => /exceeds 36 MiB/.test(notice)));
});

test("copy rejects an oversized result from its first page metadata without reading the body", async (t) => {
  const h = await harness(t);
  const source = await h.resultTab("x".repeat(PAGE_BYTES), { size: TEXT_IMPORT_LIMIT + 1, editable: false });
  h.reads.length = 0;
  await assert.rejects(h.controller.readResultClipboard(source.id), /36 MiB limit/);
  assert.deepEqual(h.reads, [{ id: source.result.id, offset: 0 }]);
  assert.ok(!h.closed.includes(source.result.id), "A rejected clipboard copy must not destroy the current result");
});

test("clipboard refuses stale results while the editable result limit stays at one MiB", async (t) => {
  const h = await harness(t);
  const source = await h.resultTab(BASE64, {}, true);
  await assert.rejects(h.controller.readResultText(source.id), /1 MiB limit/);
  h.controller.edit(source.id, "changed source");
  assert.equal(h.controller.tab(source.id)?.resultStale, true);
  h.reads.length = 0;
  await assert.rejects(h.controller.readResultClipboard(source.id), /no longer current/);
  assert.equal(h.reads.length, 0);
});

test("an in-flight clipboard read pins its result until stale-read refusal releases it", async (t) => {
  const h = await harness(t);
  const source = await h.resultTab(BASE64);
  const pending = deferred<FileDocument>();
  h.reads.length = 0;
  h.effects.read = async (id, offset = 0) => offset === PAGE_BYTES ? pending.promise : h.page(id, offset);
  const copying = h.controller.readResultClipboard(source.id);
  const rejected = assert.rejects(copying, /result changed/);
  await waitFor(() => h.reads.length === 2, "clipboard copy to reach its pending second page");
  const secondPage = h.page(source.result.id, PAGE_BYTES);
  h.controller.cancel(source.id);
  assert.ok(!h.closed.includes(source.result.id), "The pending read must still own the result handle");
  pending.resolve(secondPage);
  await rejected;
  await waitFor(() => h.closed.includes(source.result.id), "stale result to be released after the read");
});

test("small paste replaces only the textarea selection and preserves Unicode and dollar text", async (t) => {
  const h = await harness(t);
  const id = h.newTab("A😀Z");
  await h.controller.paste(id, "$&\n東京", 1, 3);
  assert.equal(h.controller.tab(id)?.text, "A$&\n東京Z");
  assert.equal(h.controller.tab(id)?.dirty, true);
  assert.equal(h.creates.length, 0);
  h.controller.history(id, "undo");
  assert.equal(h.controller.tab(id)?.text, "A😀Z");
  await h.controller.paste(id, "", 0, 1);
  assert.equal(h.controller.tab(id)?.text, "A😀Z");
});

test("large read-only preview accepts full replacement but rejects a partial preview paste", async (t) => {
  const h = await harness(t);
  const original = h.register(BASE64);
  await h.controller.openPath(original.path);
  const id = h.controller.state.activeId!;
  assert.equal(h.controller.tab(id)?.text, null);
  await h.controller.paste(id, "partial", 1, 3);
  assert.equal(h.creates.length, 0);
  assert.equal(h.controller.tab(id)?.source?.id, original.id);
  assert.ok(h.notices.some((notice) => /Select all/.test(notice)));
  await h.controller.paste(id, "small replacement", 0, original.preview.length);
  assert.equal(h.controller.tab(id)?.text, "small replacement");
  assert.equal(h.controller.tab(id)?.dirty, true);
  assert.ok(h.closed.includes(original.id));
});

test("native file drop of text, JSON, and image preserves active dirty tab and detects correct tools", async (t) => {
  const h = await harness(t);
  const dirtyTabId = h.newTab("my dirty draft notes");
  assert.equal(h.controller.tab(dirtyTabId)?.dirty, true);

  // 1. Drop text file
  const textDoc = h.register("plain file content", { name: "notes.txt", path: "/mock/notes.txt", format: "text" });
  await h.controller.openPath(textDoc.path);
  assert.equal(h.controller.state.tabs.length, 2);
  const textTabId = h.controller.state.activeId!;
  assert.notEqual(textTabId, dirtyTabId);
  const textTab = h.controller.tab(textTabId)!;
  assert.equal(textTab.name, "notes.txt");
  assert.equal(textTab.text, "plain file content");
  assert.equal(textTab.savedText, "plain file content");
  assert.equal(textTab.dirty, false);
  assert.equal(textTab.toolId, "editor.text");
  // Preceding dirty tab must remain unchanged
  assert.equal(h.controller.tab(dirtyTabId)?.text, "my dirty draft notes");
  assert.equal(h.controller.tab(dirtyTabId)?.dirty, true);

  // 2. Drop JSON file
  const jsonDoc = h.register('{"hello":"world"}', { name: "data.json", path: "/mock/data.json", format: "json" });
  await h.controller.openPath(jsonDoc.path);
  assert.equal(h.controller.state.tabs.length, 3);
  const jsonTabId = h.controller.state.activeId!;
  assert.notEqual(jsonTabId, textTabId);
  const jsonTab = h.controller.tab(jsonTabId)!;
  assert.equal(jsonTab.name, "data.json");
  assert.equal(jsonTab.toolId, "structured.json");
  assert.equal(jsonTab.dirty, false);

  // 3. Drop image file
  const imageDoc = h.register("image bytes", {
    name: "photo.png",
    path: "/mock/photo.png",
    contentKind: "image",
    mime: "image/png",
    editable: false,
  });
  await h.controller.openPath(imageDoc.path);
  assert.equal(h.controller.state.tabs.length, 4);
  const imageTabId = h.controller.state.activeId!;
  const imageTab = h.controller.tab(imageTabId)!;
  assert.equal(imageTab.name, "photo.png");
  assert.equal(imageTab.toolId, "encoding.image-base64");
  assert.equal(imageTab.dirty, false);
  await waitFor(() => imageTab.image !== null, "image preview to load");

  // Verify dirty tab is still intact
  assert.equal(h.controller.tab(dirtyTabId)?.text, "my dirty draft notes");
  assert.equal(h.controller.tab(dirtyTabId)?.dirty, true);
});

test("dropping an already open file activates the existing tab instead of creating a duplicate", async (t) => {
  const h = await harness(t);
  const doc = h.register("re-dropped document", { name: "config.json", path: "/mock/config.json", format: "json" });
  await h.controller.openPath(doc.path);
  assert.equal(h.controller.state.tabs.length, 1);
  const firstId = h.controller.state.activeId!;

  // Create another tab and switch to it
  const otherId = h.newTab("temporary tab");
  assert.equal(h.controller.state.tabs.length, 2);
  assert.equal(h.controller.state.activeId, otherId);

  // Dropping config.json again
  await h.controller.openPath(doc.path);
  // Tab count must still be 2 (no duplicate tab created)
  assert.equal(h.controller.state.tabs.length, 2);
  // Existing tab must be activated
  assert.equal(h.controller.state.activeId, firstId);
});

test("concurrent duplicate drops of the same path produce a single tab", async (t) => {
  const h = await harness(t);
  const doc = h.register("concurrent drop", { name: "shared.txt", path: "/mock/shared.txt" });
  await Promise.all([
    h.controller.openPath(doc.path),
    h.controller.openPath(doc.path),
  ]);
  assert.equal(h.controller.state.tabs.length, 1);
});

test("dropping an unreadable or missing path notifies with error and preserves existing tabs", async (t) => {
  const h = await harness(t);
  const id = h.newTab("safe text");
  await h.controller.openPath("/mock/nonexistent-file.txt");
  assert.equal(h.controller.state.tabs.length, 1);
  assert.equal(h.controller.state.activeId, id);
  assert.equal(h.controller.tab(id)?.text, "safe text");
  assert.ok(h.notices.some((notice) => /missing mock path/i.test(notice)));
});

test("dropping a binary file opens tab with Hash generator without rejecting binary input", async (t) => {
  const h = await harness(t);
  const dirtyId = h.newTab("draft in progress");
  const binDoc = h.register("binary payload bytes", {
    name: "data.bin",
    path: "/mock/data.bin",
    contentKind: "binary",
    mime: "application/octet-stream",
    editable: false,
  });

  await h.controller.openPath(binDoc.path);

  // Must open a new tab for data.bin with Hash Generator, not reject it
  assert.equal(h.controller.state.tabs.length, 2);
  const activeTab = h.controller.tab(h.controller.state.activeId!)!;
  assert.equal(activeTab.name, "data.bin");
  assert.equal(activeTab.toolId, "encoding.hash");
  assert.equal(activeTab.text, null); // uneditable binary input
  assert.equal(activeTab.dirty, false);

  // Preceding dirty draft tab must remain untouched
  assert.equal(h.controller.tab(dirtyId)?.text, "draft in progress");
  assert.equal(h.controller.tab(dirtyId)?.dirty, true);

  // Opening binary document with a text-only tool override rejects with structured error
  const binDoc2 = h.register("binary payload 2", {
    name: "payload.bin",
    path: "/mock/payload.bin",
    contentKind: "binary",
    mime: "application/octet-stream",
    editable: false,
  });
  await h.controller.openPath(binDoc2.path, "structured.json");
  assert.equal(h.controller.state.tabs.length, 2);
  assert.ok(h.notices.some((n) => /requires a text document/i.test(n)));
});

test("browser file drop deterministically opens text, JSON, and image files without dirtying state", async (t) => {
  const h = await harness(t);
  const dirtyId = h.newTab("draft in progress");

  // 1. Text file
  const textFile = new File(["browser text"], "notes.txt", { type: "text/plain" });
  await h.controller.openBrowserFile(textFile);
  assert.equal(h.controller.state.tabs.length, 2);
  const textId = h.controller.state.activeId!;
  const textTab = h.controller.tab(textId)!;
  assert.equal(textTab.name, "notes.txt");
  assert.equal(textTab.text, "browser text");
  assert.equal(textTab.savedText, "browser text");
  assert.equal(textTab.dirty, false);
  assert.equal(textTab.toolId, "editor.text");

  // 2. JSON file
  const jsonFile = new File(['{"format":"browser"}'], "app.json", { type: "application/json" });
  await h.controller.openBrowserFile(jsonFile);
  assert.equal(h.controller.state.tabs.length, 3);
  const jsonId = h.controller.state.activeId!;
  const jsonTab = h.controller.tab(jsonId)!;
  assert.equal(jsonTab.name, "app.json");
  assert.equal(jsonTab.toolId, "structured.json");
  assert.equal(jsonTab.dirty, false);

  // 3. Image file
  const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "sample.png", { type: "image/png" });
  await h.controller.openBrowserFile(imageFile);
  assert.equal(h.controller.state.tabs.length, 4);
  const imageId = h.controller.state.activeId!;
  const imageTab = h.controller.tab(imageId)!;
  assert.equal(imageTab.name, "sample.png");
  assert.equal(imageTab.toolId, "encoding.image-base64");
  assert.equal(imageTab.dirty, false);
  assert.ok(imageTab.image?.data.startsWith("data:image/png;base64,"));

  // 4. Dropping existing file with path identity activates it
  const jsonFileWithPath = Object.assign(
    new File(['{"format":"browser"}'], "app.json", { type: "application/json" }),
    { path: "app.json" },
  );
  h.controller.activate(dirtyId);
  assert.equal(h.controller.state.activeId, dirtyId);
  await h.controller.openBrowserFile(jsonFileWithPath);
  assert.equal(h.controller.state.tabs.length, 4);
  assert.equal(h.controller.state.activeId, jsonId);

  // 5. Preceding dirty draft is untouched
  assert.equal(h.controller.tab(dirtyId)?.text, "draft in progress");
  assert.equal(h.controller.tab(dirtyId)?.dirty, true);
});

test("refuses oversized image files before reading body in browser drop", async (t) => {
  const h = await harness(t);
  let bodyRead = false;
  const oversizedImage = {
    name: "huge.png",
    size: IMAGE_IMPORT_LIMIT + 1,
    type: "image/png",
    arrayBuffer: async () => {
      bodyRead = true;
      return new ArrayBuffer(0);
    },
    text: async () => {
      bodyRead = true;
      return "";
    },
  } as unknown as File;

  await h.controller.openBrowserFile(oversizedImage);

  assert.equal(bodyRead, false, "Image body must not be read when file exceeds limit");
  assert.equal(h.controller.state.tabs.length, 0);
  assert.ok(
    h.notices.some((n) => /Image exceeds the 25 MiB import limit/i.test(n)),
    "Must report structured user-facing limit notification",
  );
});

test("does not deduplicate browser drops by filename alone without path identity", async (t) => {
  const h = await harness(t);
  const file1 = {
    name: "notes.txt",
    size: 11,
    type: "text/plain",
    text: async () => "content one",
  } as unknown as File;
  const file2 = {
    name: "notes.txt",
    size: 11,
    type: "text/plain",
    text: async () => "content two",
  } as unknown as File;

  await h.controller.openBrowserFile(file1);
  assert.equal(h.controller.state.tabs.length, 1);
  assert.equal(h.controller.state.tabs[0].name, "notes.txt");
  assert.equal(h.controller.state.tabs[0].text, "content one");

  // Dropping second file with same name without path creates a distinct tab
  await h.controller.openBrowserFile(file2);
  assert.equal(h.controller.state.tabs.length, 2);
  assert.equal(h.controller.state.tabs[1].name, "notes.txt");
  assert.equal(h.controller.state.tabs[1].text, "content two");

  // File with reliable path identity activates existing tab
  const fileWithPath1 = {
    name: "config.json",
    path: "/home/user/config.json",
    size: 13,
    type: "application/json",
    text: async () => '{"key":"val"}',
  } as unknown as File;
  const fileWithPath2 = {
    name: "config.json",
    path: "/home/user/config.json",
    size: 13,
    type: "application/json",
    text: async () => '{"key":"val"}',
  } as unknown as File;

  await h.controller.openBrowserFile(fileWithPath1);
  assert.equal(h.controller.state.tabs.length, 3);
  const configTabId = h.controller.state.activeId!;

  // Switch to first tab
  h.controller.activate(h.controller.state.tabs[0].id);
  assert.notEqual(h.controller.state.activeId, configTabId);

  // Drop with same path activates existing tab
  await h.controller.openBrowserFile(fileWithPath2);
  assert.equal(h.controller.state.tabs.length, 3);
  assert.equal(h.controller.state.activeId, configTabId);
});


test("an operation that declares explicit-only execution waits for its button", async (t) => {
  const h = await harness(t);
  const id = h.newTab();
  h.controller.selectTool(id, "format.explicit");
  h.controller.edit(id, ".a{color:red}");
  await setImmediate();
  await setImmediate();
  assert.equal(h.runs.length, 0, "typing must not start a run the manifest did not ask for");

  // Changing an option is not a request to run either.
  h.controller.options(id, "beautify", { indent: "sp4" });
  await setImmediate();
  await setImmediate();
  assert.equal(h.runs.length, 0);

  // Pressing the operation runs it.
  h.controller.options(id, "beautify", { indent: "sp4" }, true);
  await waitFor(() => h.runs.length === 1, "the press should run the operation");
  assert.equal(h.runs[0]!.operation, "beautify");
});

test("a tool that follows the document still runs as it is edited", async (t) => {
  const h = await harness(t);
  const id = h.newTab();
  h.controller.selectTool(id, "format.live");
  h.controller.edit(id, "hello");
  await waitFor(() => h.runs.length >= 1, "an inputChange tool runs without a press");
});

test("switching operation takes the new operation's defaults", async (t) => {
  const h = await harness(t);
  const id = h.newTab("body{}");
  h.controller.selectTool(id, "format.explicit");
  assert.deepEqual(h.controller.tab(id)!.options, { indent: "sp2" });
  h.controller.options(id, "minify", { indent: "sp4" }, true);
  assert.deepEqual(h.controller.tab(id)!.options, { comments: "license" },
    "an option the new operation does not declare must not travel with the switch");
});

/** Run the tab's pending job to a successful result. */
async function settleRun(h: Awaited<ReturnType<typeof harness>>, id: string, text: string) {
  await waitFor(() => !!h.controller.tab(id)?.jobId, "a job to start");
  h.complete(h.controller.tab(id)!.jobId!, h.register(text));
  await waitFor(() => h.controller.tab(id)?.phase === "success", "the result to arrive");
}

test("typing beside a generator neither runs it nor stales what it generated", async (t) => {
  const h = await harness(t);
  const id = h.newTab();
  h.controller.selectTool(id, "gen.value");
  await settleRun(h, id, "48db5802-4b4e-41fe-b9f3-e419ede464ae");
  h.controller.edit(id, "not a uuid");
  await setImmediate();
  await setImmediate();
  const tab = h.controller.tab(id)!;
  assert.equal(h.runs.length, 1, "generate declares no inputChange and no document input");
  assert.equal(tab.resultStale, false, "the value it generated is still the answer");
  assert.ok(tab.result, "and it stays on screen");
});

test("an edit an explicit-only operation will not act on leaves its result out of date", async (t) => {
  const h = await harness(t);
  const id = h.newTab(".a{color:red}");
  h.controller.selectTool(id, "format.explicit");
  h.controller.options(id, "beautify", { indent: "sp2" }, true);
  await settleRun(h, id, ".a {\n  color: red;\n}");

  h.controller.edit(id, ".a{color:blue}");
  await setImmediate();
  assert.equal(h.runs.length, 1);
  assert.equal(h.controller.tab(id)!.resultStale, true);
  assert.equal(h.controller.tab(id)!.resultOutdated, true, "nothing is updating it");

  // An option change it will not run on says the same.
  h.controller.options(id, "beautify", { indent: "sp4" });
  await setImmediate();
  assert.equal(h.runs.length, 1);
  assert.equal(h.controller.tab(id)!.resultOutdated, true);

  // The press is the update.
  h.controller.options(id, "beautify", { indent: "sp4" }, true);
  await waitFor(() => h.runs.length === 2, "the press runs it");
  assert.equal(h.controller.tab(id)!.resultOutdated, false);
});

test("a tool that follows the document is updating after an edit, until the document is emptied", async (t) => {
  const h = await harness(t);
  const id = h.newTab("hello");
  h.controller.selectTool(id, "format.live");
  await settleRun(h, id, "HELLO");

  h.controller.edit(id, "hello there");
  assert.equal(h.controller.tab(id)!.resultStale, true);
  assert.equal(h.controller.tab(id)!.resultOutdated, false, "a run is scheduled");
  await settleRun(h, id, "HELLO THERE");

  // An empty document is not sent to the tool, so nothing replaces the old result.
  h.controller.edit(id, "");
  await setImmediate();
  assert.equal(h.runs.length, 2);
  assert.equal(h.controller.tab(id)!.resultOutdated, true);
});
