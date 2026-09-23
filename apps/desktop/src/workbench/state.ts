import type {
  BinaryPreview,
  FileDocument,
  JobFinished,
  JobProgress,
  ExecutionIdentity,
} from "../bridge";

export const EDIT_LIMIT = 1024 * 1024;
/** Larger clipboard input is held by the host, never in the editor/history. */
export const TEXT_IMPORT_LIMIT = 36 * 1024 * 1024;
export const MAX_TABS = 16;
export interface RunToken {
  tabId: string;
  generation: number;
}
export interface ResultView {
  event: JobFinished;
  text: string;
  truncated: boolean;
  image?: BinaryPreview;
  previewError?: string;
  /**
   * What a byte tool read: the file's own bytes, or the editor's text encoded as
   * UTF-8. Absent for tools that read text, where the two are the same thing.
   */
  inputFrom?: "file" | "text";
}
export interface TabState {
  id: string;
  name: string;
  source: FileDocument | null;
  pasted: boolean;
  text: string | null;
  savedText: string | null;
  savedPath: string | null;
  toolId: string;
  operation: string;
  options: Readonly<Record<string, unknown>>;
  rightText: string;
  /** File-backed text the right side was opened from; null when typed, pasted or empty. */
  rightBaseline: string | null;
  /** The right side holds text that closing the tab would lose. */
  rightDirty: boolean;
  revision: number;
  generation: number;
  dirty: boolean;
  undo: readonly string[];
  redo: readonly string[];
  phase:
    | "idle"
    | "importing"
    | "queued"
    | "running"
    | "success"
    | "error"
    | "cancelled";
  jobId: string | null;
  /** Native acceptance identity for stale-event and provenance checks. */
  jobIdentity: ExecutionIdentity | null;
  progress: JobProgress | null;
  result: ResultView | null;
  /**
   * The retained result no longer answers what the tab now asks: an edit, an
   * option change or a cancel came after it. It stays visible rather than
   * collapsing the pane.
   */
  resultStale: boolean;
  /**
   * A stale result that nothing is about to replace: the operation waits for its
   * button, the change emptied the document, or the run was cancelled. Without
   * this, a stale result can only say it is updating, and for these it is not.
   */
  resultOutdated: boolean;
  findQuery: string;
  findReplacement: string;
  findCaseSensitive: boolean;
  findWholeWord: boolean;
  image: BinaryPreview | null;
  imageError: string | null;
  error: string | null;
}
export interface WorkspaceState {
  tabs: readonly TabState[];
  activeId: string | null;
}
export const emptyWorkspace: WorkspaceState = { tabs: [], activeId: null };
export function activeTab(state: WorkspaceState): TabState | undefined {
  return state.tabs.find((tab) => tab.id === state.activeId);
}
export function tokenFor(tab: TabState): RunToken {
  return { tabId: tab.id, generation: tab.generation };
}
export function matches(
  tab: TabState | undefined,
  token: RunToken,
): tab is TabState {
  return !!tab && tab.id === token.tabId && tab.generation === token.generation;
}
/** True when a comparison cannot run yet because a side has no text. A
 * read-only left preview of unknown size is not treated as empty. The shell's
 * status line and the controller's host boundary share this rule. */
export function compareInputMissing(tab: TabState): boolean {
  const left = tab.text !== null ? tab.text.length : tab.source?.size;
  return left === 0 || tab.rightText.length === 0;
}
export function makeTab(
  id: string,
  name: string,
  source: FileDocument | null,
  text: string | null,
): TabState {
  return {
    id,
    name,
    source,
    pasted: false,
    text,
    savedText: text,
    savedPath: null,
    toolId: "editor.text",
    operation: "",
    options: {},
    rightText: "",
    rightBaseline: null,
    rightDirty: false,
    revision: 0,
    generation: 0,
    dirty: false,
    undo: [],
    redo: [],
    phase: "idle",
    jobId: null,
    jobIdentity: null,
    progress: null,
    result: null,
    resultStale: false,
    resultOutdated: false,
    findQuery: "",
    findReplacement: "",
    findCaseSensitive: true,
    findWholeWord: false,
    image: null,
    imageError: null,
    error: null,
  };
}
function reset(tab: TabState, preserveResult = true): TabState {
  return {
    ...tab,
    generation: tab.generation + 1,
    phase: "idle",
    jobId: null,
    jobIdentity: null,
    progress: null,
    result: preserveResult ? tab.result : null,
    resultStale: preserveResult && !!tab.result,
    resultOutdated: false,
    error: null,
  };
}
function history(items: readonly string[]): string[] {
  const kept: string[] = [];
  let units = 0;
  for (let i = items.length - 1; i >= 0 && kept.length < 50; i--) {
    units += items[i].length;
    if (units > 2 * EDIT_LIMIT) break;
    kept.unshift(items[i]);
  }
  return kept;
}
export type Action =
  | { type: "add"; tab: TabState }
  | { type: "activate" | "close"; id: string }
  /** `keepsResult`: the operation does not read the document, so the run stays as it is. */
  | { type: "edit"; id: string; text: string; keepsResult?: boolean }
  | { type: "import-start"; id: string }
  | {
      type: "imported";
      token: RunToken;
      source: FileDocument;
      text: string | null;
    }
  | { type: "undo" | "redo"; id: string; keepsResult?: boolean }
  | {
      type: "tool";
      id: string;
      toolId: string;
      operation: string;
      options: Record<string, unknown>;
    }
  | {
      type: "options";
      id: string;
      operation: string;
      options: Record<string, unknown>;
    }
  | {
      type: "right";
      id: string;
      text: string;
      /** When present, replaces the right side's file baseline (null: no file). */
      baseline?: string | null;
    }
  | {
      type: "find-options";
      id: string;
      patch: Partial<
        Pick<
          TabState,
          | "findQuery"
          | "findReplacement"
          | "findCaseSensitive"
          | "findWholeWord"
        >
      >;
    }
  | { type: "queue" | "cancel"; id: string }
  /** A compare side became empty: nothing is sent to the host and the previous result no longer describes the inputs. */
  | { type: "gated"; id: string }
  /**
   * The controller decided no run follows the change just made. `current` when
   * the change was an edit to a document the operation never reads.
   */
  | { type: "idle"; id: string; current: boolean }
  | { type: "error"; id: string; message: string }
  | { type: "started"; token: RunToken; jobId: string; identity?: ExecutionIdentity }
  | { type: "progress"; token: RunToken; progress: JobProgress }
  | { type: "result"; token: RunToken; result: ResultView }
  | { type: "failed"; token: RunToken; message: string }
  | {
      type: "image";
      id: string;
      image: BinaryPreview | null;
      error: string | null;
    }
  | { type: "saved"; id: string; text: string | null; path: string };

/** The only workspace state transition function: no DOM, clocks, files or IPC. */
export function reduce(state: WorkspaceState, action: Action): WorkspaceState {
  if (action.type === "add")
    return state.tabs.length >= MAX_TABS
      ? state
      : { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
  if (action.type === "activate")
    return state.tabs.some((t) => t.id === action.id)
      ? { ...state, activeId: action.id }
      : state;
  if (action.type === "close") {
    const index = state.tabs.findIndex((t) => t.id === action.id);
    const tabs = state.tabs.filter((t) => t.id !== action.id);
    return {
      tabs,
      activeId:
        state.activeId === action.id
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : state.activeId,
    };
  }
  const id = "token" in action ? action.token.tabId : action.id;
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== id || ("token" in action && !matches(tab, action.token)))
        return tab;
      switch (action.type) {
        case "import-start":
          return { ...reset(tab), phase: "importing" };
        case "imported":
          return {
            ...reset(tab, false),
            source: action.source,
            pasted: true,
            text: action.text,
            savedText: null,
            dirty: true,
            undo: [],
            redo: [],
            image: null,
            imageError: null,
            revision: tab.revision + 1,
          };
        case "edit":
          if (tab.text === null || tab.text === action.text) return tab;
          return {
            // An edit the operation does not read keeps the run exactly as it was.
            ...(action.keepsResult ? tab : reset(tab)),
            text: action.text,
            dirty: action.text !== tab.savedText,
            revision: tab.revision + 1,
            undo: history([...tab.undo, tab.text]),
            redo: [],
          };
        case "undo":
        case "redo": {
          const from = action.type === "undo" ? tab.undo : tab.redo;
          if (tab.text === null || !from.length) return tab;
          const text = from[from.length - 1];
          return {
            ...(action.keepsResult ? tab : reset(tab)),
            text,
            dirty: text !== tab.savedText,
            revision: tab.revision + 1,
            undo:
              action.type === "undo"
                ? from.slice(0, -1)
                : history([...tab.undo, tab.text]),
            redo:
              action.type === "redo"
                ? from.slice(0, -1)
                : history([...tab.redo, tab.text]),
          };
        }
        case "tool":
          return {
            ...reset(tab, false),
            toolId: action.toolId,
            operation: action.operation,
            options: action.options,
          };
        case "options":
          return {
            ...reset(tab),
            operation: action.operation,
            options: action.options,
          };
        case "right": {
          const rightBaseline =
            action.baseline === undefined ? tab.rightBaseline : action.baseline;
          return {
            ...reset(tab),
            rightText: action.text,
            rightBaseline,
            rightDirty: action.text !== "" && action.text !== rightBaseline,
          };
        }
        case "find-options":
          return { ...tab, ...action.patch };
        case "queue":
          return { ...reset(tab), phase: "queued" };
        case "gated":
          return reset(tab, false);
        case "cancel":
          // Keep the last result visible and mark it stale while the cancelled
          // job is retired; collapsing the result pane changes the workspace.
          return { ...reset(tab, true), phase: "cancelled", resultOutdated: !!tab.result };
        case "idle":
          if (!tab.resultStale) return tab;
          return action.current
            ? { ...tab, resultStale: false }
            : { ...tab, resultOutdated: true };
        case "error":
          return {
            ...reset(tab, false),
            phase: "error",
            error: action.message,
          };
        case "started":
          return {
            ...tab,
            jobId: action.jobId,
            jobIdentity: action.identity ?? null,
            phase: "running",
          };
        case "progress":
          return tab.phase === "running"
            ? { ...tab, progress: action.progress }
            : tab;
        case "result":
          return {
            ...tab,
            phase: action.result.event.ok
              ? "success"
              : action.result.event.cancelled
                ? "cancelled"
                : "error",
            jobId: null,
            jobIdentity: null,
            result: action.result,
            resultStale: false,
            resultOutdated: false,
            error: action.result.event.error ?? null,
          };
        case "failed":
          return {
            ...reset(tab, false),
            phase: "error",
            jobId: null,
            jobIdentity: null,
            error: action.message,
          };
        case "image":
          return { ...tab, image: action.image, imageError: action.error };
        case "saved":
          return {
            ...tab,
            savedPath: action.path,
            name: action.path.split(/[\\/]/).pop() ?? tab.name,
            savedText: action.text,
            dirty: tab.text !== action.text,
          };
        // Keep the reducer total even if Action gains a new variant before its
        // tab-specific behavior is implemented. This also preserves the
        // WorkspaceState tab element type under strict TypeScript settings.
        default:
          return tab;
      }
    }),
  };
}
