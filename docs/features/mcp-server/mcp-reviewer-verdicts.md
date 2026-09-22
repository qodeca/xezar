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
proves it is about this task and this step — and that the step DECLARES the role the packet names
(#851) — and records it on the run. Task agents gain **no new MCP write
capability**: the authority is exactly one file at one path, read at one moment.

| Piece | Where |
| --- | --- |
| The shapes | `packages/contract/src/task-verdict.ts` — packet, recorded verdict, refusal note, per-role vocabulary |
| On the run | `verdicts` / `verdictIssues` in `packages/contract/src/runs.ts` and `packages/xezar/src/runs/store.ts` (the store imports the contract schema; there is no second declaration) |
| Ingestion | `packages/xezar/src/runs/task-verdicts.ts`, called from step settlement in `packages/xezar/src/workflows/run.ts` |
| Announcement | `verdict.posted` (E-03) in `packages/contract/src/mcp-event-catalog.ts`, emitted by `packages/xezar/src/mcp/event-catalog.ts` |
| The read | `task_read view=task`, unchanged except for its description |
| The producer | the versioned reviewer instructions in `.xezar/skills/` (project files, not shipped code) |

## The load-bearing rules

**The vocabulary is per role and is never translated.** A code review APPROVEs or REQUESTs CHANGES; QA
PASSes or FAILs; a design review has a third outcome, `PASS WITH FOLLOW-UPS`, which is neither; an
architecture review (#851) speaks a code review's words, APPROVE or REQUEST CHANGES, and is a role of its
own so its report never takes the code reviewer's slot. A shared pass/fail enum erases a design review's
outstanding work and lets a QA PASS read as business acceptance, so the schema is a discriminated union and
a role can only carry its own words.

**The role list is declared once (#851).** `TASK_VERDICT_ROLES` is the only declaration of the four roles.
The per-role maps (vocabulary, approving words, finding severities) are compile-checked against it, and
both unions — the reported packet and the recorded verdict — are built by mapping over it, so a role added
to the list reaches ingestion, the run record, the MCP `fromFindings.role` argument and the one-packet-per-
role bound (`TASK_VERDICT_MAX_CURRENT`, its length) in one edit. Before this the unions were spelled out by
hand, and a role added to the list alone type-checked and was then refused at ingestion.

**A packet is recorded only as the role its step declares (#851).** Any agent step of any task receives
`XEZ_HANDOFF_FILE` and `XEZ_STEP_ID`, so any step can write a packet. The engine therefore takes the role
from the WORKFLOW, never from the packet: an agent step declares `verdictRole: <role>` in its definition,
and at settlement the engine reads it from the definition the run persisted (`workflowDef`) — the same
record every settlement path (a first run, a Continue, a gate-return re-entry) resolves its steps from. A
packet whose `role` differs, and every packet from a step that declares none, is refused. Without this an
unrelated `quick-task` could write a `code-review` packet and have it recorded over the real reviewer's — a
verdict on the record that no reviewer made. The key was chosen over inferring the role from the step's
skill name: a skill name is free text any workflow can reuse or rename, and a reviewer skill used in a
non-reviewing step would then silently gain the authority; an explicit key is validated by the schema,
visible in the workflow file, and absent by default. A check step may not carry it.

**A verdict applies to the commit it was made against.** `reviewedHeadSha` is mandatory and full — an
abbreviated sha is refused rather than expanded, because the packet is reported and nothing in it may be
completed from a guess. A consumer compares it with the target's head before acting.

**Absent evidence never reads as good evidence.** `labels.state: "verified"` with an empty `observed`
means "we read them and there were none"; `"unavailable"` carries no `observed` key at all. Against a
fail-open reader those would be the same empty array, so the schema refuses `unavailable` WITH a list.

**Publication is two durable steps, so a crash between them is recoverable.** The packet is written to the
run as `publication: 'pending'` and FLUSHED to disk before anything announces it; the announcer appends the
journal row and then flips it to `announced`. The flush is not decoration: the run store's ordinary write
is a 300 ms debounce and the journal's append is immediate, so without it the row could reach disk before
the record it announces — the exact inversion this rule exists to rule out. The packet file is removed
only after that flush, so the worst a crash costs is a re-offer at the next step, which the stable `id`
makes a no-op. A process that dies in the gap leaves a `pending` record which the next
`EventCatalog.attach` announces, keyed on the report's own stable `id`: one logical report, never zero and
never two. The reverse order — mark first, announce second — would lose reports instead of duplicating
rows, which is the worse half of the trade. The announcer re-reads the run on every pass rather than
walking a snapshot, because marking one report announced re-enters the run derivation synchronously and a
snapshot would announce every later pending report twice.

**A reviewer is told its own step id; it never guesses one.** The engine hard-refuses a packet whose
`stepId` is not the settling step's, so the value has to come from somewhere. It comes from `XEZ_STEP_ID`,
set on the agent's environment beside `XEZ_TASK_ID` and `XEZ_HANDOFF_FILE` for every agent step (empty
when there is no step, never omitted, so a nested xezar's own step id cannot shine through). The three
reviewer instructions cite it exactly as they cite `$XEZ_TASK_ID`; before it existed the only derivation
was to read the handoff header for the workflow name and then the workflow file for the step id, which
nothing told a reviewer to do, and an obvious-looking guess cost the whole verdict silently.

## What is refused, and how a refusal looks

Refusals go into `verdictIssues` as a bounded reason, never into silence: "the engine threw this away" and
"no reviewer ran" must not look alike. Refused: a non-regular file (a symlink is the attack the path sits
in xezar's own data directory — `lstat` first, then a second check on the opened descriptor, so a file
swapped between the two is still caught); anything over 40 KB; anything that is not valid JSON in the
packet shape; a packet naming another task or another step of this one; a packet from a step that declares
no `verdictRole` (`the step that settled declares no verdict role, so its <role> packet cannot be
recorded`) or whose `role` is not the declared one (`the reviewer packet reports a <role> verdict, but this
step declares <role>`, #851); and an already-recorded `id` carrying different content. A refused packet yields no verdict of any kind.

A packet that cannot even be LOOKED UP is refused too. Only `ENOENT` means "this task reported nothing";
a permission error or an unreadable directory is a failure to look, and the whole point of the refusal
path is that a failure to look never reads as an absence.

The packet is consumed (removed) after the record — or the refusal note — is durably written, so one
report is never re-offered to a later step and a crash never costs both the packet and the record. The
durable copy is the run record, which is why reclaiming a worktree cannot take a recorded verdict with it.

## What was deliberately NOT built

- No forge access in ingestion. `task_read` stays read-only and mutates nothing, and the packet is evidence
  of what the reviewer SAID, not proof of what GitHub holds. `source: 'task-reported'` is on every record
  so that stays visible rather than conventional.
- No scraping. Nothing looks for the word APPROVE in a Markdown comment.
- No implicit business sign-off. A QA `PASS` is a QA pass. The leader still adjudicates.
- No new setting, flag or route.

## Verification

`packages/xezar/src/runs/task-verdicts.test.ts` holds T-1 … T-5 of the accepted spec, plus T-6 from the
code review of this PR (durability, consume-last and the lookup failure); each describe block quotes the
named break it guards. `packages/xezar/src/workflows/run-verdict-collection.test.ts` proves the engine
wiring end to end under `XEZ_DRY_RUN=1`, including that the agent really receives `XEZ_STEP_ID` — the
mock builds its packet from that variable alone. `packages/xezar/src/mcp/event-catalog.test.ts` covers the
announcement, the restart reconciliation, the two-pending-report case and the completion summary;
`packages/xezar/src/mcp/tools/task-reads.test.ts` covers the leader's read.
