# AG-131 — XML beautify and minify must keep element text (DU-16)

## Branch

`antigravity/AG-131-xml-keeps-text` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/xml/**
```

## Required reading

"Owner decisions → Transforms preserve meaning" in `docs/DEVUTILS_REQUIREMENTS.md`;
the DU-16 card there; `docs/parity/DU-16.md`; `plugins/xml/README.md`; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (finding AST-003, reproduced by the integrator) found that
both operations change element text and report `wellFormed: true` with no
diagnostics:

```text
input                              output
<root><value> hello </value></root>    <root><value>hello</value></root>
<root><value> </value></root>          <root><value/></root>          (a one-space value became empty)
```

A conforming XML parser that preserves whitespace (the review used .NET's
`XmlDocument` with `PreserveWhitespace = true`) reads those values as ` hello ` and
` `. The README documents the trimming, so this is not the code disagreeing with its
docs; it is a default that changes data, which the owner has ruled out for a
formatting operation. The review traced it to `plugins/xml/processor.mjs` near
lines 294, 420 and 469 (at `5866a49`). Mixed content (`<p>Hello <b>world</b> !</p>`)
already survives intact.

## Requirements

- **The text of a leaf element — an element whose children are only text — passes
  through exactly**, including surrounding and whitespace-only text. `<value> </value>`
  stays `<value> </value>`.
- Mixed content stays inline and unchanged, as it does today.
- Indentation is added, and whitespace removed, **only between the children of an
  element that has element children and no non-whitespace text** — the one place
  XML whitespace is conventionally insignificant. Say so in the README.
- `xml:space="preserve"` keeps working as it does.
- Trimming text becomes an option, off by default, labelled so that it says it
  changes content (for example "Trim text in elements (changes values)").

## Checks

```text
node --experimental-strip-types --test plugins/xml/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The expected text comes from the XML specification's whitespace rules, not from
this package.** Leaf text is character data and is preserved; the expected values
in the fixtures (` hello `, one space) are written by hand from the input.

Add an invariant test that can fail on its own: for every successful fixture, the
sequence of leaf-element text values in the output equals the sequence in the input,
character for character, extracted by a small reader written in the test for that
purpose (it need only handle the fixtures' subset). The existing
beautify → minify → beautify stability test stays, but it cannot catch a loss on
the first pass, so it is not evidence here. Quote the fixtures table in your status.

## Out of scope

DTDs, entity expansion policy, namespaces beyond what exists today, the shell.
