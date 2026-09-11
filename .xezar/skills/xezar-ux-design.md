---
name: xezar-ux-design
description: UX design for a user-facing surface
---

# UX design

Design how a person actually uses a surface: the flow, what they see first, and every state. Write it as design, with reasons, not as a list of controls. Use this skill inside `plan-and-spec` (a UX design section in the spec) or `feature-implementation` (before changing a cockpit view): read this file when the task touches a user-facing surface. There is deliberately no `ux-design` workflow. UX rarely stands alone, and a separate run would hand its output to a later task that must re-read it anyway — ceremony, not value. Launch the skill on its own only for a design-only question; its output is a section or a document, never code.

Answer each of these in prose:

1. **Reader and job.** Who uses this surface, and what are they actually doing when they arrive — the task, not a persona. What did they just do, and what do they do next?
2. **First read.** What must be understood before anything is expanded, clicked or scrolled? That belongs in the default, collapsed view.
3. **Scanning many.** How does someone look over many items (tasks, tools, files) and find the one they want: order, grouping, what each row shows at a glance. Add search or filters only when real counts justify them.
4. **The distinction that matters most.** Name the one difference the user must never miss on this surface (read-only against changes-state, destructive against safe, running against finished) and say how it is shown: in words first, with icon or colour only as reinforcement.
5. **States.** Empty (first use, and filtered to nothing), loading, error (what failed and what to do next), refusal (not allowed here — say why and where it is allowed, for example the hosted-mode 409), and stale or partial data. Each state gets its own words, not only a spinner.
6. **Deliberately not built.** What is out of scope and why, including what a user might expect and will not find.
7. **The accessibility bar this repository already holds.** It is not optional: every action works from the keyboard; focus is visible (the existing `:focus-visible` ring); every control is labelled; meaning is never carried by colour alone; changed counts are announced politely; light and dark both work through theme tokens; and at 375px width nothing scrolls sideways (content wraps, tables reflow), checked in a real browser per `docs/testing/agent-browser.md`.

Reuse the cockpit's existing patterns before inventing new ones, and name the component you reuse. Prior art from other products is `xezar-research` work: cite it with URL and read date, or mark it unverified. A design is verified by browser/manual QA per SDLC; an unavailable browser is not a pass.

Inputs: the surface, its users' job and the accepted AC. Output: a UX design section covering the seven points above, with criteria a tester can check. Do not turn a design request into an implementation.

## Shared contract

Before reading kit files in a standalone skill run, if `.xezar/checks/bootstrap.sh` is absent, run `bash "$(git rev-parse --path-format=absolute --git-common-dir)/../.xezar/checks/bootstrap.sh"`. If unavailable or refused, stop with that specific blocker. Never fabricate commands or copy runtime. Workflow launches already perform this step.

Read `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md` and `.xezar/docs/README.md`. Root rules and the current authorized task govern. Workflows snapshot the local kit before work; this does not freeze later skill discovery or companion reads. Record actual delivered skill/reference versions (or unknown), and explicitly restore role/remaining stages for Continue or a backend switch; do not create/adopt another task branch or change a peer's checkout. Use current task identity, not a remembered working directory. Read the task's current checkpoint and late steering before resume or handoff.

The leader owns the goal/plan and adjudication. Specialists own technical evidence and findings. Ask only for a genuinely missing decision outside existing authority, using `XEZ:ASK` with options and custom answer in an interactive terminal agent step. Silence is not authority. Record unresolved dependent work in the primary evidence directory's `BLOCKED` file so readiness cannot pass. A question does not pause a non-final agent step – the step ends done and the workflow moves on – so before you stop for a decision, write `BLOCKED` naming it and its options. Never end a step with the question only in prose. Readiness also refuses a branch with no commits over its base. Independent work may continue. Never waive mandatory quality/AC. Project operations within the authorized plan need no repeated permission; this is not permission to publish when the current assignment excludes it.

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
