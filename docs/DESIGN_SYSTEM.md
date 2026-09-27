# Design system

Second iteration, decided 2026-09-28 after the owner reviewed the first one (#169). That
pass fixed the tokens; this one fixes the layout. The owner's verdict on the first pass
is the brief for this one:

> The result still looks dated and visually cluttered rather than refined. Native
> desktop does not mean tiny text, maximum density, and borders around everything. I
> want a modern, professionally designed desktop application with comfortable, crisp
> typography, balanced proportions, clear hierarchy, and a calm, cohesive workspace.
> Precise without feeling cramped, minimal without feeling empty. The interface feels
> crowded at the top and wasteful below. Repeated headings, status information, and
> surrounding controls receive disproportionate attention compared with the actual task.
> Each tool should feel purpose-built, not forced into a generic layout: the UUID
> generator should feel like a complete, thoughtfully designed generator rather than an
> empty editor with a result attached. Preserve all functionality.

`apps/desktop/src/styles.css`, `toolViews.css`, `index.html` and the rendering code in
`main.ts` implement this file. Element ids and class names that the tests and the
native suite use stay in the DOM (an element may be hidden or repurposed, not deleted,
unless its tests are updated in the same change).

## Diagnosis of the first pass

- **Six bands before the content:** title row, tab bar, tool header, pane headers, the
  options row, then the editor. The document starts 190 px down a 840 px window.
- **Everything is said several times:** the tool name in the rail, the tab, the centre
  of the title row and the tool header; the document state as a tab dot, "Unsaved
  document" and an "EDITING" badge; the encoding in a pane footer and the status bar.
- **A hairline under every band**, and four stacked strips in the result pane (state,
  metrics, details, output heading) before any output.
- **One layout for every tool.** A generator shows an empty editor with a sentence in
  the middle; an image tool shows an editor it cannot use; the result sits in a pane
  designed for text.

## Principles

1. **The task is the page.** The document and its result get the space; chrome is a
   thin frame. Content starts within 100 px of the window top.
2. **Say each thing once.** The tool name lives in the toolbar. The document name lives
   in its tab. Encoding and position live in the status bar. State lives in one line
   under the output caption.
3. **Hierarchy by space and weight, not by lines.** Hairlines exist only where two
   surfaces of the same colour meet; regions are otherwise separated by surface tone
   and 16–24 px of air. No band has a border on both edges.
4. **Comfortable type.** Body text 14 px, secondary 13 px, captions 12 px. Editor and
   results 13.5 px on a 1.6 line. Nothing smaller than 12 px, nothing lighter than
   `--muted` for text a person reads.
5. **Purpose-built workspaces.** The layout follows the workspace kind the manifest
   declares: transform, inspect, generator, image, compare, viewer, editor.
6. **Calm.** One accent. Flat surfaces. Ghost buttons for secondary actions. Motion
   only for the progress bar.

## Tokens

### Surfaces (neutral: channels within 8 of each other, every channel < 48)

| Token | Value | Use |
|---|---|---|
| `--well` | `#151618` | editor, result output, code, inputs, drop zones |
| `--surface` | `#1b1c1f` | toolbar block, generator form, dialogs |
| `--chrome` | `#202124` | title row, sidebar, status bar |
| `--surface-2` | `#25262a` | hover rows, active rail row, active tab, segmented control |
| `--surface-3` | `#2b2c31` | pressed controls, selected segment |
| `--border` | `#2e3034` | the few hairlines listed under "Lines" |
| `--border-strong` | `#3c3e44` | input and outline-button borders |

### Text

`--text #e4e6ea`, `--muted #a4a9b0`, `--faint #7c8188` (captions only, 12 px, uppercase).

### Accent and semantics

`--accent #7fb0e0`, `--accent-strong #3f6f9f` (primary button), `--selection #2f4d6d`,
`--green #5fbf8a`, `--red #e07484`, `--yellow #d6ab5e`.

### Type scale

| Token | Size | Use |
|---|---|---|
| `--fs-caption` | 12 px, uppercase, `letter-spacing .06em`, weight 600, `--faint` | pane captions (INPUT, OUTPUT), rail group labels, form section labels |
| `--fs-small` | 13 px | descriptions, metadata, status bar, option labels, tab names, ghost buttons |
| `--fs-body` | 14 px | controls, inputs, rail names, dialog items, body copy, form labels |
| `--fs-title` | 15 px, weight 600 | toolbar title, dialog title, empty-state heading |
| `--fs-code` | 13.5 px / 1.6 | editor, result text, properties list, tree, diff |

Fonts: `--font-ui "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
`--mono "Cascadia Mono", "Cascadia Code", Consolas, monospace`. Root
`font-size: 14px; line-height: 1.45`.

### Metrics

| Token | Value |
|---|---|
| `--radius` | 4 px (controls, inputs, tabs); `--radius-lg` 6 px (cards, dialogs) |
| `--control` | 28 px (buttons, selects, text inputs, search) |
| `--control-sm` | 26 px (ghost buttons, tab close, icon buttons) |
| `--bar-title` | 40 px |
| `--bar-toolbar` | 48 px (the tool toolbar) |
| `--bar-options` | 40 px (the options row, only when the tool has options) |
| `--bar-caption` | 36 px (INPUT / OUTPUT caption rows) |
| `--bar-status` | 26 px |
| `--sidebar-width` | 240 px |
| spacing | 8 / 12 / 16 / 24 px; pane content padding 16 px 20 px |

### Lines

The only hairlines in the app: under the title row; under the toolbar block (below the
options row when present); the pane divider (the splitter); above the status bar; the
sidebar's right edge; around inputs, selects and outline buttons; around a card. The
caption rows, the result state line, the rail groups and the empty states have none.

## The frame

**Title row** (`--chrome`, `--bar-title`). Left: the wordmark "DevTools **Pro**"
(`--fs-body`, 600). Then the tabs, in this same row (there is no separate tab bar). Right:
the "Local only" indicator (6 px green dot, `--fs-small`, `--muted`) and the Commands
ghost button with its `kbd`. The centre title (`.app-title`) is gone from view.

**Tabs.** `--fs-small`, 32 px tall, vertically centred in the row, 14 px side padding,
min 120 / max 220 px, `--muted`. Active: `--surface` background, `--text`, `--radius`
on the top corners, a 2 px `--accent` line along the top edge, and no line between the
tab and the toolbar beneath it (they read as one surface). No leading file-kind dot; the
dirty marker is a 6 px `--yellow` dot after the name; the close glyph appears on hover
and on the active tab. The "+" sits after the last tab.

**Sidebar** (`--chrome`, right hairline, `--sidebar-width`). Head: "Tools"
(`--fs-body`, 600) with the collapse chevron, 44 px. Then New (primary) and Open…
(outline) in one row, then the search input, all at `--control`, 12 px side padding.
Groups: caption label with 20 px above and 6 px below (none above the first). Rows:
30 px, 12 px side padding, 16 px line icon, 10 px gap, name at `--fs-small` weight 400
`--text`, description as the row's tooltip. Hover `--surface-2`; active `--surface-2`
plus a 2 px `--accent` bar and the icon in `--accent`. The rail does not narrow below
1050 px.

**Toolbar block** (`--surface`, hairline below the whole block). Row one,
`--bar-toolbar`, 20 px side padding: the tool's 20 px icon, the title at `--fs-title`,
the description at `--fs-small` `--muted` 12 px after it, baseline aligned; on the right,
the operation buttons (primary for the active operation, outline for the others,
`--control`) and then the secondary actions as ghost buttons (Save as…, and Hide /
Show result). No eyebrow, no group name. Row two, `--bar-options`, present only when the
active operation has visible options: label (`--fs-small` `--muted`) and control
(`--control`) pairs with 8 px between label and control and 20 px between pairs,
wrapping with a 8 px row gap; checkboxes are 16 px native with `accent-color`, their
label `--fs-body` `--text`. Find & Replace's find bar is this row.

**Panes.** Content sits on `--well`. Each pane starts with a caption row
(`--bar-caption`, 20 px side padding): the caption ("INPUT", "OUTPUT", "ORIGINAL",
"REVISED", "PREVIEW") at `--fs-caption`, an optional note after it at `--fs-small`
`--faint` (the pane meta such as "Read-only preview · 1.2 MB"), and the pane's actions
on the right as ghost buttons at `--control-sm` (`--fs-small`, `--muted`, hover
`--surface-2` and `--text`): Clipboard and Clear on the input; Copy, Open as tab and
Save… on the output. No background, no border. The pane body follows with 16 px 20 px
padding for text. There are no pane footers; `#preview-limit`, `#encoding` and
`#source-mode` are not shown (their text may stay in the DOM for the tests; anything a
person needs from them moves to the status bar or the caption note).

**Result state.** One line directly under the OUTPUT caption, 20 px side padding,
`--fs-small`: on success a `--green` check and "Done · 31 B · 4 ms"; on failure a
`--red` dot and the message; while running, "Running…" with the progress bar; when
stale, "Updating…" in `--muted`. A ghost "Details" toggle at the end of the line expands
the properties list (Operation details) beneath it. The separate metrics strip and the
details summary strip are gone from view. The output text follows with the same
padding as the editor. The Text / Tree switch is a segmented control at the right end
of the caption row.

**Editor.** `--well`, no border, `--fs-code`, 16 px 20 px padding, caret `--accent`,
placeholder "Type or paste here…" in `--faint`. Focus: no ring (the caret and the
selection are enough); the drag-over state keeps its dashed outline.
`#editor-highlight` keeps the editor's font, padding and line-height.

**Status bar** (`--chrome`, top hairline, `--bar-status`, 20 px side padding,
`--fs-small` `--muted`). Left: the green dot, "Local", then the status text ("Ready",
"Ready · Ctrl+N for a new document", or a job phase with the progress bar). Right:
"Ln 4, Col 1", "UTF-8", the document size ("29 B"). The TEXT/IMAGE kind and the
Valid/Error word are not shown; the result line already says so.

**Empty workspace.** Centred: a 40 px document glyph in `--faint`, "No document open"
at `--fs-title`, "Create a document or open a file, then choose a tool." at `--fs-small`
`--muted`, the New document / Open file… buttons 20 px below, and the two shortcuts
under them. No box around the glyph.

**Dialogs and palette.** `--surface`, 1 px `--border-strong`, `--radius-lg`, shadow
`0 16px 40px rgba(0,0,0,.55)`; palette 560 px wide; search 36 px at `--fs-body`; items
34 px at `--fs-body` with 16 px side padding; the hint row `--fs-small` `--faint`.

## Purpose-built workspaces

The workspace kind comes from the manifest (`workspaces[].kind`) or, for native tools,
from `tools.ts`. Every kind keeps the tab, the toolbar block and the status bar; what
sits below the toolbar differs.

**transform** (formatters, encoders, converters, regex, line tools, JWT, URL parser,
JSX): two panes side by side with the splitter, INPUT | OUTPUT, as above.

**inspect** (Text Inspector, CSV Inspector, JSON Formatter's Validate): INPUT | OUTPUT,
where the output is the properties list: `--fs-code`, keys in `--muted`, values in
`--text`, nested values indented, 6 px row gap, 24 px column gap, 16 px 20 px padding.

**generator** (UUID Generator, Example String Generator, QR Code Generator, Unix
Timestamp Converter): no editor. The left pane is a form, 24 px padding, controls
stacked with their label above (`--fs-small` `--muted`, 6 px gap), each control
`--control` and up to 360 px wide, 16 px between fields, in the manifest's option order
and honouring the visibility rules. When the active operation reads the document, the
document is a field in the form, first: UUID Decode gets a single-line "UUID" field;
Unix Timestamp gets "Timestamp or date" (single line; empty means now, and the
placeholder says so); QR Code Generator gets a "Text" textarea of four rows. A tool with
two operations (UUID Generate / Decode) shows them as a segmented control at the top of
the form; the toolbar then carries no operation buttons. The Generate button (primary,
`--control`, full form width) closes the form; it is the explicit trigger and the
`heldRepeat` re-run. The options row in the toolbar is not shown for generators (the
form is the options). The right pane is OUTPUT with the state line and the result: text
results as now with Copy first among the actions; a QR image centred on `--well` with
Copy image and Save…; the timestamp's properties list as for inspect.

**image** (Image to Base64, QR Code Reader): the left pane is a drop zone card
(`--surface`, `--radius-lg`, 1 px dashed `--border-strong`, 24 px padding, centred:
a 32 px image glyph, "Drop a PNG or JPEG here", an Open… outline button) until an
image is loaded; then the image preview, letterboxed on `--well`, with the file name
and size in the caption note. The operation button stays in the toolbar (Encode /
Read), disabled until an image is present. The wrong-content message ("This tab does
not contain an image…") appears inside the same card in place of the drop text.

**compare** (Text Diff): two sources side by side, each with a caption row (ORIGINAL /
REVISED with its own Open…, Clipboard, Clear ghosts) and an editor; the Newlines select
sits in the options row; Swap and Compare are the toolbar's operation buttons; the diff
occupies the output area below with its own summary line in the state line's place.

**viewer** (Markdown & HTML Preview): INPUT | PREVIEW, the rendered page filling the
right pane edge to edge; the Markdown / HTML operations in the toolbar.

**editor** (Text Editor, Find & Replace): a single full-width editor; Find & Replace's
find bar is the options row.

## What stays exactly as it is

- Every function: editing, paste import, open/save, drag and drop, cancel, the result
  document, Copy / Open as tab / Save, the tree view, annotations, the splitter, the
  collapsed sidebar, keyboard shortcuts, the command palette's commands.
- The flex declarations the bundle check reads (`.app-shell`, `.app-body`, `.sidebar`,
  `.workspace`); the responsive rules below 820 px (stacked panes).
- The neutral-surface guarantee on `body`, `.sidebar`, `.editor-host`, `.statusbar`.
- The annotation layer's alignment with the editor and the JSON overlay alignment.
- The geometry guarantee: panes do not move when a job starts or a result lands.
- The tests' element ids: keep them in the DOM; update the tests where an element is
  no longer visible or where copy changed.

## Decisions made in the implementation (2026-09-28)

Where this file was silent, or where two of its rules met, the implementation decided as
follows. Each is small; together they are how the frame reads.

- **Lines.** The title row's hairline is drawn only where it meets the rail (the same
  `--chrome`), as the rail's top edge; over the workspace the change of tone from
  `--chrome` to the toolbar's `--surface` separates them. With a line under the title row
  as well as under the toolbar, the toolbar would be a band with lines on both edges.
- **Tabs** stand on the title row's lower edge (8 px above them) rather than centred, so
  the active tab meets the toolbar it opens into. The wordmark's column is the rail's
  width, so the tabs begin over the workspace; collapsed, it shrinks to the wordmark.
  Inactive tabs are the same colour meeting each other, so a 16 px divider stands between
  two of them (not beside the active or hovered tab). With no tabs, only "+" shows.
- **No document:** the toolbar block and the status bar's document details are hidden;
  the empty workspace says everything.
- **Status bar** document details (line, encoding, size) are hidden for generator and
  image workspaces, which have no editor.
- **Captions.** The OUTPUT caption keeps a note saying how the tool runs ("Updates as you
  type", "Press Format or Minify to run"); a generator has none, and a narrow pane drops
  it before its actions. A rendered page's caption reads PREVIEW; the plain editor's
  reads DOCUMENT. The Text / Tree switch is last in the row.
- **State line:** `✓ Done · <output size> · <time>`, the size left out when there is no
  output; a partial output says "Showing 64 KB of 1.3 MB" at the line's end. Details is
  the native disclosure, its summary drawn at the end of the line. Success never wraps; a
  failure's message may.
- **Hide result** is said once, in the toolbar; the pane's own collapse chevron is not
  shown, and a generator does not offer Hide result at all.
- **Generator form:** a fixed 424 px column (360 px controls in 24 px padding); the
  splitter is only its edge. The operation switch changes operation under the manifest's
  trigger policy; the button, named for the operation it runs ("Generate", "Decode",
  "Convert"), always runs. A one-line document field runs its operation on Enter. The
  output area is there from the start and wraps its text. The timestamp's output reads as
  a properties list.
- **Image card:** at most 560 × 300 px, centred. A blank tab reads "Drop a PNG or JPEG
  image here, or open one."; a tab that holds text keeps its message ("This tab does not
  contain an image…"). The button reads "Open image…". One image dropped on the card
  opens in the card's tool. An image result sits at the top of the output; a generated
  image and an input image are letterboxed in the middle.
- **Compare:** the output area shows from the start and says what the comparison needs.
  The sources' captions read ORIGINAL and REVISED ("Left / original" stays in messages and
  accessible names); each caption holds the source's name, its size (which gives way
  first) and any issue. On success the diff's own summary replaces the state line, and
  the run's Details give way to the raw diff.
- **Rail** collapses to 52 px, so its 28 px buttons keep 12 px sides.
- **Baselines:** a checkbox's label sits 1 px lower than centred, onto the baseline of
  the selects and buttons in the same row. `kbd` text is set on 2 px of padding over a
  16 px line, because Cascadia Mono's tall ascent otherwise sits it high in the chip.
- **Wrapping:** the JSON overlay never wraps, so its colours stay under their
  characters; other output wraps as the textarea's `wrap` says (a generator's output,
  and any output over 2 000 characters).
