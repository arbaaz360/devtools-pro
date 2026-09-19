// Runtime imports carry the .ts extension so node:test can load the pure helpers.
import { runCompare, type ToolManifest } from '../bridge.ts';
import { defaultSavePresentation, type ToolView } from './types.ts';

/**
 * Diff & Compare workspace.
 *
 * `main.ts` owns tab state and the controller; this module owns the two-source
 * editor surface, the readable diff rendering, and the pure helpers both share.
 * Nothing here reads workspace state or the bridge directly, so the DOM can be
 * mounted once and updated in place without recreating either editor.
 */

export type CompareSide = 'left' | 'right';
export const COMPARE_SIDES: readonly CompareSide[] = ['left', 'right'];
export const SIDE_TITLES: Readonly<Record<CompareSide, string>> = { left: 'Left / original', right: 'Right / revised' };
export const SIDE_IDS: Readonly<Record<CompareSide, string>> = { left: 'compare-left', right: 'compare-right' };
/** Rendered diff rows are bounded; the complete diff stays behind the result handle. */
export const MAX_RENDERED_LINES = 4_000;

/** Shape published by the native `text.compare` executor (crates/devtools-core/src/compare.rs). */
export interface CompareLine { kind: 'context' | 'added' | 'removed'; text: string; oldLine: number | null; newLine: number | null }
export interface CompareHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: CompareLine[] }
export interface CompareSummary {
  identical: boolean; newlineOnly: boolean; leftBytes: number; rightBytes: number;
  leftLines: number; rightLines: number; addedLines: number; removedLines: number; changedHunks: number;
}
export interface CompareResult { summary: CompareSummary; hunks: CompareHunk[] }
/** A change is one run of added/removed lines inside a hunk. */
export interface CompareChange { hunk: number; first: number; last: number; added: number; removed: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const lineNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Parse the executor JSON. Returns null for anything that is not a complete compare result. */
export function parseCompareResult(text: string): CompareResult | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || !isRecord(value.summary) || !Array.isArray(value.hunks)) return null;
  const hunks: CompareHunk[] = [];
  for (const hunk of value.hunks) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return null;
    const lines: CompareLine[] = [];
    for (const line of hunk.lines) {
      if (!isRecord(line)) return null;
      const kind = line.kind === 'added' || line.kind === 'removed' ? line.kind : 'context';
      lines.push({ kind, text: typeof line.text === 'string' ? line.text : '', oldLine: lineNumber(line.oldLine), newLine: lineNumber(line.newLine) });
    }
    hunks.push({ oldStart: count(hunk.oldStart), oldLines: count(hunk.oldLines), newStart: count(hunk.newStart), newLines: count(hunk.newLines), lines });
  }
  const s = value.summary;
  const added = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'added').length, 0);
  const removed = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === 'removed').length, 0);
  return {
    summary: {
      identical: s.identical === true, newlineOnly: s.newlineOnly === true,
      leftBytes: count(s.leftBytes), rightBytes: count(s.rightBytes), leftLines: count(s.leftLines), rightLines: count(s.rightLines),
      addedLines: typeof s.addedLines === 'number' ? count(s.addedLines) : added,
      removedLines: typeof s.removedLines === 'number' ? count(s.removedLines) : removed,
      changedHunks: typeof s.changedHunks === 'number' ? count(s.changedHunks) : hunks.length,
    },
    hunks,
  };
}

/** Changes in document order. `maxLines` bounds the walk to the rendered rows. */
export function compareChanges(result: CompareResult, maxLines = Number.POSITIVE_INFINITY): CompareChange[] {
  const changes: CompareChange[] = [];
  let rendered = 0;
  for (const [hunkIndex, hunk] of result.hunks.entries()) {
    let open: CompareChange | null = null;
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (rendered >= maxLines) return changes;
      rendered += 1;
      if (line.kind === 'context') { open = null; continue; }
      if (!open) { open = { hunk: hunkIndex, first: lineIndex, last: lineIndex, added: 0, removed: 0 }; changes.push(open); }
      open.last = lineIndex;
      if (line.kind === 'added') open.added += 1; else open.removed += 1;
    }
  }
  return changes;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** One-line, human readable outcome for the status line and result header. */
export function describeCompare(result: CompareResult): { kind: 'identical' | 'newline-only' | 'changed'; headline: string; detail: string } {
  const { summary } = result;
  const compared = `${plural(summary.leftLines, 'line')} vs ${plural(summary.rightLines, 'line')}`;
  if (summary.identical) return { kind: 'identical', headline: 'No differences', detail: `Both sides are identical · ${compared}` };
  if (summary.newlineOnly && !result.hunks.length)
    return { kind: 'newline-only', headline: 'Only line endings differ', detail: `The text matches once CRLF and LF are treated alike · ${compared} · choose Normalize under Newlines to ignore them` };
  const changes = compareChanges(result).length;
  return {
    kind: 'changed',
    headline: `${plural(changes, 'change')} · +${summary.addedLines.toLocaleString()} −${summary.removedLines.toLocaleString()}`,
    detail: `${plural(summary.changedHunks, 'hunk')} · ${compared}${summary.newlineOnly ? ' · line endings also differ' : ''}`,
  };
}

const range = (start: number, length: number) => (length <= 0 ? `after ${Math.max(0, start - 1)}` : length === 1 ? `${start}` : `${start}–${start + length - 1}`);
export function hunkTitle(hunk: CompareHunk): string {
  return `Original ${range(hunk.oldStart, hunk.oldLines)} → Revised ${range(hunk.newStart, hunk.newLines)}`;
}

/** Compare needs two non-empty sources. `undefined` means the size is unknown and is not treated as empty. */
export function compareInputProblem(leftBytes: number | undefined, rightBytes: number | undefined): string | null {
  const leftEmpty = leftBytes === 0;
  const rightEmpty = rightBytes === 0;
  if (leftEmpty && rightEmpty) return 'Both sides are empty. Type, paste, or open a file on each side, then compare.';
  if (leftEmpty) return `${SIDE_TITLES.left} is empty. Type, paste, or open a file on that side, then compare.`;
  if (rightEmpty) return `${SIDE_TITLES.right} is empty. Type, paste, or open a file on that side, then compare.`;
  return null;
}

export function lineEnding(text: string): '' | '\n' | '\r\n' | '\r' {
  return text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : text.endsWith('\r') ? '\r' : '';
}
function marker(text: string, title: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'diff-line-eol';
  element.textContent = text;
  element.title = title;
  return element;
}
export function byteLength(text: string): number { return new TextEncoder().encode(text).length; }
/** Same counting rule as the executor: a terminator ends a line; a trailing fragment counts once. */
export function lineCount(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return text.endsWith('\n') ? count : count + 1;
}

/* ---------------------------------------------------------------- editors */

export interface CompareSideView { label: string; dirty: boolean; text: string; readOnly: boolean; meta: string; issue: string | null }
export interface CompareWorkspaceView { left: CompareSideView; right: CompareSideView }
export interface CompareWorkspaceHandlers {
  input(side: CompareSide, area: HTMLTextAreaElement): void;
  paste(side: CompareSide, event: ClipboardEvent, area: HTMLTextAreaElement): void;
  open(side: CompareSide): void;
  clipboard(side: CompareSide): void;
  clear(side: CompareSide): void;
}
export interface CompareWorkspace {
  root: HTMLElement;
  area(side: CompareSide): HTMLTextAreaElement;
  /** Sync labels, values and enabled states in place; editors are never recreated. */
  update(view: CompareWorkspaceView): void;
}

function sideSection(side: CompareSide, handlers: CompareWorkspaceHandlers): HTMLElement {
  const section = document.createElement('section');
  section.className = 'compare-source';
  section.dataset.side = side;
  const head = document.createElement('div');
  head.className = 'compare-source-head';
  const title = document.createElement('div');
  title.className = 'compare-source-title';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = SIDE_TITLES[side];
  const name = document.createElement('label');
  name.className = 'compare-source-name';
  name.htmlFor = SIDE_IDS[side];
  const label = document.createElement('span');
  label.className = 'compare-source-label';
  label.dataset.label = side;
  const dirty = document.createElement('span');
  dirty.className = 'dirty-indicator';
  dirty.dataset.dirty = side;
  dirty.setAttribute('aria-label', 'Unsaved changes');
  dirty.textContent = '●';
  dirty.hidden = true;
  name.append(label, dirty);
  title.append(eyebrow, name);
  const actions = document.createElement('div');
  actions.className = 'compare-source-actions';
  const button = (text: string, aria: string, run: () => void, id?: string) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'flat-button';
    element.textContent = text;
    element.setAttribute('aria-label', aria);
    element.dataset.action = side;
    if (id) element.id = id;
    element.addEventListener('click', run);
    return element;
  };
  actions.append(
    button('Open file…', `Open ${SIDE_TITLES[side]} file`, () => handlers.open(side), `compare-open-${side}`),
    button('Clipboard', `Paste clipboard into ${SIDE_TITLES[side]}`, () => handlers.clipboard(side)),
    button('Clear', `Clear ${SIDE_TITLES[side]}`, () => handlers.clear(side)),
  );
  head.append(title, actions);
  const area = document.createElement('textarea');
  area.id = SIDE_IDS[side];
  area.spellcheck = false;
  area.wrap = 'off';
  area.setAttribute('aria-label', `${SIDE_TITLES[side]} text`);
  area.placeholder = side === 'left' ? 'Type, paste, or open the original text…' : 'Type, paste, or open the revised text…';
  area.addEventListener('input', () => handlers.input(side, area));
  area.addEventListener('paste', event => handlers.paste(side, event, area));
  const foot = document.createElement('div');
  foot.className = 'compare-source-foot';
  const meta = document.createElement('span');
  meta.dataset.meta = side;
  const issue = document.createElement('span');
  issue.className = 'compare-source-issue';
  issue.dataset.issue = side;
  issue.setAttribute('role', 'alert');
  issue.hidden = true;
  foot.append(meta, issue);
  section.append(head, area, foot);
  return section;
}

export function mountCompareWorkspace(host: HTMLElement, handlers: CompareWorkspaceHandlers): CompareWorkspace {
  host.replaceChildren();
  host.classList.add('compare-workspace');
  const sources = document.createElement('div');
  sources.className = 'compare-sources';
  for (const side of COMPARE_SIDES) sources.append(sideSection(side, handlers));
  host.append(sources);
  const query = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const area = (side: CompareSide) => query<HTMLTextAreaElement>(`#${SIDE_IDS[side]}`);
  return {
    root: host,
    area,
    update(view) {
      for (const side of COMPARE_SIDES) {
        const state = view[side];
        const input = area(side);
        // Textareas hold LF only; a CRLF source is unchanged if it matches once normalized.
        if (input.value !== state.text && input.value !== state.text.replace(/\r\n?/g, '\n')) input.value = state.text;
        input.readOnly = state.readOnly;
        query(`[data-label="${side}"]`).textContent = state.label;
        query(`[data-dirty="${side}"]`).hidden = !state.dirty;
        query(`[data-meta="${side}"]`).textContent = state.meta;
        const issue = query(`[data-issue="${side}"]`);
        issue.hidden = !state.issue;
        issue.textContent = state.issue ?? '';
        issue.title = state.issue ?? '';
        for (const button of host.querySelectorAll<HTMLButtonElement>(`button[data-action="${side}"]`)) {
          button.disabled = state.readOnly;
          button.title = state.readOnly ? 'This side is a read-only file preview. Open a smaller file in a new tab to edit it.' : '';
        }
      }
    },
  };
}

/** Line/word/character selector. Only line granularity exists in the native engine today. */
export function granularityControl(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'compare-granularity';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Diff granularity');
  for (const [id, label] of [['line', 'Line'], ['word', 'Word'], ['character', 'Character']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `flat-button${id === 'line' ? ' active' : ''}`;
    button.textContent = label;
    button.dataset.granularity = id;
    button.setAttribute('aria-pressed', String(id === 'line'));
    if (id !== 'line') {
      button.disabled = true;
      button.title = `${label} granularity is not available in this engine yet. Lines are compared.`;
    }
    group.append(button);
  }
  return group;
}

/* ----------------------------------------------------------------- result */

export interface CompareResultView {
  result: CompareResult;
  /** Raw executor JSON, shown only behind the details control. */
  raw: string;
  /** Change to highlight on first paint, or -1. */
  current: number;
  /** Job metrics folded into the summary line (the generic metrics grid is hidden for diffs). */
  stats?: string;
  onNavigate(index: number): void;
}
export interface RenderedCompare {
  changes: CompareChange[];
  select(index: number, scroll?: boolean): void;
}

export function renderCompareResult(host: HTMLElement, view: CompareResultView): RenderedCompare {
  host.replaceChildren();
  host.classList.add('diff-result');
  const { result } = view;
  const description = describeCompare(result);
  const changes = compareChanges(result, MAX_RENDERED_LINES);
  const totalLines = result.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const capped = totalLines > MAX_RENDERED_LINES;

  const toolbar = document.createElement('div');
  toolbar.className = 'diff-toolbar';
  const summary = document.createElement('div');
  summary.className = `diff-summary ${description.kind}`;
  const headline = document.createElement('strong');
  headline.textContent = description.headline;
  const detail = document.createElement('span');
  detail.textContent = view.stats ? `${description.detail} · ${view.stats}` : description.detail;
  summary.append(headline, detail);
  const nav = document.createElement('div');
  nav.className = 'diff-nav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Change navigation');
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'flat-button';
  previous.textContent = '‹ Prev';
  previous.setAttribute('aria-label', 'Previous change');
  const counter = document.createElement('span');
  counter.className = 'diff-nav-count';
  counter.setAttribute('aria-live', 'polite');
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'flat-button';
  next.textContent = 'Next ›';
  next.setAttribute('aria-label', 'Next change');
  nav.append(previous, counter, next);
  toolbar.append(summary, nav);
  host.append(toolbar);

  const rows = new Map<number, HTMLElement[]>();
  if (description.kind === 'changed' && result.hunks.length) {
    const body = document.createElement('div');
    body.className = 'diff-body';
    body.setAttribute('aria-label', 'Line changes');
    let rendered = 0;
    let changeIndex = 0;
    for (const [hunkIndex, hunk] of result.hunks.entries()) {
      if (rendered >= MAX_RENDERED_LINES) break;
      const section = document.createElement('section');
      section.className = 'diff-hunk';
      const title = document.createElement('div');
      title.className = 'diff-hunk-title';
      title.textContent = hunkTitle(hunk);
      section.append(title);
      // Unified-diff reading order: inside one change, removed lines come
      // before added lines. The executor's own order is kept in the raw JSON.
      const order = hunk.lines.map((_, index) => index);
      for (const change of changes) {
        if (change.hunk !== hunkIndex) continue;
        const run = order.slice(change.first, change.last + 1);
        const removed = run.filter(index => hunk.lines[index].kind === 'removed');
        const added = run.filter(index => hunk.lines[index].kind !== 'removed');
        order.splice(change.first, run.length, ...removed, ...added);
      }
      for (const lineIndex of order) {
        const line = hunk.lines[lineIndex];
        if (rendered >= MAX_RENDERED_LINES) break;
        rendered += 1;
        const row = document.createElement('div');
        row.className = `diff-line ${line.kind}`;
        const change = changes[changeIndex];
        if (change && change.hunk === hunkIndex && lineIndex >= change.first && lineIndex <= change.last) {
          row.dataset.change = String(changeIndex);
          (rows.get(changeIndex) ?? rows.set(changeIndex, []).get(changeIndex)!).push(row);
          if (rows.get(changeIndex)!.length === change.last - change.first + 1) changeIndex += 1;
        }
        const oldNumber = document.createElement('span');
        oldNumber.className = 'diff-line-number';
        oldNumber.textContent = line.oldLine === null ? '' : String(line.oldLine);
        const newNumber = document.createElement('span');
        newNumber.className = 'diff-line-number';
        newNumber.textContent = line.newLine === null ? '' : String(line.newLine);
        const sign = document.createElement('span');
        sign.className = 'diff-line-sign';
        sign.textContent = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : '';
        const text = document.createElement('span');
        text.className = 'diff-line-text';
        const eol = lineEnding(line.text);
        text.textContent = line.text.slice(0, line.text.length - eol.length);
        // The executor keeps each line's terminator; show it only where it can
        // explain a change (CRLF on a changed line, or a missing final newline).
        if (line.kind !== 'context' && eol === '\r\n') text.append(marker('␍', 'Line ends with CRLF'));
        else if (!eol) text.append(marker('no newline at end', 'The last line has no line ending'));
        row.append(oldNumber, newNumber, sign, text);
        section.append(row);
      }
      body.append(section);
    }
    if (capped) {
      const notice = document.createElement('p');
      notice.className = 'diff-notice';
      notice.setAttribute('role', 'status');
      notice.textContent = `Showing the first ${MAX_RENDERED_LINES.toLocaleString()} of ${totalLines.toLocaleString()} diff lines. Save the result for the complete diff.`;
      body.append(notice);
    }
    host.append(body);
  } else {
    const empty = document.createElement('div');
    empty.className = `diff-empty ${description.kind}`;
    empty.setAttribute('role', 'status');
    const mark = document.createElement('span');
    mark.className = 'diff-empty-mark';
    mark.textContent = description.kind === 'identical' ? '✓' : '↵';
    const text = document.createElement('p');
    text.textContent = description.kind === 'identical'
      ? 'Both sides contain the same lines. Edit either side and the comparison runs again.'
      : description.detail;
    empty.append(mark, text);
    host.append(empty);
  }

  const raw = document.createElement('details');
  raw.className = 'diff-raw';
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Raw diff JSON';
  const rawBody = document.createElement('pre');
  rawBody.tabIndex = 0;
  rawBody.setAttribute('aria-label', 'Raw diff JSON');
  rawBody.textContent = view.raw;
  raw.append(rawSummary, rawBody);
  host.append(raw);

  let current = -1;
  const select = (index: number, scroll = true) => {
    for (const row of rows.get(current) ?? []) row.classList.remove('current');
    current = !changes.length || index < 0 ? -1 : Math.min(changes.length - 1, index);
    const target = rows.get(current) ?? [];
    for (const row of target) row.classList.add('current');
    counter.textContent = changes.length
      ? `${current >= 0 ? current + 1 : '–'} / ${changes.length}${capped ? ' shown' : ''}`
      : 'No changes';
    previous.disabled = !changes.length || current <= 0;
    next.disabled = !changes.length || current >= changes.length - 1;
    const body = target[0]?.parentElement?.parentElement;
    // Scroll only the diff body: ancestors are overflow-hidden panes that must not move.
    if (scroll && target[0] && body) body.scrollTop = Math.max(0, target[0].offsetTop - body.clientHeight / 2 + target[0].offsetHeight / 2);
  };
  previous.addEventListener('click', () => { select(Math.max(0, current - 1)); view.onNavigate(current); });
  next.addEventListener('click', () => { select(current + 1); view.onNavigate(current); });
  select(view.current, view.current >= 0);
  return { changes, select };
}

/* ------------------------------------------------- registry compatibility */

/**
 * `ToolView` adapter for the (not yet consumed) tool view registry. It reuses
 * the same editor surface; the active integration path is `main.ts`.
 */
interface RuntimeWithCompare { compareTexts?: Record<CompareSide, string>; compareNewline?: HTMLSelectElement }

export const diffView: ToolView = {
  ids: ['text.compare'], group: 'COMPARE', icon: '⇄', sourceMode: 'custom',
  render(runtime) {
    runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = ''; runtime.sourceHost.innerHTML = '';
    const texts: Record<CompareSide, string> = { left: '', right: '' };
    const labels: Record<CompareSide, string | null> = { left: null, right: null };
    const view = (): CompareWorkspaceView => {
      const side = (id: CompareSide): CompareSideView => ({
        label: labels[id] ?? (texts[id] ? 'Unsaved text' : 'No source'), dirty: !!texts[id] && labels[id] !== null,
        text: texts[id], readOnly: false, meta: `${plural(lineCount(texts[id]), 'line')} · ${runtime.bytes(byteLength(texts[id]))}`, issue: null,
      });
      return { left: side('left'), right: side('right') };
    };
    const workspace = mountCompareWorkspace(runtime.sourceHost, {
      input: (side, area) => { texts[side] = area.value; workspace.update(view()); },
      paste: () => undefined,
      open: async side => {
        const picked = await runtime.chooseDocument();
        if (!picked) return;
        texts[side] = picked.preview; labels[side] = picked.name; workspace.update(view());
      },
      clipboard: async side => { texts[side] = await navigator.clipboard.readText(); workspace.update(view()); },
      clear: side => { texts[side] = ''; labels[side] = null; workspace.update(view()); },
    });
    workspace.update(view());
    const newline = document.createElement('select');
    newline.id = 'compare-newline';
    newline.setAttribute('aria-label', 'Compare newline handling');
    for (const value of ['preserve', 'lf', 'cr_lf', 'ignore']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'cr_lf' ? 'Normalize CRLF' : value[0].toUpperCase() + value.slice(1);
      newline.append(option);
    }
    runtime.optionsHost.append(newline, granularityControl());
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'primary-button';
    compare.textContent = 'Compare';
    compare.disabled = runtime.busy;
    compare.addEventListener('click', () => void this.run(runtime, 'compare'));
    runtime.actionsHost.append(compare);
    const extra = runtime as RuntimeWithCompare;
    extra.compareTexts = texts;
    extra.compareNewline = newline;
  },
  run(runtime) {
    const extra = runtime as RuntimeWithCompare;
    const texts = extra.compareTexts;
    if (!texts) return;
    const problem = compareInputProblem(byteLength(texts.left), byteLength(texts.right));
    if (problem) { runtime.fail(problem); return; }
    const newline = (extra.compareNewline?.value ?? 'preserve') as 'preserve' | 'lf' | 'cr_lf' | 'ignore';
    void (async () => {
      const left = await runtime.createTextDocument(texts.left);
      const right = await runtime.createTextDocument(texts.right);
      await runtime.startJob({
        documentId: left.id, sourceDocumentId: left.id, toolId: 'text.compare', operationId: 'compare', options: { newline },
        title: `Compare · ${left.name} vs ${right.name}`, status: 'Comparing bounded text…',
        run: () => runCompare(left.id, right.id, { newline }),
      });
    })();
  },
  savePresentation(manifest: ToolManifest, operationId, mime) { return defaultSavePresentation(manifest, operationId, mime); },
};
