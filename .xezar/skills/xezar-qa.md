---
name: xezar-qa
description: Independent, read-only QA of a PR or a reviewed head
---

# Independent, read-only QA of a PR or a reviewed head

Exercise the change this task names — check the PR's head out (or use the head you were given) and run it, not just read the diff. Verify the fix actually fixes what it claims to, and check for regressions in adjacent behavior a diff-only read would miss. Never edit the PR's branch, adopt it, or create a duplicate PR: a finding that needs a code change goes back to the author, disputed with evidence or accepted as a scoped, recorded deferral — never fixed here.

Inputs: the PR or head to QA, and what it claims to fix. Output: a single `## QA` PR comment — reviewed sha, verdict (PASS / FAIL), what was exercised and how, and each finding with a disposition — plus the SDLC QA-gate labels this verdict authorizes. Post the comment before anything else in this task risks not finishing; a QA verdict that exists only in this transcript did not happen (this role has no `handoff` step, so the PR comment is the delivery).

## What a QA pass posts

Per `SDLC.md` § The QA gate, evidence is a PR comment whose first line is the heading `## QA`, carrying: the reviewed commit sha; what was exercised and how (the flow, the command, the `XEZ_DRY_RUN=1` session — whichever applies); the verdict, PASS or FAIL; and each finding with exactly one disposition — *confirmed fixed*, *filed as #n*, or *accepted, because …*. A PASS with open low-severity findings still says which are outstanding rather than staying silent.

## Labels this verdict may set

On PASS: apply `qa-approved` and remove `needs-qa`. On FAIL: remove `merge-queue`, post what failed as findings, and remove `qa-approved` if it was applied in error — a failed QA run is a hard block regardless of every other signal (`SDLC.md` § The QA gate). Never apply `qa`, `qa-failed`, `blocked` or `do-not-merge`: this repository does not define those labels; `.xezar/checks/lib/project-policy.mjs` refuses them as a fail-safe for a fork that does, not a vocabulary this role should reach for. This role is independent QA, not the self-QA exception (`qa-self-verified` is for the PR's own author signing off, never for this role).

## Record the verdict on the task record

After the `## QA` comment is posted and the labels above have been attempted, write ONE JSON packet to `${XEZ_HANDOFF_FILE}.verdict.json`. The engine reads it when this step settles and puts the verdict on the task record, where the leader reads it with `task_read view=task`. A verdict that exists only in a PR comment is one the leader must go and parse; this is the machine-readable half of the same report, never a replacement for it.

Write it atomically — write `${XEZ_HANDOFF_FILE}.verdict.json.tmp`, then `mv` it onto the final name. Never redirect into the final path: a half-written packet is refused and costs you the report.

Order matters: post the comment, then attempt the labels, then write the packet. The packet records what the labels actually DID, so it cannot honestly be written before they were tried.

```json
{
  "id": "qa-<short sha>-<task id first 8>",
  "taskId": "<$XEZ_TASK_ID>",
  "stepId": "<this step's id>",
  "role": "qa",
  "verdict": "PASS",
  "reviewedHeadSha": "<the full 40-character sha you exercised>",
  "summary": "<one or two sentences, at most 2000 characters>",
  "recordedAt": "<ISO-8601, now>",
  "evidenceUrl": "<optional: the URL of the comment you posted>",
  "labels": { "requestedAdd": ["qa-approved"], "requestedRemove": ["needs-qa"], "observed": ["qa-approved"], "state": "verified" }
}
```

`verdict` is `PASS` or `FAIL` and nothing else — this role has no third outcome, and a QA `PASS` is never business acceptance. `id` is stable for THIS report: the same id with identical content is a no-op, the same id with different content is refused. `reviewedHeadSha` is never abbreviated and never the branch's current head when that is not what you exercised.

`labels` is evidence, not intent. `requestedAdd` / `requestedRemove` are what you asked `gh` to do (empty arrays when you asked for nothing). Then read the labels back and set:

- `"state": "verified"` with `observed` (what you read back) and `observedAt`, when every request applied;
- `"state": "partial"` with the same two fields, when some applied or the read-back disagrees;
- `"state": "unavailable"` and NO `observed` key at all, when you could not read or write them. An empty `observed` under `unavailable` is refused: "we looked and there were none" and "we could not look" must never be the same value.

A failed label operation never changes your verdict. A posted `FAIL` stays `FAIL` with `unavailable` label evidence — the hard block does not weaken because `gh` did.

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
