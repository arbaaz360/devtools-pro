# Worker protocol

How a worker, any agent or person on any machine, takes a packet from this
repository, delivers it, and hands it to the integrator. Everything a worker
needs is in the repository or on GitHub; nothing is in anyone's chat history.

## Finding work

Open packets are GitHub issues labelled `packet` and `ready`:

```text
gh issue list --repo arbaaz360/devtools-pro --state open --label packet --label ready
```

Every packet carries exactly one lane label, `antigravity` or `claude`, and a
worker takes only issues in its own lane; a packet in the other lane is not
yours even if it is `ready`. The Antigravity worker does not look for work at
all: the dispatcher on the owner's machine sends it one packet at a time and
it takes nothing else until that packet is accepted, so review rounds never
overlap with new work in the same checkout. The Claude worker takes the
lowest-numbered `ready` issue in the `claude` lane, one per run. The issue
links the packet file under `docs/packets/`; read it from `main`. The packet
is the whole specification. If it is ambiguous, ask (see *Blocked and
questions*); do not guess.

## Automatic dispatch (Antigravity)

On the owner's machine, `scripts/antigravity-worker-loop.ps1` sends each `ready`
packet, one at a time, into an Antigravity conversation the owner opened and told
to wait for packets, using `docs/antigravity/WORKER_PROMPT.md`. It polls GitHub
with `gh`, spends no model tokens while waiting, relays each `CHANGES_REQUESTED`
verdict on the packet's pull request into the conversation once, and moves to the
next packet when the reviewer accepts. A change request on any open
`antigravity/*` pull request is relayed before a new packet starts, so a review
that lands late is not lost. The steps below are what that agent, or any other
worker, then follows.

## Claiming

1. `gh issue edit <n> --add-label claimed --remove-label ready --add-assignee @me`
2. `git fetch origin && git switch -c <branch from the packet> origin/main`
3. Record `git rev-parse origin/main` as your base SHA.

If the packet's branch already exists on `origin`, someone else has it. Stop
and take the next packet.

## Working

- Touch only the paths under the packet's **Allowed files**. The
  `packet-scope` check on the PR fails otherwise.
- Read the packet's **Required reading** first. For plugin packages that is
  `ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
  `packages/plugin-sdk/README.md`, and the reference package the packet names.
- Use only the public plugin SDK. Do not edit the shell (`apps/desktop/src`),
  the host (`apps/desktop/src-tauri`), the contract, the generated catalog,
  root dependencies, or CI, unless the packet lists those paths.
- Keep source documents immutable, outputs complete by handle, and limits,
  cancellation, structured errors and provenance intact.
- No new dependencies. Third-party code a packet needs is vendored by the
  integrator under `packages/vendor/` with its licence and provenance, and
  the packet names it; a worker imports it and never edits it. Files in the
  index are LF.
- A package processor runs in the desktop webview's Worker engine as well as
  under Node, so it may use only web platform APIs: no `node:` imports (use
  `crypto.subtle`, `TextEncoder`, `Uint8Array`). A processor that needs a
  Node built-in is not reachable from the app.
- Commit and push only your branch. Never merge.

## Self-review before handoff

Run every command under the packet's **Checks** and keep the output. Then:

1. `git diff --stat origin/main...HEAD` lists only allowed paths.
2. Every requirement in the packet maps to a test or a fixture you can name.
3. The README describes what the code does, not what you meant it to do.
4. `git diff --check` is clean.
5. Nothing unrelated changed. Any fix outside the packet goes in a `[QUESTION]`.

## Handoff

Open a PR against `main`. Title: `<type>(<area>): <ID> <short title>`. The body
must contain the line

```text
Packet: docs/packets/<ID>-<slug>.md
```

followed by the status block. Post the same block as a comment on every later
push.

```text
[<ID>][STATUS]
commit: <sha>
base: <base sha>
changed: <files>
checks: <each command and its result>
evidence: <headless outputs, screenshots, or NONE>
limitations: <what is not done, and why>
```

Label the PR `needs-native-acceptance` only if the packet says a native run
is required.

## Blocked and questions

If you cannot proceed, or the packet can be read two ways, post on the PR (or
on the issue if there is no branch yet) and add the matching label:

```text
[<ID>][BLOCKED]
needs: <what, from whom>
tried: <what you did>
```

```text
[<ID>][QUESTION]
question: <one question>
options: <the readings you see and which you would pick>
```

Then stop. The integrator answers in the same thread. Do not pick an option and
continue unless the packet says the choice is yours.

If the quality gate fails on files you did not touch, that is a shared
failure: post `[BLOCKED]` with the run link. Do not patch shared code from a
packet branch.

## Integrator verdicts

The integrator replies with one of:

| Verdict | Meaning |
|---|---|
| `[<ID>][CHANGES_REQUESTED]` | Numbered items; push to the same branch and post a new `[STATUS]` |
| `[<ID>][CI_BLOCKED]` | A shared failure; wait for the integrator's fix on `main` |
| `[<ID>][READY_FOR_NATIVE_REVIEW]` | Code accepted; a native run is still needed |
| `[<ID>][READY_TO_MERGE]` | The integrator merges; nothing more to do |

A packet gets at most two `CHANGES_REQUESTED` rounds. After that the
integrator either fixes forward or closes the PR and rewrites the packet.
