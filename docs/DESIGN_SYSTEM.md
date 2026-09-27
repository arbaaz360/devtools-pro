# Design system

The shell's visual language, decided 2026-09-28 for the first release. The brief: a
polished native desktop developer tool, not a website in a window. Crisp, sharp, clean,
understated, cohesive. Nothing plasticky, glossy or decorative. Typography readable and
confident, never tiny, faint, cramped or blurry. Compact without losing breathing room.
The editor is the focus; everything around it is organised and quiet.

`apps/desktop/src/styles.css` and `toolViews.css` implement this file. Tokens live on
`:root`; no rule hard-codes a colour or a size that a token covers. Selectors, ids and
class names are shared with `main.ts`, the Playwright specs and the native suite, and do
not change here.

## Principles

1. **Flat surfaces, hairline edges.** No gradients, no bevels, no inset highlights, no
   glows, no drop shadows on chrome. Depth comes from a four-step surface ladder and
   1 px borders. The only shadow in the app is under a dialog.
2. **One accent.** A single steel blue for focus, selection, the active tab and the
   primary button. Green, red and amber only mean success, failure and caution.
3. **Type first.** Every label is at least 11 px; body text is 13 px; nothing is set
   below 3:1 contrast. Sizes come from the scale below and nowhere else.
4. **A 4 px grid.** Spacing, control heights and bar heights are multiples of 4 (2 only
   for hairline offsets).
5. **Native corners.** 4 px radius on controls, inputs, tabs and dialogs; 0 on panes,
   bars and the editor. Never 8 px or more.
6. **The editor is the work surface.** It is the largest, quietest area, one step
   deeper than the panes around it, with no border of its own.

## Tokens

### Surfaces (neutral, spread ≤ 8 between channels, max channel < 48)

| Token | Value | Use |
|---|---|---|
| `--well` | `#151618` | editor, result output, code, inputs, tree |
| `--surface` | `#1b1c1f` | panes (document, result), dialog body |
| `--chrome` | `#202124` | top bar, sidebar, tab bar, status bar |
| `--surface-2` | `#25262a` | pane headers, tool header, hover rows, active rail row |
| `--surface-3` | `#2b2c31` | pressed / selected control backgrounds |
| `--border` | `#2e3034` | hairlines between regions |
| `--border-strong` | `#3c3e44` | control borders |
| `--bg` | same as `--chrome` | the window behind everything |

`--hi`, `--metal`, `--key`, `--key-hover`, `--key-down` are removed.

### Text

| Token | Value | Use |
|---|---|---|
| `--text` | `#e4e6ea` | primary |
| `--muted` | `#a4a9b0` | secondary: descriptions, metadata, inactive tabs, labels |
| `--faint` | `#7c8188` | tertiary: eyebrows, footers, placeholders. Minimum contrast 3:1 on `--surface-2` |

### Accent and semantics

| Token | Value | Use |
|---|---|---|
| `--accent` | `#7fb0e0` | focus ring, active-tab bar, links, rail active bar, tree keys |
| `--accent-strong` | `#3f6f9f` | primary button, selection tint base |
| `--selection` | `#2f4d6d` | `::selection` |
| `--green` | `#5fbf8a` | success |
| `--red` | `#e07484` | failure, diagnostics |
| `--yellow` | `#d6ab5e` | caution, dirty marker |

### Type scale

| Token | Value | Use |
|---|---|---|
| `--font-ui` | `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` | everything but code |
| `--mono` | `"Cascadia Mono", "Cascadia Code", Consolas, monospace` | editor, results, code, kbd |
| `--fs-caption` | 11 px | eyebrows, group labels, section labels (uppercase, `letter-spacing: .06em`, weight 600) |
| `--fs-small` | 12 px | metadata, status bar, footers, option labels, pane meta, tab-bar hints |
| `--fs-body` | 13 px | controls, inputs, rail names, tab names, pane headings, menu items, body copy |
| `--fs-title` | 14 px | tool title, dialog title, empty-state heading |
| `--fs-code` | 13 px | editor, result text, tree, diff, summary list (line-height 1.55) |

Root `font-size: 13px; line-height: 1.4`. No other pixel sizes exist in the stylesheet
(the one exception: glyph-only buttons and marks such as ×, ＋, ‹ and the empty-state
glyph are 16 px). Tool icons are not text: see **Tool icons** below.

### Metrics

| Token | Value |
|---|---|
| `--radius` | 4 px (controls, inputs, tabs, dialogs, icon boxes) |
| `--control` | 26 px (buttons, selects, text inputs, search) |
| `--control-sm` | 24 px (flat toolbar buttons, tab close, icon buttons) |
| `--bar-top` | 36 px |
| `--bar-tabs` | 34 px |
| `--bar-header` | 40 px (tool header) |
| `--bar-pane` | 34 px (pane headers) |
| `--bar-status` | 24 px |
| `--sidebar-width` | 224 px at every width above 820 px (48 px, icons only, at or below it) |
| spacing | 4 / 8 / 12 / 16 px |

## Components

**Top bar.** `--chrome`, bottom hairline. Left: the wordmark "DevTools **Pro**" at
`--fs-body` 600. Centre: the document name at `--fs-small` `--muted`. Right: the
"Local only" indicator (6 px green dot + `--fs-small`) and the Commands button (outline,
`--control-sm`, with a `kbd`).

**Sidebar** (revised 2026-09-28 after the owner reviewed the first render: the rail must
be clear, not loud). `--chrome`, right hairline, 224 px.

- **Head.** "Tools" at `--fs-body` 600 (the "WORKBENCH" eyebrow is gone) and the collapse
  chevron; the head is as tall as the tab bar (`--bar-tabs`), so "Tools" and the tab names
  share a line. Below it, one row of two half-width `--control` buttons, 4 px apart:
  **New** (primary) and **Open…** (outline), each with a 16 px icon (a plus, a folder)
  drawn in the tool icons' stroke. Their `kbd`s do not fit at half width and are hidden:
  Ctrl+N and Ctrl+O are in each button's tooltip and in the empty state. Search:
  `--control`, `--well`, hairline border, magnifier glyph in `--faint`, 12 px above the
  first group.
- **Rows.** One line per tool, 28 px tall, 8 px side padding: a 16 px icon, an 8 px gap,
  the name at `--fs-body` weight 400 in `--text` (not bold: every row bold is what made
  the rail shout). No description in the rail: it is the row's `title` (a native
  tooltip) and the tool header's subtitle. A name too long for the rail ends in an
  ellipsis; at 224 px only "JSON String Escape / Unescape" does. Inactive icon `--muted`;
  hover `--surface-2`, icon `--text`; active `--surface-2` with a 2 px `--accent` bar on
  the left (16 px tall, centred, as in a Windows 11 navigation view), icon `--accent`,
  name `--text`.
- **Group labels.** `--fs-caption` caps `--faint`, 16 px above and 6 px below; the first
  group has no top margin.
- **Edges.** Rows, buttons and search share one 8 px outer edge; the list keeps a stable
  6 px scrollbar gutter (transparent track) so its rows end where the search box does;
  group labels and icons start on one 16 px line.
- **Collapsed** (48 px, or any window at or below 820 px): icons only, New and Open
  stacked as icon buttons, a hairline between groups, no scrollbar, and the chevron
  mirrored to point the way it will open. The icons must stay recognisable alone.

**Tool icons.** One monochrome mark per tool id, in `apps/desktop/src/ui/icons.ts`:
inline SVG on a 16 × 16 grid, 1.5 px stroke, round caps and joins, `currentColor`, no
fills beyond small dots and QR cells, and no letters. Each is one simple, recognisable
silhouette (braces for JSON, a brush for CSS, a bolt for JavaScript, a cylinder for SQL,
a clock for Unix time, a key for JWT, a magnifier for Find & Replace …). An id the table
does not know gets a generic folded document. The rail shows the mark at 16 px; the
tool header shows the same mark in its 24 px box. Every tool in the rail has a mark of
its own and no two are alike (the release spec checks both).

**Tab bar.** `--chrome`, bottom hairline, `--bar-tabs`. A tab is `--fs-body`, min 120 px,
max 220 px, 12 px side padding, `--muted`; the active tab is `--surface-2` with `--text`
and a 2 px `--accent` line along its top edge, and has no bottom border: what sits
directly below it is the tool header (`--surface-2`), so the two read as one piece. Hover
on an inactive tab is half a step, between `--chrome` and `--surface-2`, with `--text`. The dirty dot is 6 px `--yellow`; the
close button is `--control-sm` square, visible on hover and on the active tab. The "+"
button matches the close button.

**Tool header.** `--surface-2`, `--bar-header`, bottom hairline, 12 px side padding.
Icon box 24 × 24 (`--radius`, 1 px `--border-strong`, `--well`) holding the tool's 16 px
icon in `--accent`. Eyebrow (group) `--fs-caption`
`--faint` above a row of title `--fs-title` 600 and description `--fs-small` `--muted`,
baseline-aligned, 10 px apart. Actions on the right: outline buttons at `--control`.

**Pane headers** (Document / Result). `--surface-2`, `--bar-pane` minimum (hairline
included), bottom hairline, 8 px side padding. The first row is always a control tall
(26 px): the pane's name and meta, then, pushed right, the badge and the quick actions
(Result: its actions, then the collapse chevron last). A tool's options start a row of
their own beneath it and flow as one wrapping row across the full width of the header,
with the operation buttons at its end, right-aligned; a tool with operation buttons but
no options gets that row for its buttons alone, so every tool's buttons sit in the same
place. Heading `--fs-body` 600; meta `--fs-small` `--muted`, 8 px
after it. The badge (INPUT / EDITING / TEXT / READ ONLY / OUTPUT) is `--fs-caption`
`--faint`. Quick actions (Clipboard, Clear, Copy, Open as tab, Save…) are flat buttons at
`--control-sm`, `--fs-small`, `--muted`, hover `--surface-3` + `--text`. Option controls
wrap onto following lines with an 8 px row gap and 12 px column gap: label `--fs-small`
`--muted`, then a select or input at `--control` (`--well`, hairline `--border-strong`,
`--radius`, `--fs-body`, 8 px side padding, hover border `--accent-strong`); a checkbox
option is a 16 px native checkbox (`accent-color: var(--accent)`) with its label at
`--fs-body` `--text`, 6 px apart. Operation buttons sit at the end of the row: the
active one primary, the others outline, both `--control`.

**Editor.** `--well`, no border, 12 px 14 px padding, `--mono` `--fs-code` line-height
1.55, `--text`; caret `--accent`; read-only `--muted`; focus shows a 1 px inset
`--accent-strong` ring. `#editor-highlight` keeps exactly the editor's font, padding and
line-height (the annotation layer must stay aligned). Pane footer: `--surface`, top
hairline, 24 px, `--fs-small` `--faint`.

**Result pane.** State line: 4 px 8 px padding (after the 3 px bar the text starts on the
header's 8 px edge), 3 px left bar (green / red / amber), `--fs-small`, coloured text, on
the pane's own `--surface`. Metrics line: `--fs-small` `--muted`, 8 px padding,
bottom hairline. Operation details: a `summary` at `--fs-small` `--muted`, 28 px tall,
the `pre` at `--fs-code`. Output heading: `--fs-caption` OUTPUT on the left, meta
`--fs-small` `--faint`, view tabs (Text / Tree) as a segmented control at `--control-sm`
with `--radius`: selected segment `--surface-3` `--text`, not accent-filled. Output text
mirrors the editor. The summary list is `--mono` `--fs-code`, keys `--accent`, 4 px row
gap, 16 px column gap, 10 px 12 px padding. Status message (validation success): green
left bar, `--fs-small`.

**Status bar.** `--chrome`, top hairline, `--bar-status`, 12 px side padding,
`--fs-small` `--muted`, items 16 px apart; the engine dot as in the top bar. The
progress slot keeps its width; the progress bar is 4 px, `accent-color: var(--accent)`.

**Buttons.** Primary: `--accent-strong` background, `#f4f7fa` text, weight 600, hover
lightens by ~8%, active darkens. Outline: `--surface-2` background, 1 px
`--border-strong`, `--text`, hover `--surface-3` and border `#4a4d54`. Flat: transparent,
`--muted`, hover `--surface-3` + `--text`. All `--radius`, 0 12 px padding (flat: 0 8 px),
`--fs-body` (flat: `--fs-small`), disabled `opacity: .45`. Icon buttons are
`--control-sm` squares. `kbd`: `--mono` 11 px, `--well`, hairline, `--radius` 3 px,
0 5 px, line-height 18 px, `--muted`.

**Dialogs and the palette.** `--surface`, 1 px `--border-strong`, `--radius`, shadow
`0 12px 32px rgba(0,0,0,.55)`, backdrop `rgba(0,0,0,.5)`. Header 8 px padding (16 px on
the left) with the title at `--fs-title` 600 (drop the "QUICK ACTIONS" eyebrow); the
title, the search text, the commands and the hint all start on one 16 px line. While the
search has focus the first command shows as selected, because Enter runs it. Search `--control`+4.
Items 30 px tall, `--fs-body`, 12 px side padding; hover / focus `--surface-2` with a
2 px `--accent` left bar. Hint row `--fs-small` `--faint`.

**Scrollbars.** 10 px, track `--well`, thumb `#3a3c42` inset by a 2 px transparent border
(so the same thumb works on any track; rounded by the radius), hover `#4a4d54`. The rail
and the palette list use a transparent track; the tab strip's is 3 px.

**Diff view and tree view.** Same tokens: line numbers `--faint` on `--surface` (a
darker tint of the row's colour on added and removed rows), added `#1a2e22` /
`#8ad3a8`, removed `#331e25` / `#e9a0ae`; hunk titles `--fs-small`
`--muted` on `--surface-2`; the current line marked with the 3 px `--accent` bar. Tree
lines `--fs-code`, type tags `--fs-caption` `--faint`, keys `--accent`.

**Empty states.** Glyph box 36 × 36 (`--radius`, `--border-strong`, glyph `--accent`
16 px), heading `--fs-title` 600 8 px below, text `--fs-small` `--muted` max 380 px,
actions 16 px below.

**Compare (Text Diff) sources.** Source heads `--bar-pane`, names `--fs-body` 600,
foot `--fs-small`; textareas as the editor.

## What stays exactly as it is

- Every selector, id and class; the DOM structure in `index.html` (styling only, apart
  from removing the "WORKBENCH" and "QUICK ACTIONS" eyebrow spans, and the sidebar
  buttons' labels "New" and "Open…" with their tooltips and accessible names). The rail
  row's markup drops its description line and draws its icon from `ui/icons.ts`.
- The flex declarations the bundle check reads (`.app-shell`, `.app-body`, `.sidebar`,
  `.workspace`), the split/splitter mechanics, the responsive rules below 820 px, the
  collapsed-sidebar rules. (The rule that narrowed the rail below 1050 px is gone: with
  one line per tool a narrower rail cuts names off, and 1024 px is a common laptop at
  150 % scale.)
- The neutral-surface guarantee the Playwright suite checks on `body`, `.sidebar`,
  `.editor-host`, `.statusbar`: every channel below 48, channels within 8 of each other.
- The annotation layer's alignment with the editor; the JSON output overlay
  (`#result-output.json-output` transparent over `#result-highlight`).
- The geometry checks: pane headers and editors do not resize when a job starts or a
  result lands.
