# Code review

What a reviewer checks on a pull request in this repository, and how a finding is ranked. The
process around the review — who reviews, how many rounds, when it merges — is in `SDLC.md`
§ Review loop. The rules of each code area are in `AGENTS.md` and the `AGENTS.md` of that area.

## Before you open the diff

1. Read the pull request body: what changed, why, how it was verified, and whether it says it is
   risky.
2. Confirm the gate is green **on the head you are reviewing** — the CI check
   `Typecheck, unit tests, build, and package`, or a sealed run of
   `bash .xezar/checks/repo-gates.sh`. A verdict names that head.
3. Read `BACKWARD_COMPATIBILITY.md` for the surfaces the change may not break, and `SECURITY.md`
   for what this project has promised.

## What to check

- **Correctness.** The change does what the pull request says, on the default path, with every
  new setting at its shipped default. A replacement that ships off is not a replacement
  (`AGENTS.md` § Changing a mechanism that already works).
- **Tests that name the break.** A new or changed behaviour test names the regression it guards
  and the author recorded a failing run (`SDLC.md` § Review loop). A test that passes with and
  without the fix is a guard, and the pull request says so.
- **The HTTP contract.** Every response shape is a zod schema in `packages/contract`; routes are
  chained into a family builder; bodies, params and queries are validated as middleware; all under
  `/api/v1`. A widened schema that hides a route mismatch is a defect.
- **Compatibility.** A change to a surface in `BACKWARD_COMPATIBILITY.md` keeps the old shape
  readable or carries the deprecation that document requires.
- **Shipped text stays generic.** A string a user or an agent reads from the published package
  never names this repository's own files, people or process.
- **Scope.** Nothing outside the task moved, and no unrelated clean-up rides along.

## Security

These files and folders are **trust boundaries**. The kit's security scan names them, so a change
to any of them sets `reviewerRequired` by machine, not by memory, and `.xezar/routing.json` sends
the diff to the security-review row. The risk is not removed; it is made visible and routed.

- **The session-start hook and its loader.** `.claude/settings.json` registers one `SessionStart`
  hook that runs `.xezar/checks/leader-context.sh`, which injects the leader guide and the live
  campaign notes into a session started with `XEZAR_LEADER=1`. Whoever can change either file can
  change what the leader is told at every start, resume and compaction.
- **The leader launcher.** `scripts/xezar-leader.sh` starts Claude Code with
  `--dangerously-load-development-channels` for the `xezar` server and exports `XEZAR_LEADER=1`;
  `scripts/xezar-leader-settings.json` is the leader's permission to run `gh pr merge`.
- **Configuration every run trusts.** `.xezar/config.json` (the base branch),
  `.xezar/pipeline/config.json` (the gate commands, `deploy.*`, `ci.requiredChecks`),
  `.xezar/workflows/`, `.xezar/checks/` with `documented-output.allowlist.json`,
  `.xezar/routing.json` and `.xezar/routing.schema.json`, `.xezar/loops.json`, `.xezar/docs/`,
  `.xezar/skills/`, `.claude/settings.json`, `.claude/settings.local.json`, `.codex/`,
  `.github/workflows/` and `.env.example`.
- **The product's own boundaries.** `packages/xezar/src/server/` (the HTTP surface, its loopback
  and origin guards, the bind host), `packages/xezar/src/mcp/` (the leader's tools and session
  binding), `packages/xezar/src/agent-config/` (the agents' own config files) and
  `packages/xezar/src/workspace/` (per-user state and the project registry).

A change to `deploy.*`, to the base branch, to a workflow file, to a check script or to the
routing file goes to the security-review row, never through an ordinary review. The reviewer
reads `SECURITY.md` first and judges the change against the boundaries listed there.

## Severity guidance

| Severity | Means | Blocks the merge |
|---|---|---|
| **Blocker** | Breaks an acceptance criterion, a protected surface, a security boundary, or loses data. | Yes |
| **Major** | Wrong behaviour on a path users reach, or a missing test for changed behaviour. | Yes, unless the owner accepts it in writing |
| **Minor** | Correct but weaker than it should be: naming, a missing edge-case test, a confusing message. | No — recorded as a follow-up |
| **Nit** | Taste. | No |

Every finding names the file and the line, says why it matters, and states what would resolve it.
A direction question ("should this exist at all?") is not a defect and goes to the owner, not
into a repair round.

## The verdict

Post the verdict as a pull request comment whose first line is `## Code review`, followed by
`Approve` or `Request changes`, the findings by severity, and the `Head:` line naming the commit
you reviewed. A reviewer never approves its own model's work.
