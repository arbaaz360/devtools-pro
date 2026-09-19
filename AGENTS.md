# Agents working in this repository

Work here is dispatched as packets. Read [`docs/WORKER_PROTOCOL.md`](docs/WORKER_PROTOCOL.md)
before touching anything.

To take the next packet:

```text
gh issue list --repo arbaaz360/devtools-pro --state open --label packet --label ready
```

Pick the lowest number carrying your vendor label (`antigravity`, `claude`) or
no vendor label, open its packet file under `docs/packets/`, claim the issue,
branch from `origin/main` with the packet's branch name, and follow the packet.
Touch only its **Allowed files**; the `packet-scope` check on your PR enforces
that. Hand off with a `[<ID>][STATUS]` block, or stop with `[BLOCKED]` or
`[QUESTION]`. Never merge.

Project orientation: `ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, `docs/QUALITY_CHECKS.md`.
