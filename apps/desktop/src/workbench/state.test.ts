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
