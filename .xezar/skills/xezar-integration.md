---
name: xezar-integration
description: Integrate or synchronize root
---

# Integrate or synchronize root

Use exactly one mode from .xezar/docs/recovery.md. Mode A: validate exact PR/head/base, project delivery check, actual hosting rules, head-specific reviews/threads and SDLC QA/labels with integration-preflight.sh. Record existing authority, never manufacture it. Use existing authorized squash-merge into main, then verify resulting commit/tree, target CI and issue scope; squash has one parent, do not require source two-parent merge. Mode B: root-sync only in the actual root under engine no-worktree locking with fixed expected root/branch/head/target and root-sync-preflight.sh. Fast-forward only, never root work through a worktree git -C. Finish to release lease; record no-op honestly. Neither mode edits/publishes releases or waives gates.

Inputs: exact named candidate/target and current authority. Output: guarded integration or fixed-target root synchronization with actual tree/CI evidence. Reconcile snapshot versus current policy, preserve history and refuse missing/ambiguous current checks. Review and active QA remain separate from hosting self-approval.

## Shared contract

Before reading kit files in a standalone skill run, if `.xezar/checks/bootstrap.sh` is absent, run `bash "$(git rev-parse --path-format=absolute --git-common-dir)/../.xezar/checks/bootstrap.sh"`. If unavailable or refused, stop with that specific blocker. Never fabricate commands or copy runtime. Workflow launches already perform this step.

Read `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md` and `.xezar/docs/README.md`. Root rules and the current authorized task govern. Workflows snapshot the local kit before work; this does not freeze later skill discovery or companion reads. Record actual delivered skill/reference versions (or unknown), and explicitly restore role/remaining stages for Continue or a backend switch; do not create/adopt another task branch or change a peer's checkout. Use current task identity, not a remembered working directory. Read the task's current checkpoint and late steering before resume or handoff.

The leader owns the goal/plan and adjudication. Specialists own technical evidence and findings. Ask only for a genuinely missing decision outside existing authority, using `XEZ:ASK` with options and custom answer in an interactive terminal agent step. Silence is not authority. Record unresolved dependent work in the primary evidence directory's `BLOCKED` file so readiness cannot pass. Independent work may continue. Never waive mandatory quality/AC. Project operations within the authorized plan need no repeated permission; this is not permission to publish when the current assignment excludes it.

Writing-stage ownership: implement all code/tests/docs/release metadata, focused tests, self-review and focused commits before full gates. Run only `.xezar/checks/repo-gates.sh --fast` for final canonical evidence. Do not repeat the entire gate list in every agent step. Gate repair returns are at most two; quality-gates allows at most two repairs of the same failure. Preserve history when changing executors; no invented global retry allowance.

Never kill by command-line pattern. `pkill -f <pattern>`, `killall` and `kill $(pgrep -f …)` match every
process this user owns anywhere on the machine, and xezar hands each agent CLI its whole skill text as one
`--append-system-prompt` argument — so a pattern lifted from a skill (`repo-gates.sh --fast` is the proven
one) matches every peer agent running that skill and SIGTERMs all of them, while sparing you and your own
ancestors so you never see the damage (#156: five agents lost mid-review). Kill your own children with
`pkill -P $$`, or save the PID when you start the process and kill that PID. If a pattern is truly
unavoidable, anchor it to this task's own worktree path, and check the match list first with `pgrep -fl`,
which matches identically and signals nothing.

Derive durable evidence with `.xezar/checks/lib/common.sh` (`resolve_task_paths`, `task_evidence_dir`): primary `.local/xezar-tasks/<runId>/`, not the task's reclaimable `.local` or engine tmp. Keep checkpoints concise. Never copy secrets, credentials, `.env`, personal agent configuration or unrelated source content. Reports distinguish observed, fixture-tested, live-verified and unknown. Record relevant dogfooding observations using `.xezar/docs/dogfooding.md`.

Role boundaries: inputs and accepted criteria govern the output; an agent ending done does not certify the artifact. Before handoff inspect the deliverable, current head/base and all remaining stages. Recover predecessor attempt IDs and both consumed repair budgets before a replacement; missing history is unknown, not a fresh allowance. For delivery, takeover, readiness and pilot records use .xezar/docs/ui-operations.md; for snapshot/current-policy reconciliation use .xezar/docs/recovery.md. Preserve these guarantees on standalone, fresh, Continue and restart paths.
