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
| AG-101 | Plugin package tests in the quality gate | antigravity | ready |
| AG-102 | String case converter package (DU-27) | antigravity | ready |
| AG-103 | Unix timestamp converter package (DU-01) | antigravity | ready |
| AG-104 | Number base converter package (DU-19) | antigravity | ready |
| AG-105 | Example string generator package (DU-20) | antigravity | ready |
| AG-106 | UUID package follow-ups | antigravity | ready |
| AG-107 | Escaping package follow-ups | antigravity | ready |
| AG-108 | URL package follow-ups | antigravity | ready |
| AG-109 | JWT decoder and verifier package (DU-04) | claude | ready |
| AG-110 | YAML ↔ JSON package (DU-17, DU-18) | claude | ready |
| AG-111 | SQL formatter package (DU-26) | antigravity | ready |
| AG-112 | XML beautifier and minifier package (DU-16) | claude | ready |
| AG-113 | CSS beautifier and minifier package (DU-14) | claude | ready |
| AG-114 | HTML beautifier and minifier package (DU-13) | claude | ready |
| AG-115 | JavaScript beautifier and minifier package (DU-15) | antigravity | ready |

The earlier packets live in `docs/ANTIGRAVITY_TASKS.md` (AG-001 to AG-007) and
`docs/CLAUDE_TASKS.md` on branch `codex/claude-task-pack` (CL-001 to CL-006).
