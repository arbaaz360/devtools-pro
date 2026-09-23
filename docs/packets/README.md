# Packets

One file per bounded unit of work. A packet is the complete specification a
worker needs: branch, allowed files, requirements, exact checks, required
evidence. The matching GitHub issue (labels `packet`, `ready`) is the queue
entry; this file is the contract. See [`../WORKER_PROTOCOL.md`](../WORKER_PROTOCOL.md).

Every packet has these sections, in this order, and `scripts/check-packet-scope.mjs`
parses **Allowed files** from the fenced block under that heading:

```text
## Branch
## Allowed files
## Required reading
## Goal
## Requirements
## Checks
## Evidence
## Out of scope
```

| ID | Title | Vendor | State |
|---|---|---|---|
| AG-101 | Plugin package tests in the quality gate | antigravity | merged (#25) |
| AG-102 | String case converter package (DU-27) | antigravity | merged (#32) |
| AG-103 | Unix timestamp converter package (DU-01) | antigravity | merged (#36) |
| AG-104 | Number base converter package (DU-19) | antigravity | merged (#52) |
| AG-105 | Example string generator package (DU-20) | antigravity | merged (#55) |
| AG-106 | UUID package follow-ups | antigravity | merged (#56) |
| AG-107 | Escaping package follow-ups | antigravity | merged (#65) |
| AG-108 | URL package follow-ups | antigravity | merged (#66) |
| AG-109 | JWT decoder and verifier package (DU-04) | claude | merged (#48) |
| AG-110 | YAML ↔ JSON package (DU-17, DU-18) | claude | merged (#53) |
| AG-111 | SQL formatter package (DU-26) | antigravity | merged (#68) |
| AG-112 | XML beautifier and minifier package (DU-16) | claude | merged (#67) |
| AG-113 | CSS beautifier and minifier package (DU-14) | claude | merged (#70) |
| AG-114 | HTML beautifier and minifier package (DU-13) | claude | merged (#54) |
| AG-115 | JavaScript beautifier and minifier package (DU-15) | antigravity | merged (#69) |
| AG-116 | Regular expression tester package (DU-03) | claude | merged (#73) |
| AG-117 | Markdown and HTML preview package (DU-25, DU-11) | claude | merged (#74) |
| AG-118 | HTML and SVG to JSX package (DU-24) | antigravity | merged (#75) |
| AG-119 | QR code generator package (DU-21) | antigravity | merged (#77) |
| AG-120 | Parity audit: time, regex, JWT, Base64, URL parser, backslash, UUID | claude | ready |
| AG-121 | Parity audit: HTML, CSS, JavaScript, XML, number base, example strings | antigravity | ready |
| AG-122 | Parity audit: YAML, QR, JSX, preview, SQL, string case | claude | ready |
| AG-123 | QR code reader package (DU-21, the reading half) | claude | merged (#96) |
| AG-124 | The QR generator must encode UTF-8 (DU-21) | claude | ready |
| AG-125 | Declared options that do nothing (DU-26, DU-06, DU-01) | antigravity | ready |

The earlier packets live in `docs/ANTIGRAVITY_TASKS.md` (AG-001 to AG-007) and
`docs/CLAUDE_TASKS.md` on branch `codex/claude-task-pack` (CL-001 to CL-006).
