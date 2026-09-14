# Decisions – five-reviewer verdict on the first design draft, 2026-09-14

Status: **record of a review that happened before the requirements were written.** The draft reviewed is `designs/decisions/` at its 2026-09-14 state (uncommitted on `feature/decisions-design`, base `0c4fbde`). The grill-me interview that followed ([decisions-grill-record-2026-09-14.md](decisions-grill-record-2026-09-14.md)) resolved most of the blocking findings by decision; the column "Status" says how each finding stands against [decisions-requirements.md](decisions-requirements.md).

Five read-only reviewers ran in parallel, each with its own brief:

| Reviewer | Lens | Verdict |
| --- | --- | --- |
| Business and product | Does it solve the motivating case; value for other users; incentives; cost | Would not have caught the motivating case as written; three placement fixes make it a gate; a smaller first slice delivers most of the value |
| UX (`xezar-ux-design` review mode) | The mockups against the design system and its review checklist | **FAIL** – five blocking, thirteen non-blocking; the idea and the first-read order praised |
| UI craft | Tokens, fidelity to the real ask card, both themes, density | Token hygiene clean; three blocking fidelity and contrast findings; the mockup fixes two real cockpit gaps |
| Engineering feasibility | Every claim in the developer notes against the code | Feasible with changes, not as written; the parking mechanism does not survive contact with the engine |
| Solution coherence | The case record, its state machine, API and MCP shapes | Critical issues – three severity-4 gaps in the state machine and the agent contract |

Their full outputs were produced in the leader session's scratchpad and are condensed here; where two reviewers found the same thing it is listed once with both names.

## 1. Blocking – the design would not do its job

| # | Finding | Evidence | Found by | Status after the interview |
| --- | --- | --- | --- | --- |
| R-1 | **The scope check anchors on the leader's brief, which named the drift.** The round-4 brief for #403 told the agent to address the QA fail whose only finding was the missing control. A check that asks "what does the mandate not name" answers "nothing". | `.local/xezar/runs.json` briefs `58db5bb0`, `9a6de2f2`, `6f8c1c1e`; dogfooding § 5 lines 211–212 | business | Resolved by decisions 6, 7 and 15: the brief stays part of the mandate, but a **brief-vs-issue check at leader task creation** opens the case before the task runs. Without an issue the brief is the truth (accepted hole). |
| R-2 | **The check runs after the PR exists, and merging is a different run.** `settleSuccess` fires when the workflow ends; the kit's `handoff` step has already pushed and opened the PR; the merge is an integration run using `gh`. A block "when the branch belongs to that run" never sees the integration run. | `packages/xezar/src/workflows/run.ts:4130`; `.xezar/workflows/feature-implementation.yaml`; `.xezar/skills/xezar-integration.md:8` | business, engineering | Partly resolved by decision 7 (the creation-time net) and decision 9 (the diff check is report-only in v1). The **cross-run PR binding** (refuse `ready`/`merge` for any PR that carries an open case) is a requirement (F-13). |
| R-3 | **`waiting` is not a durable park.** It means "agent session open, ball in the user's court" and has on-by-default exits nobody in the design fires: the 15-minute idle timer, restart recovery (`recover()` settles every `waiting` run), the autonomous nudge, the monitoring wake timer, usage-limit auto-resume. The scope check as placed runs after the session closed, so a run parked there can be neither continued nor messaged. | `run.ts:3695,3718-3725,4242-4257,1504-1514,3209-3219,4273-4289`; `core/ui-events.ts:347-349` | engineering, solution | Resolved by decision 12: a **new settled task state**, no open session, no timer, `recover()` leaves it alone. Decision 3 goes further: the state also frees the slot. |
| R-4 | **A case raised in a non-final step fails the run.** `unfinishedStepReason` fails any non-final agent step whose turn ends on an ask; the run goes `failed`; a Continue after that never runs the rest of the chain. Every kit writing step is non-final. | `run.ts:127-140, 3839, 2707-2709`; `BACKWARD_COMPATIBILITY.md` § 8 | engineering, solution | Resolved by decisions 4 and 5: the chain is **suspended at the step**; the resume stays inside the step (session resume, or a fresh agent re-running the same step). New engine machinery; its own delivery step. |
| R-5 | **Extending `XEZ:ASK` with `owner` degrades silently on every shipped xezar.** The schema is `.strict()`; the normaliser rebuilds the object keeping only `questions` and succeeds, so an old engine renders an ordinary ask card that the leader can answer – the exact failure the gate exists to stop, with no error anywhere. | `packages/xezar/src/core/ask.ts:42-52, 113-148, 232-238` | solution, engineering | Resolved: a **new marker `XEZ:DECIDE`**. An old engine sees unknown prose, builds no card, and in a non-final step fails closed – the right direction. Ships with the first release (decision 17). |
| R-6 | **Headless `xezar run` hangs forever on a case.** `run` resolves only on `done`, `review`, `failed`, `cancelled`; a case has no cockpit, no leader, no decider. | `packages/xezar/src/index.ts:567-569`; `BACKWARD_COMPATIBILITY.md:15` | business, solution | Open – requirement F-25 proposes the exit contract; the owner has not chosen (OD-3). |
| R-7 | **`autonomous: true` is undefined against a case, and it is the leader's night-wave path.** `task_create` tells the leader autonomous "never pauses for the user"; `settleSuccess` skips review for it. | `mcp/tools/task-create.ts:75`; `run.ts:4137` | business | Resolved by decision 2 and 19: the whole point is the unattended night, so **a case stops autonomous runs too**; the tool description changes (F-10). |
| R-8 | **A decision has no defined effect on the workflow.** Deciding sends a message and the run continues at its current step; with the case opened before `handoff` (whose skill forbids source edits), "Remove it" is recorded and cannot be executed. | `.xezar/skills/xezar-handoff-draft-pr.md:8` | business | Resolved by decisions 4 and 5: the decision is delivered into the step that asked, which is the writing step. |

## 2. Should fix – mechanism and contract

| # | Finding | Found by | Status |
| --- | --- | --- | --- |
| R-9 | `mandate` frozen at creation is the wrong instant: `task` is editable while queued and folds with `queuedMessages` at dequeue. Freeze at dequeue from the folded text; keep `createdBy` and `source` at creation; record later `edit_brief` calls as amendments. | engineering, solution | Adopted (F-6). |
| R-10 | The case should live **on the run record**, not in a separate `decisions.json`: the workspace SSE carries only run snapshots, so a separate file cannot feed the nav badge or the multi-project counts; every live surface already reads run records. Keep the NDJSON events for history. | engineering | Adopted (F-16); the solution reviewer's journal-plus-snapshot alternative is recorded as rejected. |
| R-11 | The MCP tool must require `operationId` (a retried `open` would open a second blocking case) and reuse the existing families rather than add a fifth tool: `task_read view: 'decisions'`, and `execution_control` actions `open_decision` / `record_decision`. | solution | Adopted (F-19, F-20). |
| R-12 | `blocks[]` is policy stored as data; derive it from the state, put it on the wire, never persist it. | solution | Adopted (F-12). |
| R-13 | A third origin vocabulary (`raisedBy.kind`, `via`) beside `human\|leader\|system` and `ui\|mcp\|automation\|cli`, and `via` proposed as a tool argument where both existing vocabularies are server-derived. Use `raisedBy: task-agent \| leader \| scope-check` (a role, not an origin) and `channel: ui \| mcp` (server-derived). | solution | Adopted (F-16), with a fourth role `brief-check` for the creation-time net. |
| R-14 | The version guard on a case must be the case's own token (`rev1:decision:<caseId>:…`), not the run's, which moves with every event. | solution | Adopted (F-17). |
| R-15 | `actedOnAt` has no definition and no firer; for a scope case answered "Remove it" the removal is usually another task. Proposed rule: the first outward effect after the decision – next turn started, push, PR create/ready/merge. | solution | Adopted (F-18). |
| R-16 | Reopen has no mechanism against a live agent; there is no interrupt-without-cancel. Refuse reopen while a turn is in flight, or deliver the withdrawal at the next turn boundary – and say which. | solution | Adopted: refuse while a turn is in flight (F-18). |
| R-17 | The scope check's fail-open lies twice: it must run **before** the status write (a window where `finish`/`create_pr` are legal), and an absent mandate must yield `unknown`, never "nothing to flag"; "did not run" must be a three-valued record field the leader and the review banner read, not a note. | solution, engineering | Adopted (F-8, F-9). |
| R-18 | The model call copies the namer: default runner, `namerModel` only on Claude, 20 s timeout, two attempts; a codex/pi project resolves to nothing; `XEZ_DRY_RUN=1` needs a `[xez-scope]` mock trigger; the cost is a default-on model turn per writing task on the user's account. | engineering, solution, business | Partly adopted (F-9); the runner and cost question is OD-5. |
| R-19 | The scope check on `worktree: false` runs would diff the owner's own uncommitted work; use the run's own commits via `resolveTaskDiffBase`, or skip and log. | business | Adopted (F-8). |
| R-20 | Crash recovery: a recovered run with an open case must stay parked; today `recover()` resumes running/waiting runs as bare `continue-N`. | business, engineering | Adopted (F-11, decision 19). |
| R-21 | Multi-question `XEZ:ASK` (1–4 questions) versus one case; `multiSelect` not forbidden; a duplicate `options` list beside `question.options`; `recommended` should name a label, not an index. | solution | Adopted (F-1). |
| R-22 | No owner-side "this is not a decision" answer, so a false alarm costs a fake decision in the history. | business | Adopted as the `not-a-decision` outcome (F-15). |
| R-23 | `outside-action` collided with F-04/F-11 of the MCP requirements, where merge and publication are autonomous capabilities. | business | Resolved by decision 11: outside action = publish and release only; merges stay autonomous. |
| R-24 | Three required-gate updates missing from the plan: `BACKWARD_COMPATIBILITY.md` § 2 route inventory, § 3 state files, § 8 marker vocabulary; the closed journal-kind table and its scenario test; `ensureDataGitignore`. | solution, engineering | Adopted (§ 12 of the requirements). |
| R-25 | `ownerWords` is leader-authored text delivered to an agent as the owner's; bound it, keep it out of the audit trail, say whether the agent receives it verbatim. | solution | Adopted (F-20); verbatim delivery is OD-6. |
| R-26 | The multi-project badge needs a workspace-level read and one root subscription, not a per-project query. | solution | Adopted (F-27). |
| R-27 | Smaller first slice: kit text changes now; the marker, the record action and the 409s with an owner-only variant of the ask card; the scope check as a non-blocking report replayed on the campaign PRs; the page and tab when there are more than 0–3 cases at a time. | business | Partly adopted: decision 9 (report first) and decision 17 (the contract ships together). The page ships with the first release because decision 19 needs "the morning tells me the count". |

## 3. UX and UI findings on the mockups

The UX verdict was FAIL. These are the findings that survive the requirements rewrite and must be fixed in `designs/decisions/`; the rest were either superseded by the new state (the "task stays `waiting`" praise in "What passed" is now wrong) or are recorded in [§ 4](#4-findings-superseded-by-the-requirements).

| # | Finding | Rule broken | Found by |
| --- | --- | --- | --- |
| U-1 | Meaning-bearing small text is `--soft-foreground` (2.5:1 in light): the card head, the send hint, the decided foot, tab counts, evidence headings, the composer hint. The send hint is the visible reason Send is disabled. | `known-gaps.md` G-23 | UX, UI |
| U-2 | The load-error state carries an invented sentence ("The connection to xezar was lost…") – the same invented sentence the quality-checks review blocked on – and a period on a title; it should be `CenteredState tone="danger"` with the server message verbatim. | `writing.md` § 7, `patterns.md` § 6 | UX |
| U-3 | Open / Decided is drawn as a `tablist` with no `aria-controls` or `tabpanel`, the README says `TabLink`, and the task page shows tabs **and** a "Decided" group at once while AC-15 says one list. | `components.md` Tabs; `behaviour.md` § 1 | UX, UI |
| U-4 | A new case is announced three times to a screen reader (list live region, banner `role="status"`, thread card), and the list region reads whole cards. One `sr-only` `role="status"` line per surface. | `behaviour.md` § 2 | UX |
| U-5 | Phone touch targets are 30–40 px (Send 40, Reopen and Retry 30, the details summary ~33) where the bar and the design's own copy say 44. | `new-designs.md` § 6, `patterns.md` § 9 | UX, UI |
| U-6 | The banner icon is lime on a white card (1.34:1 in light); the banner matches none of the five shape values of the review banner it names (radius, wash, border, padding, stacked lead). | `review-panel.tsx:42`; foundations | UI, UX |
| U-7 | `.case-card` mixes with `var(--border)` / `var(--card)` where the ask card composites alpha over the page; the mockup card is visibly lighter than the component it extends. | `ask-card.tsx:82` | UI |
| U-8 | Three lime category chips and a grey `contrast` Send invert "lime is the one call to action"; under `data-accent="violet"` the chip drops to 3.1:1 at 10 px. Either make Send `primary` (the ask card's own choice) or put the category on `--muted`. | foundations § 2; `components.md` Button | UI, UX |
| U-9 | The option group has no `role="group"` and no label, although the README promises it and `ask-card.tsx:172` does it. | `README.md` § 11 | UX |
| U-10 | The mobile top-bar count is `aria-hidden` with no `sr-only` sibling. | – | UX |
| U-11 | The Textarea is 44 px where the component says `min-h-16`; the `.case-cat` radius is a raw 6 px; `.plus`/`.minus` and two focus rules re-declare base classes; `.dec-alert` should be `.banner-row.alert`; `.dec-skeleton` should be `.skeleton`. | `new-designs.md` § 2 | UI, UX |
| U-12 | Four prose sizes for one kind of prose, two of them control sizes (12.5 and 13.5); the plain-words block – the text the owner reads – is the second smallest on the card. Proposed: question 14, plain 14, technical 13, descriptions 12. | foundations § 3 | UI |
| U-13 | After Send, focus falls to `<body>` when the card leaves the Open list; the race alert does not say the typed comment is kept. | AC-12; `components.md` Composer | UX |
| U-14 | The card never says whether the decision can be taken back; the highest-stakes case ("Publish 0.15.0 to npm now?") states the effect but not the window. | `patterns.md` § 7 | UX |
| U-15 | Scanning many is unanswered: ten full cards at 375 px is ~3,500 px of scroll; the Decided tab grows unbounded; the rule strip repeats the empty state on every visit; the head line wraps to three lines with "Breaking change" and "Outside action". | skill points 3 and 8 | UX |
| U-16 | Three counts with two meanings: the header counts tasks, the badge and tab count cases. | – | UX |
| U-17 | "needs your decision" is a second word for a status, introduced outside `lib/attention.ts`. With the new state this becomes the state's own label and moves into `attention.ts`. | design-system rule 7 | UX |
| U-18 | The scope check's own wait has no state on the task page, and no duration in the worst-case section. | `new-designs.md` § 4; skill point 9 | UX |
| U-19 | Copy: straight quotes around *done* and straight apostrophes in shipped strings; `md` named as 860 px (it is 768). | `writing.md` § 1; `behaviour.md` § 3 | UX |
| U-20 | Handoff: the departures from the design system are not listed (`case-cat` chip, contrast Send, the stand-in classes); no px-to-Tailwind mapping, so the card would ship as `p-[14px]` outside the density lever; `known-gaps.md` § Mockup fidelity has no `dec-*` rows. | `new-designs.md` § 8; foundations § 4 | UI |

What the reviewers said is right and must be kept: zero raw colour; status colour only in the dot; the ask card genuinely reused; the first-read order (question → plain words → technical details → options → comment → send); `<details>` for evidence; `aria-disabled` on Send so its reason stays reachable; the empty states; hosted mode answered rather than faked; the plain-words fallback that fails loudly.

## 4. Findings superseded by the requirements

- "The task stays `waiting`; no new run status" – praised by the UX reviewer as rule-7 compliance, contradicted by the engineering and solution reviews, and replaced by decision 12. The new state gets its own row in `lib/attention.ts`.
- "Deciding sends a `user-message` and the run continues" – replaced by decisions 3–5 (re-queue; resume inside the step).
- "Block the scheduler" – vacuous (the scheduler dequeues `queued` only) and replaced by the state itself.
- "A case parks at `waiting` and blocks `send_message`" – the composer is still disabled while a case is open, but the block now follows from the state, not from a route check.
- `human_decision` as a fifth MCP tool – replaced by actions on `execution_control` and a `task_read` view.
- `decisions.json` – replaced by the case on the run record.

## 5. Open questions the reviewers raised that the owner has not yet answered

Carried into [decisions-requirements.md § 11](decisions-requirements.md#11-open-decisions): headless `xezar run` (OD-3); one open case per run or many (OD-1); a case whose task failed or finished (OD-2); may the leader reopen (OD-4); the scope check's runner, model and cost attribution (OD-5); verbatim `ownerWords` to the agent (OD-6); a ship threshold for false alarms (OD-7); per-project categories (OD-8).

## 6. The draft against the requirements – gap list (leader session, 2026-09-14 evening)

Read after [decisions-requirements.md](decisions-requirements.md) was written. Each row says what the draft in `designs/decisions/` shows, what the requirement says, and what changes. G-n rows are requirement gaps; the U-n rows of § 3 are the design-system fixes and are not repeated.

| # | Where in the draft | Draft says | Requirement | Change |
| --- | --- | --- | --- | --- |
| G-1 | `index.html` decision table "Task status"; `task.html` bullets; README § 7.4, § 10, § 13 | The run stays `waiting`; "needs you" pill; no new status | F-10, F-28: a new `decision` state with its own `attention.ts` row, label "needs your decision" | Rewrite the row and the bullets; the pill reads "needs your decision"; README § 10 lists `lib/attention.ts` |
| G-2 | Everywhere | A stopped task keeps its slot and session | F-10: slot released, session ended, no timers; D-3 | Say it on the task page banner ("stopped – the slot is free") and in README § 7.4; show a queued task starting in S-02 |
| G-3 | Banner copy, README § 7.4 | "It continues the moment you decide" | F-23, F-24: it goes back to the queue, then resumes with its context or re-runs the step fresh | New copy: "It goes back to the queue the moment you decide and picks up where it stopped." Add `resumedWith` to the decided line ("resumed with its context" / "re-ran the step") |
| G-4 | The three sample cases; `task.html` thread | The Attach leader case is raised by the **diff** check after the work, blocking | F-7, D-9: version 1 catches it with the **brief net** before the task runs; the diff net is report-only | Recast case 1 as a brief-net case: raiser "xezar · brief check", evidence = the brief beside the issue quote, blocked task "queued – stopped before start". Add the report-only diff net as a **line on the task page** ("Scope check: found 1 surface the mandate does not name — reported, not stopped"), not as a case |
| G-5 | Rule strip, `decisions.html` and `states.html` empty state | "…actions that cost money or cannot be undone" | D-11: outside action = publish and release only; spend stays with the leader | Copy: "…breaking changes, and publishing or releasing." Show the rule strip in the empty state only (F-26) |
| G-6 | Card send row | No third answer | F-15: "not a decision" closes the case and continues the task | Add a ghost "Not a decision" action in the send row; a decided variant "Not a decision · by you · {time}" … and a second ghost "Leader decides" with its delegated and taken-back variants (F-31, added after this review). |
| G-7 | Card send row | Reversibility unstated (U-14) | F-29: the hint says whether the answer can be taken back | Hint variants: "You can take this back until the task acts on it." / "This cannot be taken back once the task acts." |
| G-8 | `task.html` "What the leader gets" | `human_decision open/record`, `expectedVersion` unnamed, `blocks[]` on the row | F-19, F-17, F-12, F-21: `execution_control open_decision / record_decision`, `task_read view: decisions`, the case token, refused moves derived and on the wire, `scope.reported` | Rewrite the four blocks with the new names, `operationId`, the case token, and a fifth block for `scope.reported` |
| G-9 | README § 10.1 | `decisions.json` index; case `version` counter; `blocks[]` stored | F-16, F-17, F-12 | Replace with `RunRecord.decision`, undotted `decision` events, the case token; delete `blocks[]` |
| G-10 | README § 10.5 | `XEZ:ASK` gains `owner` | F-5: new marker `XEZ:DECIDE` | Rewrite; note the old-engine behaviour |
| G-11 | README § 10.6 | `mandate` at creation | F-6: at dequeue, with `amendments` | Rewrite |
| G-12 | README § 7.3, § 8 | `actedOnAt` undefined; reopen "stops the task again" | F-18 | State the rule and the in-flight refusal; `states.html` e note |
| G-13 | README § 14 | Eight open decisions, several now decided | § 11 of the requirements: OD-1 to OD-8 | Replace the table with a pointer plus the eight |
| G-14 | README § 13 | Fifteen acceptance criteria written against `waiting` | § 9 of the requirements: A-1 to A-19 | Replace with a pointer; keep the design-only criteria (states, keyboard, themes) |
| G-15 | README § 2 | Evidence table | Superseded by the requirements § 1 and the interview record | Shorten to a pointer |
| G-16 | `decisions.html` header | "3 tasks are waiting for you" | U-16, F-26: count cases | "3 decisions are waiting for you" |
| G-17 | `decisions.html`, `task.html` tabs | `role="tablist"`; task tab shows tabs and a group | F-26 (`TabLink`), U-3 | `TabLink` on the Decisions page; one list with a "Decided · n" group on the task tab |
| G-18 | `task.html` | No scope-check state on the task page | F-9, U-18 | A step-rail-style line with the three values ran / unknown / skipped |
| G-19 | README § 6, § 10.7 | Per-project query for the multi-project count | F-27: workspace read, one root subscription | Rewrite the developer note |
| G-20 | README § 7.5, `task.html` | Nothing about the morning count for the leader | F-30 | One line in "What the leader gets" |
| G-21 | README § 4 | Non-goals list | § 3 of the requirements | Align: add "no cap", "categories fixed", "autonomous tasks are not exempt" |
| G-22 | `styles.css`, all pages | U-1 to U-20 | N-6 | Apply: `--muted-foreground` for meaning-bearing small text; `CenteredState` error; 44 px targets; banner classes from `review-panel.tsx`; card alpha over the page; `primary` Send or muted category chip; `role="group"`; `sr-only` mobile count; drop the stand-in classes for the shared ones; the size scale; curly quotes; the px-to-Tailwind mapping in § 10; the departures table |

Verdict on the draft after the interview: **the page and the card survive; the mechanism section, the sample cases and the leader section are rewritten.** Nothing in the draft contradicts a locked decision once G-1 to G-22 are applied.
