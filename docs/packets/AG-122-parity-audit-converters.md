# AG-122 — Parity audit: YAML, QR, JSX, preview, SQL, string case

## Branch

`claude/AG-122-parity-audit-converters` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
docs/parity/**
```

## Required reading

`docs/DEVUTILS_REQUIREMENTS.md` (the six cards named below, in full:
**Required**, **UX** and **Acceptance** for each), `docs/WORKER_PROTOCOL.md`,
`packages/plugin-sdk/README.md`, and each package's own `README.md` under
`plugins/`.

## Goal

An honest gap report for six tools, card by card. The status table says
these tools are *usable*, which means only that they run in the app; nobody
has yet checked them against what their card says they must do. This packet
produces that check, and nothing else — no code changes, no fixtures, no
manifest edits. What it finds becomes the next packets.

The cards and their packages:

| Card | Tool id | Package |
|---|---|---|
| DU-17 / DU-18 YAML ↔ JSON | `convert.yaml` | `plugins/yaml/` |
| DU-21 QR code | `media.qr` | `plugins/qr/` |
| DU-24 HTML/SVG to JSX | `convert.jsx` | `plugins/jsx/` |
| DU-25 / DU-11 Markdown and HTML preview | `preview.documents` | `plugins/preview/` |
| DU-26 SQL formatter | `format.sql` | `plugins/sql/` |
| DU-27 String case converter | `text.case` | `plugins/string-case/` |

## Requirements

- One file per card: `docs/parity/DU-11.md`, `DU-17.md`, `DU-18.md`, `DU-21.md`, `DU-24.md`, `DU-25.md`, `DU-26.md`, `DU-27.md`, named
  for the card, not the tool.
- Each file opens with one paragraph: what the tool does today, in plain
  words, and the single sentence a reader needs about whether it matches its
  card.
- Then a table with one row per **stated requirement**. Split the card's
  **Required**, **UX** and **Acceptance** prose into individual, checkable
  statements — expect 10 to 25 rows per card; a card that yields three rows
  has been skimmed, not read.

  | # | What the card requires | What the tool does | Verdict | Evidence |
  |---|---|---|---|---|

  `Verdict` is exactly one of `met`, `partial`, `missing`, or `n/a (shell)`
  for a requirement about the workspace or presentation rather than the
  processor. `Evidence` is the headless command you ran, shortened to its
  options and the part of the output that decides the row — not a transcript.
- Every `partial` and `missing` row gets a sentence under the table saying
  what it would take to close: which option, property, error code or
  fixture. Keep it to what you can see; do not design the fix.
- Close each file with **Not covered**: anything in the card you could not
  check headlessly (presentation, keyboard, selection), so the human pass in
  `docs/MANUAL_TEST_PLAN.md` picks it up rather than assuming it was checked.
- A summary file `docs/parity/README.md` holding one table across the cards in this packet: card, tool id, rows met / partial / missing, and the single most
  significant gap in a few words. If `docs/parity/README.md` already exists,
  add your rows to its table and leave other rows alone.
- Judge against the **card**, not against the package's own README or its
  fixtures: they describe what was built, which is the thing under test. Where
  the card is ambiguous, say so in the row and give your reading.
- No code, manifest, fixture or test changes. If you find a defect serious
  enough that it should not wait for triage, say so in the row and in your
  status comment; do not fix it here.

## Checks

```text
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr --input "input=https://example.com"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.case --input "input=userID_loader" --options '{"target":"snake"}'
node --experimental-strip-types --test plugins/preview/test.mjs
git diff --check
```

Run the headless script for every row you mark `met`, `partial` or `missing`;
the three above are only the shape of the command. Package tests are run to
confirm the package is in the state you are describing, not as evidence of
parity.

## Evidence

The file names and their row counts (met / partial / missing / n/a per
card), the total across the packet, and the three most significant gaps you
found in one sentence each.

## Out of scope

Fixing anything. Shell and presentation work. Native tools (`structured.json`,
`text.url`, `text.html`, `text.json-string`, `encoding.hash`, `text.compare`,
`text.inspect`), which are audited separately because they do not run through
the plugin SDK.
