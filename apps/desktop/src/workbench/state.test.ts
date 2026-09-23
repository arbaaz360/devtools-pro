import test from "node:test";
import assert from "node:assert/strict";
import {
  makeTab,
  reduce,
  tokenFor,
  type ResultView,
  type WorkspaceState,
} from "./state.ts";

const result = (jobId: string): ResultView => ({
  event: {
    jobId,
    ok: true,
    cancelled: false,
    summary: "done",
    elapsedMs: 1,
    inputBytes: 1,
  },
  text: "result",
  truncated: false,
});

const workspaceWith = (...ids: string[]): WorkspaceState => ({
  tabs: ids.map((id) => makeTab(id, `${id}.txt`, null, "")),
  activeId: ids[0] ?? null,
});

test("blank tabs are independently editable and keep their own tool state", () => {
  let state = workspaceWith("one", "two");
  state = reduce(state, {
    type: "tool",
    id: "one",
    toolId: "structured.json",
    operation: "format",
    options: { indent: 2 },
  });
  state = reduce(state, { type: "edit", id: "one", text: '{"ok":true}' });

  const one = state.tabs.find((tab) => tab.id === "one");
  const two = state.tabs.find((tab) => tab.id === "two");
  assert.equal(one?.text, '{"ok":true}');
  assert.equal(one?.toolId, "structured.json");
  assert.deepEqual(one?.options, { indent: 2 });
  assert.equal(one?.dirty, true);
  assert.equal(two?.text, "");
  assert.equal(two?.toolId, "editor.text");
  assert.equal(two?.dirty, false);
});

test("stale completions cannot repaint a tab after an edit", () => {
  let state = workspaceWith("one");
  state = reduce(state, { type: "edit", id: "one", text: "new" });
  const oldToken = tokenFor(state.tabs[0]);
  state = reduce(state, { type: "queue", id: "one" });
  state = reduce(state, { type: "edit", id: "one", text: "newer" });
  state = reduce(state, {
    type: "result",
    token: oldToken,
    result: result("old-job"),
  });
  const tab = state.tabs[0];
  assert.equal(tab.text, "newer");
  assert.equal(tab.result, null);
  assert.equal(tab.phase, "idle");
});

test("job acceptance identity is scoped to the tab generation", () => {
  let state = workspaceWith("one");
  const token = tokenFor(state.tabs[0]);
  state = reduce(state, {
    type: "started",
    token,
    jobId: "job-1",
    identity: {
      pluginId: "legacy.builtin",
      pluginVersion: "0.1.0",
      toolId: "structured.json",
      operationId: "format",
      instanceId: "one",
      jobId: "job-1",
      generation: 0,
    },
  });
  assert.equal(state.tabs[0].jobIdentity?.jobId, "job-1");
  state = reduce(state, { type: "edit", id: "one", text: "{}" });
  assert.equal(state.tabs[0].jobIdentity, null);
});

test("same-tool edits retain the previous result while marking it stale", () => {
  let state = workspaceWith("one");
  const initial = state.tabs[0];
  state = reduce(state, {
    type: "result",
    token: tokenFor(initial),
    result: result("job-1"),
  });
  assert.equal(state.tabs[0].resultStale, false);
  state = reduce(state, { type: "edit", id: "one", text: "changed" });
  assert.equal(state.tabs[0].result?.event.jobId, "job-1");
  assert.equal(state.tabs[0].resultStale, true);
  state = reduce(state, { type: "error", id: "one", message: "invalid" });
  assert.equal(state.tabs[0].result, null);
  assert.equal(state.tabs[0].resultStale, false);
  assert.equal(state.tabs[0].phase, "error");
});

test("undo and redo preserve dirty state relative to the saved snapshot", () => {
  let state = workspaceWith("one");
  state = reduce(state, { type: "edit", id: "one", text: "a" });
  state = reduce(state, {
    type: "saved",
    id: "one",
    text: "a",
    path: "copy.txt",
  });
  state = reduce(state, { type: "edit", id: "one", text: "b" });
  state = reduce(state, { type: "undo", id: "one" });
  assert.equal(state.tabs[0].text, "a");
  assert.equal(state.tabs[0].dirty, false);
  state = reduce(state, { type: "redo", id: "one" });
  assert.equal(state.tabs[0].text, "b");
  assert.equal(state.tabs[0].dirty, true);
});

test("switching tools clears unrelated results and preserves per-tab find options", () => {
  let state = workspaceWith("one", "two");
  state = reduce(state, {
    type: "result",
    token: tokenFor(state.tabs[0]),
    result: result("json-job"),
  });
  state = reduce(state, {
    type: "find-options",
    id: "one",
    patch: { findQuery: "alpha", findReplacement: "beta", findWholeWord: true },
  });
  state = reduce(state, {
    type: "tool",
    id: "one",
    toolId: "text.find-replace",
    operation: "find",
    options: {},
  });
  assert.equal(state.tabs[0].result, null);
  assert.equal(state.tabs[0].findQuery, "alpha");
  assert.equal(state.tabs[0].findReplacement, "beta");
  assert.equal(state.tabs[0].findWholeWord, true);
  assert.equal(state.tabs[1].findQuery, "");
});

test("the right side tracks its own baseline and unsaved state", () => {
  let state = workspaceWith("one");
  const tab = () => state.tabs[0];
  state = reduce(state, { type: "right", id: "one", text: "typed" });
  assert.equal(tab().rightDirty, true, "typed text would be lost on close");
  assert.equal(tab().dirty, false, "the left document is untouched");
  state = reduce(state, { type: "right", id: "one", text: "from disk", baseline: "from disk" });
  assert.equal(tab().rightDirty, false, "a file-backed side starts clean");
  state = reduce(state, { type: "right", id: "one", text: "from disk edited" });
  assert.equal(tab().rightDirty, true);
  assert.equal(tab().rightBaseline, "from disk", "typing keeps the baseline");
  state = reduce(state, { type: "right", id: "one", text: "from disk" });
  assert.equal(tab().rightDirty, false, "restoring the file text is clean again");
  state = reduce(state, { type: "right", id: "one", text: "", baseline: null });
  assert.equal(tab().rightDirty, false, "a cleared side has nothing to lose");
  assert.equal(tab().rightBaseline, null);
});

test("a stale result says whether a run is coming to replace it", () => {
  let state = workspaceWith("one");
  state = reduce(state, { type: "result", token: tokenFor(state.tabs[0]), result: result("job-1") });
  state = reduce(state, { type: "edit", id: "one", text: "changed" });
  assert.equal(state.tabs[0].resultStale, true);
  assert.equal(state.tabs[0].resultOutdated, false, "an edit alone does not know whether a run follows");

  // The controller says none will: the operation waits for its button.
  state = reduce(state, { type: "idle", id: "one", current: false });
  assert.equal(state.tabs[0].resultStale, true);
  assert.equal(state.tabs[0].resultOutdated, true);

  // Pressing it queues a run, which is what "updating" means.
  state = reduce(state, { type: "queue", id: "one" });
  assert.equal(state.tabs[0].resultOutdated, false);

  // Cancelling that run leaves the old result with nothing coming.
  state = reduce(state, { type: "cancel", id: "one" });
  assert.equal(state.tabs[0].resultStale, true);
  assert.equal(state.tabs[0].resultOutdated, true);
});

test("an edit to a document the operation never reads leaves its result current", () => {
  let state = workspaceWith("one");
  state = reduce(state, { type: "result", token: tokenFor(state.tabs[0]), result: result("job-1") });
  state = reduce(state, { type: "edit", id: "one", text: "typed beside a generator" });
  state = reduce(state, { type: "idle", id: "one", current: true });
  assert.equal(state.tabs[0].result?.event.jobId, "job-1");
  assert.equal(state.tabs[0].resultStale, false);
  assert.equal(state.tabs[0].resultOutdated, false);

  // With no result to keep, the report changes nothing.
  const empty = workspaceWith("two");
  assert.equal(reduce(empty, { type: "idle", id: "two", current: false }).tabs[0], empty.tabs[0]);
});
