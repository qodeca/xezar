> **Internal engineering record, not current product documentation.** For how xezar behaves today, read the [root README](../../../README.md).

# Reviewer verdicts on the task record

**Status:** implemented, 2026-09-16 (#460, PR 2 of the 0.15.0 MCP completeness campaign). Fixture-tested;
not yet live-verified with a real attached leader (that is the campaign's T-20 row and remains open).

## The problem

A project leader reading a finished task learned one fact: the chain ran to the end. Whether anyone had
reviewed the work was a different question with no machine-readable answer — the leader had to go and read
a pull-request comment, or, worse, take `task done` as acceptance. The two are not the same claim, and the
cheapest way for an automated reader to be wrong is to assume they are.

`packages/xezar/src/mcp/event-catalog.ts` said only `task finished: done`;
`tools/task-reads.ts` returned the full run record, which carried nothing about a review.

## What was built

A reviewing task writes ONE JSON packet at `${XEZ_HANDOFF_FILE}.verdict.json` after it has posted its
review and attempted the labels it is authorized to move. The engine reads it at that step's settlement,
proves it is about this task and this step, and records it on the run. Task agents gain **no new MCP write
capability**: the authority is exactly one file at one path, read at one moment.

| Piece | Where |
| --- | --- |
| The shapes | `packages/contract/src/task-verdict.ts` — packet, recorded verdict, refusal note, per-role vocabulary |
| On the run | `verdicts` / `verdictIssues` in `packages/contract/src/runs.ts` and `packages/xezar/src/runs/store.ts` (the store imports the contract schema; there is no second declaration) |
| Ingestion | `packages/xezar/src/runs/task-verdicts.ts`, called from step settlement in `packages/xezar/src/workflows/run.ts` |
| Announcement | `verdict.posted` (E-03) in `packages/contract/src/mcp-event-catalog.ts`, emitted by `packages/xezar/src/mcp/event-catalog.ts` |
| The read | `task_read view=task`, unchanged except for its description |
| The producer | the versioned reviewer instructions in `.xezar/skills/` (project files, not shipped code) |

## The four rules that are load-bearing

**The vocabulary is per role and is never translated.** A code review APPROVEs or REQUESTs CHANGES; QA
PASSes or FAILs; a design review has a third outcome, `PASS WITH FOLLOW-UPS`, which is neither. A shared
pass/fail enum erases a design review's outstanding work and lets a QA PASS read as business acceptance,
so the schema is a discriminated union and a role can only carry its own words.

**A verdict applies to the commit it was made against.** `reviewedHeadSha` is mandatory and full — an
abbreviated sha is refused rather than expanded, because the packet is reported and nothing in it may be
completed from a guess. A consumer compares it with the target's head before acting.

**Absent evidence never reads as good evidence.** `labels.state: "verified"` with an empty `observed`
means "we read them and there were none"; `"unavailable"` carries no `observed` key at all. Against a
fail-open reader those would be the same empty array, so the schema refuses `unavailable` WITH a list.

**Publication is two durable steps, so a crash between them is recoverable.** The packet is written to the
run as `publication: 'pending'` before anything announces it; the announcer appends the journal row and
then flips it to `announced`. A process that dies in the gap leaves a `pending` record which the next
`EventCatalog.attach` announces, keyed on the report's own stable `id`: one logical report, never zero and
never two. The reverse order — mark first, announce second — would lose reports instead of duplicating
rows, which is the worse half of the trade.

## What is refused, and how a refusal looks

Refusals go into `verdictIssues` as a bounded reason, never into silence: "the engine threw this away" and
"no reviewer ran" must not look alike. Refused: a non-regular file (a symlink is the attack the path sits
in xezar's own data directory — `lstat` first, then a second check on the opened descriptor, so a file
swapped between the two is still caught); anything over 40 KB; anything that is not valid JSON in the
packet shape; a packet naming another task or another step of this one; and an already-recorded `id`
carrying different content. A refused packet yields no verdict of any kind.

The packet is consumed (removed) after any attempt that read it, so one report is never re-offered to a
later step. The durable copy is the run record, which is why reclaiming a worktree cannot take a recorded
verdict with it.

## What was deliberately NOT built

- No forge access in ingestion. `task_read` stays read-only and mutates nothing, and the packet is evidence
  of what the reviewer SAID, not proof of what GitHub holds. `source: 'task-reported'` is on every record
  so that stays visible rather than conventional.
- No scraping. Nothing looks for the word APPROVE in a Markdown comment.
- No implicit business sign-off. A QA `PASS` is a QA pass. The leader still adjudicates.
- No new setting, flag or route.

## Verification

`packages/xezar/src/runs/task-verdicts.test.ts` holds T-1 … T-5 of the accepted spec, each describe block
quoting the named break it guards. `packages/xezar/src/workflows/run-verdict-collection.test.ts` proves the
engine wiring end to end under `XEZ_DRY_RUN=1`. `packages/xezar/src/mcp/event-catalog.test.ts` covers the
announcement, the restart reconciliation and the completion summary;
`packages/xezar/src/mcp/tools/task-reads.test.ts` covers the leader's read.
