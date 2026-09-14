# Decisions – requirements interview record (grill-me), 2026-09-14

Status: **closed – the read-back was confirmed by the owner.** The 20 decisions below are locked input to [decisions-requirements.md](decisions-requirements.md) – decisions 1 to 19 from the interview, and decision 20 added the same evening while the revised mockup was reviewed (cited below as *D-n*). The design draft under review was `designs/decisions/` at its 2026-09-14 state; the five-reviewer verdict on that draft is in [decisions-design-review-2026-09-14.md](decisions-design-review-2026-09-14.md).

Method: the `erfana:grill-me` interview skill – one question at a time, a 16-dimension coverage map, a decisions ledger, a read-back. Interviewer: the leader session (Claude Code). Interviewee: the owner.

## Context that triggered the interview

The 2026-09-13 leader campaign ([leader-dogfooding-2026-09-13.md § 14.2](../mcp-server/leader-dogfooding-2026-09-13.md)) shipped a cockpit control that no issue had asked for. It passed the design review, manual QA twice, three code reviews and the kit's gate seal. Nobody asked the owner. A design for an owner-only decision gate was drafted the same day; five reviewers found that, as drafted, the gate would not have caught that case. The interview was run before any rewrite.

## The owner's account (verbatim)

> From time to time Xezar agents are making some important decisions themself or ask leader to decide. Not all of those decisions should be taken by the agents or the leader as they are too critical so human should decide. Scope creep is one of them as the example.

## Sizing

Depth: **full**. Blast radius: the engine's default path for every project, the agent marker contract, the MCP tool surface, the cockpit. Reversibility: a new marker and new stored fields are a one-way door once agents and old run files depend on them. Cost of wrong: a gate that says "safe" when it is not is worse than no gate. Consumers: every xezar user, plus the shared skills repo. No areas skipped at this depth.

## Coverage map at close

| Dimension | State |
| --- | --- |
| Account | done |
| Goals and worth | done |
| Stakeholders | done |
| Problem definition | done |
| Assumptions | done |
| Evidence and gaps | done |
| Alternatives | done |
| Values and trade-offs | done |
| Failure modes (premortem) | **waived – the owner skipped the premortem question** |
| Second-order consequences | done |
| External environment | done |
| Extremes and unlikelies | done |
| Reversibility | done |
| Success metrics | done |
| Perspective shifts | done |
| Meta check | done – "No, you have it" |

Questions asked: 19 (floor for `full`: 16). Weakest coverage, named at the read-back: failure modes – no boring reason the feature fails in a year was recorded; the interviewer's own candidate is "nobody reads the list".

## The decisions ledger

Each row: the decision as locked, the question that produced it, and the alternatives the owner did not pick.

| # | Decision | Question | Rejected alternatives |
| --- | --- | --- | --- |
| 1 | Some decisions are too critical for agents or the leader. A human takes them. Scope creep is one example. | The account. | – |
| 2 | The real reason: run xezar all night unattended, check the Decisions list from time to time, decide in the morning, xezar continues. | What does this let you do that you cannot do today? | "Catch drift I can still see" and "prove it for other users" were offered; the owner took all three, with the unattended night as the driver. |
| 3 | A task that waits for a decision **frees its slot** and goes back to the queue when the decision is made. | Same answer, volunteered by the owner. | – |
| 4 | After the decision, the agent is resumed **with the context window it had before it asked**. | The agent session is gone; what does the task do with the answer? | Re-run the step with the answer; a fresh Continue turn; per-option semantics. |
| 5 | If the old context cannot be resumed (pi, an expired session, a model no longer available), the **same step re-runs with a fresh agent**: brief, handoff notes, plus the decision. | Ladder on 4. | Fail the task and tell me; never open a case on a backend that cannot resume. |
| 6 | The mandate is the **leader's brief plus the linked issue, no matter who wrote them**. | What counts as "what the owner asked for"? | The linked issue only, written or approved by the owner; the plan approved with the leader. |
| 7 | Two nets: **at task creation or brief edit by the leader**, xezar compares the brief with the linked issue and a brief that adds a user-facing surface the issue does not name opens a case before the task runs; **the diff check at the end stays**. | Given 6, the round-4 brief named the button – where should xezar have stopped it? | The leader must ask on its own (honour system); accept the miss. |
| 8 | **Whoever can open the cockpit is the owner.** Multi-person teams are out of scope for this version. | Who may answer a case? | Only a named GitHub user; anyone, but the name is recorded. |
| 9 | The model scope check ships as a **report first**; it becomes a blocking case only after the false-alarm rate is measured on the campaign PRs. | If the model check is unreliable, what should version 1 do? | Block from day one; drop the model check. |
| 10 | Human decisions include **QA and review adjudications**, and **anything that changes the definition of done** for an issue, an epic or a campaign. | Besides the button, which campaign decisions did you want to take yourself? | Merges and root-syncs; money – not selected. |
| 11 | "Outside action" means **publish and release only**: npm, a GitHub Release, a tag, a deploy. Merges, root-sync and spend stay with the leader. | Merges and spend were within authority – what stays in the category? | Drop the category; keep it broad including merges. |
| 12 | **Build a new task state**: stopped, slot freed, survives restarts, no leader tool can move it. The review gate and `XEZ:ASK` stay as they are. | Why not extend the review gate and XEZ:ASK? (re-asked in simpler words) | Patch the existing tools first. |
| 13 | **When in doubt, xezar opens a case.** A false stop is cheaper than a miss. | Which wins: never miss, or never stop for nothing? | Never stop for nothing. |
| 14 | **No cap** on cases for now. Count them and tune the instructions later. | What stops agents from over-asking? | The four categories as the only door plus an owner-side "not a decision"; a cap per night. |
| 15 | A task with **no linked issue: the brief is the source of truth**. Accepted hole: a leader can avoid the brief check by not linking an issue. The end-of-task report still runs. | No GitHub or no linked issue – what is the mandate? | A leader task with no issue always asks; skip the brief check, keep the diff report. |
| 16 | The leader may relay an answer. The value is the **written, timed, reopenable record**. A lying leader leaves a trail. | Devil's case: if the leader can open and answer a case itself, what does the gate buy? | Only the cockpit closes a case; build elicitation first. |
| 17 | The task state, the record fields and the agent word **all ship together**. | Build all three hard-to-undo parts now, or the state first and the agent word later? (re-asked in simpler words) | State first, agent word later. |
| 18 | Success after a month: leader tasks run overnight alone; the morning list holds cases, not repair work; **resumes succeed above 95 %**; **a case is answered in under two minutes** on average; the campaign replay shows the button would have stopped. | What tells you after one month that this worked? | Zero unwanted surfaces shipped; "I trust it enough to stop reading diffs". |
| 19 | Before the first unattended night, all four must hold: the leader cannot move a stopped task; a stopped task frees its slot; a restart keeps cases and stopped tasks; the morning tells me how many cases wait. | Walk backwards from the first successful night: what must be true the evening before? | – (all four offered were taken) |
| 20 | *(added after the interview, 2026-09-14 19:50, while reviewing the revised mockup)* A fourth answer, **"Leader decides"**: the owner hands one case to the leader. The case leaves the owner's badge, the task stays stopped, the leader answers with a required **reason**, the owner can take it back at any time. Only the cockpit can delegate. | Owner: "I would add third option: 'Leader decides'"; interviewer asked whether the handed-over case stays in the badge (re-asked in simpler words) and whether the leader must give a reason. | Keep counting it in the badge; option alone, no reason. |

## Tensions the interviewer recorded

- **6 and 7 against the motivating case.** With the brief as part of the mandate, the round-4 brief that named the button would pass the end-of-task diff check. Decision 7 moves the stop earlier: the brief-vs-issue check at task creation is what catches leader-authored drift. Decision 15 then re-opens a hole (no issue, no brief check); the owner accepted it knowingly.
- **13 against 9.** "When in doubt open a case" is the tuning direction; "report first" is the rollout order. They do not contradict: the report phase exists to measure how often "in doubt" fires before it is allowed to stop a task.
- **14 against 2.** No cap on cases means the morning list can be long. The owner chose to measure before limiting.
- **4 and 5 against today's recovery.** A restart today resumes a run as a bare `continue-N` step and loses the workflow spine (campaign finding § 14.4 item 1). Decision 4 requires the resume to stay inside the step that asked, so that gates and handoff still run after it.

## Waived areas

| Area | Reason |
| --- | --- |
| Failure modes (premortem) | The owner answered "skip this question". Recorded as waived; the interviewer's unconfirmed candidates were: nobody reads the list; agents never ask; resumes are flaky; the leader routes around it. |

## What the interview changed in the design

Compared with the 2026-09-14 draft in `designs/decisions/`:

1. A **new task state** replaces "the task parks at `waiting`" (decision 12; the reviews had shown `waiting` is not a safe park).
2. A stopped task **frees its slot** and re-queues on decision (decision 3) – not in the draft at all.
3. Resume semantics are defined: **session resume inside the step**, with a fresh-agent re-run of the same step as the fallback (decisions 4, 5) – the draft had "the run continues with your answer" and no mechanism.
4. The **brief-vs-issue check at leader task creation** is new (decision 7); it is the net that catches the motivating case.
5. The diff check is **report-only in version 1** (decision 9).
6. Categories are narrowed: **outside action = publish/release only** (decision 11); **adjudications and definition-of-done changes are explicitly human** (decision 10). The draft's "breaking change" category stays.
7. The mandate is the brief plus the linked issue (decision 6); without an issue the brief alone (decision 15).
8. The agent marker ships with the first release (decision 17) – and, per the solution review, as a **new marker** rather than an extension of `XEZ:ASK`.
