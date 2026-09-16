---
name: xezar-ux-design
description: UX design for a user-facing surface
---

# UX design

Design how a person actually uses a surface: the flow, what they see first, and every state. Write it as design, with reasons, not as a list of controls. Two workflows run this skill: `design` (authoring, the questions below, output committed to `designs/<feature>/`) and `design-review` (the review mode at the end of this file). It is also read inside `plan-and-spec` (a UX design section in the spec) and `feature-implementation` (before changing a cockpit view) when a task touches a user-facing surface. Whichever way it is reached, its output is a mockup, a section or a verdict, never application code.

Before anything else, read the design system: start at `docs/design-system/README.md`, then the pages it routes you to for a design (`foundations.md`, `components.md`, `patterns.md`, `writing.md`, `new-designs.md`) and `known-gaps.md`. Name the token, component and pattern you reuse by the name the design system gives it, and put every departure from it in the design's open decisions. A mockup in `designs/<feature>/` links `docs/design-system/cockpit.css` and keeps only feature-specific rules in its own stylesheet.

Answer each of these in prose:

1. **Reader and job.** Who uses this surface, and what are they actually doing when they arrive — the task, not a persona. What did they just do, and what do they do next?
2. **First read.** What must be understood before anything is expanded, clicked or scrolled? That belongs in the default, collapsed view.
3. **Scanning many.** How does someone look over many items (tasks, tools, files) and find the one they want: order, grouping, what each row shows at a glance. Add search or filters only when real counts justify them.
4. **The distinction that matters most.** Name the one difference the user must never miss on this surface (read-only against changes-state, destructive against safe, running against finished) and say how it is shown: in words first, with icon or colour only as reinforcement.
5. **States.** Empty (first use, and filtered to nothing), loading, error (what failed and what to do next), refusal (not allowed here — say why and where it is allowed, for example the hosted-mode 409), and stale or partial data. Each state gets its own words, not only a spinner.
6. **Deliberately not built.** What is out of scope and why, including what a user might expect and will not find.
7. **The accessibility bar this repository already holds.** It is not optional: every action works from the keyboard; focus is visible (the existing `:focus-visible` ring); every control is labelled; meaning is never carried by colour alone; changed counts are announced politely; light and dark both work through theme tokens; and at 375px width nothing scrolls sideways (content wraps, tables reflow), checked in a real browser per `docs/testing/agent-browser.md`.
8. **What gets cut.** When the surface must shrink (a phone, a narrow pane, a long list), say what disappears first and what never does.
9. **Worst case, measured.** The longest list, the longest string, the slowest state and the 375px width, each with a number from the real data or a stated assumption.

Reuse the cockpit's existing patterns before inventing new ones, and name the component you reuse. Prior art from other products is `xezar-research` work: cite it with URL and read date, or mark it unverified. A design is verified by browser/manual QA per SDLC; an unavailable browser is not a pass.

Inputs: the surface, its users' job and the accepted AC. Output: a UX design section covering the nine points above, with criteria a tester can check. Do not turn a design request into an implementation. In the `design` workflow the output is `designs/<feature>/`: `index.html` and one page per screen linking `../../docs/design-system/cockpit.css`, a local `styles.css` with feature rules only, and `README.md` with the headings `designs/README.md` lists plus a `## Design review` section reading "Pending". It is committed; the handoff PR carries `needs-design`.

## Review mode

The `design-review` workflow runs this skill read-only. Inputs: a `designs/<feature>/` path or a PR number. For a PR, read `gh pr view` and `gh pr diff`, boot the cockpit per `docs/testing/agent-browser.md` and look at both themes at 375px and at desktop width; an unavailable browser is not a pass and is reported as such. Read in the order the design system's README gives its review route: `docs/design-system/known-gaps.md` → `patterns.md` → `components.md` → `behaviour.md`.

Check, in this order:

- the ten rules in `docs/design-system/README.md`;
- the states of `new-designs.md` §4 – default, empty, loading, error, refusal, phone;
- appearance per `new-designs.md` §5 – theme, accent, density, width;
- the accessibility bar of point 7 above;
- copy per `writing.md`;
- every departure from the design system has a reason in the design's open decisions or in the PR.

Verdict vocabulary: PASS, PASS WITH FOLLOW-UPS, FAIL. Findings are numbered B-n (blocking) and NB-n (non-blocking); each names `file:line` or page + state and the rule it breaks. Judgement goes on points 1–9; what a test already catches (the guardian, the drift test, the designs lint) is not a finding.

Output: exactly one PR comment whose first line is `## Design review`, posted with `gh pr comment`, carrying the reviewed commit SHA, the reviewer role, the themes and widths checked, the verdict and every finding. When there is no PR, the same text is the run's final message and the requester places it. Never edit the tree; the author links the comment from the README's `## Design review` section. Move labels (`design-approved`, `needs-design`) only when the assignment says so. End the turn with `XEZ:DONE` right after the verdict: a review has nothing to wait for, and a headless run has no channel to answer a question (the first real run stayed in `waiting` for this reason).

### Record the verdict on the task record

In review mode only. After the comment is posted and any labels the assignment authorizes have been attempted, write ONE JSON packet to `${XEZ_HANDOFF_FILE}.verdict.json`. The engine reads it when this step settles and puts the verdict on the task record, where the leader reads it with `task_read view=task`. A verdict that exists only in a comment is one the leader must go and parse; this is the machine-readable half of the same report, never a replacement for it.

Write it atomically — write `${XEZ_HANDOFF_FILE}.verdict.json.tmp`, then `mv` it onto the final name. Never redirect into the final path: a half-written packet is refused and costs you the report.

Order matters: post the comment, then attempt the labels, then write the packet. The packet records what the labels actually DID, so it cannot honestly be written before they were tried.

```json
{
  "id": "design-review-<short sha>-<task id first 8>",
  "taskId": "<$XEZ_TASK_ID>",
  "stepId": "<$XEZ_STEP_ID>",
  "role": "design-review",
  "verdict": "PASS WITH FOLLOW-UPS",
  "reviewedHeadSha": "<the full 40-character sha you reviewed>",
  "summary": "<one or two sentences, at most 2000 characters>",
  "recordedAt": "<ISO-8601, now>",
  "evidenceUrl": "<optional: the URL of the comment you posted>",
  "labels": { "requestedAdd": [], "requestedRemove": [], "observed": [], "state": "verified" }
}
```

`taskId` and `stepId` are read from the environment this step runs under — `$XEZ_TASK_ID` and `$XEZ_STEP_ID`, both set for you. Never guess either one and never substitute the workflow name or the role: the engine compares `stepId` to the settling step's own id, and a mismatch refuses the packet and yields no verdict at all.

`verdict` is `PASS`, `PASS WITH FOLLOW-UPS` or `FAIL`, written exactly as posted. `PASS WITH FOLLOW-UPS` is its own outcome: never write it as `PASS`, or the non-blocking findings disappear from the record. `id` is stable for THIS report — the same id with identical content is a no-op, the same id with different content is refused — and `reviewedHeadSha` is never abbreviated.

`labels` is evidence, not intent. `requestedAdd` / `requestedRemove` are what you asked `gh` to do (empty arrays when you asked for nothing, which is the usual case for this role). Then read the labels back and set:

- `"state": "verified"` with `observed` (what you read back) and `observedAt`, when every request applied;
- `"state": "partial"` with the same two fields, when some applied or the read-back disagrees;
- `"state": "unavailable"` and NO `observed` key at all, when you could not read or write them. An empty `observed` under `unavailable` is refused: "we looked and there were none" and "we could not look" must never be the same value.

A failed label operation never changes your verdict. A posted `FAIL` stays `FAIL` with `unavailable` label evidence.

Bounds the engine enforces: at most 40 KB, a regular file and never a symlink, and `taskId`/`stepId` must be this task and this step. A packet failing any of them records a refusal on the task and yields no verdict at all — the leader then sees "refused", which is what it should see.

## Shared contract

Before reading kit files in a standalone skill run, if `.xezar/checks/bootstrap.sh` is absent, run `bash "$(git rev-parse --path-format=absolute --git-common-dir)/../.xezar/checks/bootstrap.sh"`. If unavailable or refused, stop with that specific blocker. Never fabricate commands or copy runtime. Workflow launches already perform this step.

Read `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`, `BACKWARD_COMPATIBILITY.md` and `.xezar/docs/README.md`. Root rules and the current authorized task govern. Workflows snapshot the local kit before work; this does not freeze later skill discovery or companion reads. Record actual delivered skill/reference versions (or unknown), and explicitly restore role/remaining stages for Continue or a backend switch; do not create/adopt another task branch or change a peer's checkout. Use current task identity, not a remembered working directory. Read the task's current checkpoint and late steering before resume or handoff.

The leader owns the goal/plan and adjudication. Specialists own technical evidence and findings. Ask only for a genuinely missing decision outside existing authority, using `XEZ:ASK` with options and custom answer in an interactive terminal agent step. The project leader works through the Xezar MCP tools only and is attached, so your `XEZ:ASK` and your outcome reach it as pushed xezar events (`leader_events` is its fallback when it is not attached); it answers through the MCP, never the cockpit, and reads GitHub facts with `gh`. Silence is not authority. Record unresolved dependent work in the primary evidence directory's `BLOCKED` file so readiness cannot pass. A question does not pause a non-final agent step – the step ends done and the workflow moves on – so before you stop for a decision, write `BLOCKED` naming it and its options. Never end a step with the question only in prose. Readiness also refuses a branch with no commits over its base. Independent work may continue. Never waive mandatory quality/AC. Project operations within the authorized plan need no repeated permission; this is not permission to publish when the current assignment excludes it.

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

Role boundaries: inputs and accepted criteria govern the output; an agent ending done does not certify the artifact. Before handoff inspect the deliverable, current head/base and all remaining stages. Recover predecessor attempt IDs and both consumed repair budgets before a replacement; missing history is unknown, not a fresh allowance. For delivery, takeover and readiness records use .xezar/docs/ui-operations.md; for snapshot/current-policy reconciliation use .xezar/docs/recovery.md. Preserve these guarantees on standalone, fresh, Continue and restart paths.
