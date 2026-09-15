import type {
  BinaryPreview,
  FileDocument,
  JobFinished,
  JobProgress,
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
  progress: JobProgress | null;
  result: ResultView | null;
  /** Existing output is retained while a same-tool edit is recomputing. */
  resultStale: boolean;
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
    revision: 0,
    generation: 0,
    dirty: false,
    undo: [],
    redo: [],
    phase: "idle",
    jobId: null,
    progress: null,
    result: null,
    resultStale: false,
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
    progress: null,
    result: preserveResult ? tab.result : null,
    resultStale: preserveResult && !!tab.result,
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
  | { type: "edit"; id: string; text: string }
  | { type: "import-start"; id: string }
  | {
      type: "imported";
      token: RunToken;
      source: FileDocument;
      text: string | null;
    }
  | { type: "undo" | "redo"; id: string }
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
  | { type: "right"; id: string; text: string }
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
  | { type: "error"; id: string; message: string }
  | { type: "started"; token: RunToken; jobId: string }
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
            ...reset(tab),
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
            ...reset(tab),
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
        case "right":
          return { ...reset(tab), rightText: action.text };
        case "find-options":
          return { ...tab, ...action.patch };
        case "queue":
          return { ...reset(tab), phase: "queued" };
        case "cancel":
          return { ...reset(tab, false), phase: "cancelled" };
        case "error":
          return {
            ...reset(tab, false),
            phase: "error",
            error: action.message,
          };
        case "started":
          return { ...tab, jobId: action.jobId, phase: "running" };
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
            result: action.result,
            resultStale: false,
            error: action.result.event.error ?? null,
          };
        case "failed":
          return {
            ...reset(tab, false),
            phase: "error",
            jobId: null,
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
