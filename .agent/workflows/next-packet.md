---
description: Claim the next ready packet for this vendor and work it to a PR
---

1. Run `gh issue list --repo arbaaz360/devtools-pro --state open --label packet --label ready --label antigravity --json number,title,body` and take the lowest number. If the list is empty, say so and stop.
2. Read `docs/WORKER_PROTOCOL.md` on `main`, then the packet file named in the issue body (`docs/packets/<ID>-<slug>.md`).
3. Claim: `gh issue edit <number> --add-label claimed --remove-label ready --add-assignee @me`.
4. `git fetch origin` and `git switch -c <branch from the packet> origin/main`. If the branch already exists on `origin`, stop: it is taken.
5. Record `git rev-parse origin/main` as the base SHA.
6. Read every file under the packet's **Required reading**, then implement the **Requirements** touching only the **Allowed files**.
7. Run every command under **Checks** and keep the output. Run the self-review list in the protocol.
8. Push the branch and open a PR against `main` whose body has the `Packet: docs/packets/<file>` line followed by the `[<ID>][STATUS]` block from the protocol.
9. If anything blocks you or the packet can be read two ways, post `[<ID>][BLOCKED]` or `[<ID>][QUESTION]` on the issue or PR with the matching label, and stop.
