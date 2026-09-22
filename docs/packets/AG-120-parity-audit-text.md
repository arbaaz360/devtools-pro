# AG-120 — Parity audit: time, regex, JWT, Base64, URL parser, backslash, UUID

## Branch

`claude/AG-120-parity-audit-text` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
docs/parity/**
```

## Required reading

`docs/DEVUTILS_REQUIREMENTS.md` (the seven cards named below, in full:
**Required**, **UX** and **Acceptance** for each), `docs/WORKER_PROTOCOL.md`,
`packages/plugin-sdk/README.md`, and each package's own `README.md` under
`plugins/`.

## Goal

An honest gap report for seven tools, card by card. The status table says
these tools are *usable*, which means only that they run in the app; nobody
has yet checked them against what their card says they must do. This packet
produces that check, and nothing else — no code changes, no fixtures, no
manifest edits. What it finds becomes the next packets.

The cards and their packages:

| Card | Tool id | Package |
|---|---|---|
| DU-01 Unix timestamp converter | `time.unix` | `plugins/time/` |
| DU-03 RegExp tester | `text.regex` | `plugins/regex/` |
| DU-04 JWT decode/verify | `security.jwt` | `plugins/jwt/` |
| DU-06 Base64 text | `encoding.base64-text` | `plugins/base64-text/` |
| DU-07 URL / query parser | `web.url-parser` | `plugins/url/` |
| DU-09 Backslash escaping | `text.backslash` | `plugins/escaping/` |
| DU-10 UUID generate/decode | `identity.uuid` | `plugins/uuid/` |

## Requirements

- One file per card: `docs/parity/DU-01.md` … `docs/parity/DU-10.md`, named
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
- A summary file `docs/parity/README.md` holding one table across all seven
  cards: card, tool id, rows met / partial / missing, and the single most
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
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=1700000000"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin security.jwt --input "input=<a token you minted>"
node --experimental-strip-types --test plugins/regex/test.mjs
git diff --check
```

Run the headless script for every row you mark `met`, `partial` or `missing`;
the three above are only the shape of the command. Package tests are run to
confirm the package is in the state you are describing, not as evidence of
parity.

## Evidence

The seven file names and their row counts (met / partial / missing / n/a per
card), the total across the packet, and the three most significant gaps you
found in one sentence each.

## Out of scope

Fixing anything. Shell and presentation work. Native tools (`structured.json`,
`text.url`, `text.html`, `text.json-string`, `encoding.hash`, `text.compare`,
`text.inspect`), which are audited separately because they do not run through
the plugin SDK.
