# Decisions – an owner-only decision gate: requirements

Status: **requirements draft, agreed with the owner on 2026-09-14; not yet implemented.** Audience: product owner and engineering team.
Inputs: the [grill-me interview record](decisions-grill-record-2026-09-14.md) (20 locked decisions, cited below as *D-n*), the [five-reviewer verdict](decisions-design-review-2026-09-14.md) on the first design draft (cited as *R-n*), the campaign finding in [leader-dogfooding-2026-09-13.md § 14.2](../mcp-server/leader-dogfooding-2026-09-13.md), and MCP requirement F-09 in [mcp-project-leader-requirements.md](../mcp-server/mcp-project-leader-requirements.md).
Design: `designs/decisions/` (the first draft predates this document and is being revised against it).

Baseline: xezar `0c4fbde` (main, 2026-09-14). Bare `#n` means `qodeca/xezar`.

## 1. Goal and value

Agents and the MCP leader make decisions all day. Most are theirs. Some are not: adding or removing something users see, changing what "done" means, a breaking change, publishing. Today nothing stops an agent or the leader from taking those, and nothing shows the owner that one was taken. In the 2026-09-13 campaign a cockpit control was invented inside a review loop and passed every gate; the owner learned of it the next morning by opening Settings (D-1).

The value is **the unattended night** (D-2): the owner leaves a leader and its agents working, sleeps, and in the morning finds a short list of decisions that only a human may take – each with a plain explanation and one-click answers – while everything that needed no such decision is already done. The task that asked waits without holding a slot; the moment the owner decides, it goes back to the queue and continues where it stopped (D-3, D-4).

Two things make it a gate rather than a page: a **task state the leader cannot move**, and a **written, timed, reopenable record** of every answer, including the answers the leader passes on for the owner (D-12, D-16).

## 2. Agreement status and actors

- **Agreed** (D-1 to D-20): the goal, the new task state and slot release, the resume semantics, the mandate, the two nets, the categories, the report-first rollout of the model check, the relay model, the delegation answer ("leader decides", D-20), the metrics.
- **Technical proposal**: a mechanism that satisfies an agreed requirement and still needs a design decision – marked *proposal* below.
- **Open**: a product or technical decision not yet made – § 11.

| Actor | Responsibility |
| --- | --- |
| Owner | Whoever can open the cockpit (D-8). Answers cases, reopens them, sets nothing up. |
| MCP leader | Runs tasks, carries a case's question to the owner and records the owner's answer with the owner's words; may open a case of its own; cannot move a stopped task. |
| Task agent | Does the work; opens a case with `XEZ:DECIDE` when the work needs a decision in one of the categories. |
| xezar | Opens cases from its own two checks, stops and re-queues the task, refuses the leader, keeps the record, resumes the agent. |

## 3. Scope and exclusions

In scope: every project xezar runs, with zero configuration; all four backends; the cockpit, the CLI and the MCP.

Out of scope for this version (each is a deliberate non-goal, not a gap):

- Proving that the leader's relayed words are really the owner's. xezar cannot; it shows them and makes reopening one click (D-16). MCP elicitation is a later step.
- Stopping a hostile agent. Agents have a shell and the owner's GitHub login. This gate stops drift by accident, which is what happened.
- Multi-person teams and per-person identity (D-8).
- Per-project categories (OD-8).
- Replacing the review gate, `XEZ:ASK`, the Inbox or the kit's labels. Each keeps its job (D-12).
- A cap on the number of open cases (D-14).

## 4. Definitions

| Term | Meaning |
| --- | --- |
| **Case** | One decision that only a human may take, bound to one task. It has a category, a question with 2–4 options, a plain-words text, a technical text with evidence, a raiser, and – once answered – a decision. |
| **Category** | One of four, fixed in this version: `scope` (adds or removes something users see or use, or changes a default), `done-means` (changes the definition of done for an issue, epic or campaign, including QA and review adjudications – D-10), `breaking-change` (users must change something on their side to keep working), `outside-action` (publish or release only: npm, a GitHub Release, a tag, a deploy – D-11). |
| **Mandate** | What was asked: the task's brief plus the linked issue, no matter who wrote them (D-6). Without a linked issue, the brief alone (D-15). Frozen at dequeue from the folded text the agent actually received (R-9). |
| **Stopped** | The new task state: the task waits for a decision, holds no slot, has no open agent session, survives restarts, and no leader tool can move it (D-3, D-12, D-19). |
| **Raiser** | Who opened the case: a task agent, the leader, or one of xezar's two checks. |
| **The brief net** | xezar's check when the leader creates or edits a task: does the brief add a user-facing surface the linked issue does not name (D-7). |
| **The diff net** | xezar's check when a task's writing is done: does the diff add a user-facing surface the mandate does not name (D-7). Report-only in version 1 (D-9). |
| **Owner words** | The verbatim text the leader records as the owner's answer when it relays a decision (D-16). |

## 5. Functional requirements

### The case

| ID | Requirement |
| --- | --- |
| F-1 | A case MUST belong to exactly one task and MUST carry: `category`, one `question` in the `AskQuestion` shape (`packages/xezar/src/core/ask.ts`) with `multiSelect` forbidden and 2–4 options, `plain`, `why`, optional `evidence`, `raisedBy`, `createdAt`, and an optional `recommended` naming an option **label** (R-21). Exactly one question per case. |
| F-2 | A case MUST be in one of the four categories of § 4. A raise without a category, or with an unknown one, is refused with the reason. Categories are fixed in this version (OD-8). |
| F-3 | Every case MUST carry two descriptions: `plain` – three to five short sentences for a person who did not read the thread (what was being done, what happened, why it matters, what they decide; no file or tool names) – always visible; and `why` plus `evidence` – the technical reason and the material (diff stat, issue quote, history, the agent's reasons) – collapsed by default. `plain` is REQUIRED: when the raiser did not provide it, xezar writes one from `question`, `why` and the options and marks the case `plainBy: 'xezar'`; when no model is available the case still opens with `question` and `why` shown and a visible "summary unavailable" line. A case is never shown with only the technical text. |
| F-4 | A case MAY be opened by three raisers and by nothing else: a task agent (F-5), the leader (F-19), and xezar's own two checks (F-7, F-8). Automations, autonomous-mode nudges, monitoring wakes and plain messages open nothing. |

### Opening a case

| ID | Requirement |
| --- | --- |
| F-5 | A task agent opens a case by ending its turn with a **new control marker** `XEZ:DECIDE <compact-json>`, a sibling of `XEZ:DONE`, `XEZ:MONITORING` and `XEZ:ASK`, carrying `{category, question, plain, why, recommended?, evidence?}`. `XEZ:ASK` is NOT extended: an old engine that does not know `XEZ:DECIDE` sees prose, builds no card and, in a non-final step, fails the step closed (R-5). The marker ships with the first release (D-17). Codex agents raise a case only through the marker (the native `requestUserInput` bridge has no category). |
| F-6 | xezar MUST record the mandate on the run once, at dequeue, from the same folded text the agent received: `mandate: {text, refs, source: {kind: issue \| inbox \| human-brief \| leader-brief, issueNumber?, url?, capturedAt, digest?}, createdBy: ui \| mcp \| automation \| cli}` (the audit door enum). Later `edit_brief` calls and steering messages are appended as `amendments[{at, origin: human \| leader, text}]`; the mandate text itself is never rewritten. The linked issue body is captured when `gh` can read it; when it cannot, `source.kind` says so and the brief alone is the mandate (D-15). |
| F-7 | **The brief net.** When the leader creates a task or edits a queued brief (`task_create`, `organise_work edit_brief`, `PATCH /runs/:id` from the MCP door), and the task links an issue, xezar MUST compare the brief with the issue body and open a `scope` case **before the task leaves the queue** when the brief adds a user-facing surface (a screen, a control, a route, a setting, a CLI flag, an environment variable, a public command, a changed default) that the issue does not name. The case's evidence is the brief and the issue quote. This is the net that catches the motivating case (R-1). A task created from the cockpit is its own mandate and is not checked here. Without a linked issue the check does not run (D-15, accepted hole). |
| F-8 | **The diff net.** When a task's last writing step ends – *proposal*: at `settleSuccess`, before the status is written (R-17) – xezar MUST compare the task's own diff (via `resolveTaskDiffBase`, never the owner's working tree – R-19) with the mandate and list user-facing surfaces the mandate does not name. In version 1 a non-empty list is a **report**: a `scopeCheck` record on the run (F-9), a line on the task page, and a `scope.reported` row in the leader's journal – the task is not stopped (D-9). Blocking is switched on only after the false-alarm rate is measured on the 23 campaign PRs and a threshold is agreed (OD-7). When it blocks, it opens a `scope` case and stops the task. |
| F-9 | The scope checks MUST fail loudly, never silently. Their result is a three-valued record field, never a boolean: `scopeCheck: {status: ran \| unknown \| skipped, at, reason?, surfaces?: string[]}`. `ran` with an empty list is a pass; `unknown` means the model did not answer, the mandate was absent, or the diff could not be read; `skipped` names why (no worktree, no writing step, dry run). An absent mandate yields `unknown`, never "nothing to flag". `task_read view: task`, `handoff_git merge_state` and the review banner read it. *Proposal*: the model call copies the namer (`runs/auto-name.ts`): the project's default runner, one turn, no tools, bounded timeout, two attempts; under `XEZ_DRY_RUN=1` the bundled mock answers a `[xez-scope]` prompt. Runner, model and cost attribution are OD-5. |

### The stopped state

| ID | Requirement |
| --- | --- |
| F-10 | A new run status, *proposal* `decision`, MUST exist. A task enters it when a case opens on it. In it the task holds **no slot** (the semaphore releases it), has **no open agent session** (the session is ended the way `finish` ends one), arms **no timer** (no idle timeout, no monitoring wake, no auto-resume), and is **not in the queue**. It applies to autonomous tasks too: `autonomous: true` means "never pause for the user" for questions, not for cases (R-7); the `task_create` description says so. |
| F-11 | The state MUST survive a restart: `recover()` leaves a task in `decision` exactly as it was; no `continue-N` step is synthesised; the case is still open and still counted (D-19). |
| F-12 | While a task is in `decision`, the engine MUST refuse – with reason `decision.pending`, the case id and the question – every move that would carry it on: `finish`, `continue`, a message, `POST /runs/:id/pr`, the autonomous nudge, the monitoring wake, auto-resume. The refusal is enforced at the engine choke points (`continueRun`, `finish`, `sendMessage`), so every caller – cockpit, MCP tools, timers – hits one implementation. The set of blocked moves is derived from the state, never stored on the case (R-12). |
| F-13 | A PR that a stopped task carries (`prNumber` / `pullRequestUrl`) MUST be refused for `handoff_git ready` and `handoff_git merge` and the corresponding routes, whichever run asks – the integration run included (R-2). The kit's `integration-preflight.sh` reads the same fact. |

### Answering

| ID | Requirement |
| --- | --- |
| F-14 | An answer is one of: an option label, a free-text comment, or both. Send is impossible with neither. The answer records `choice?`, `comment?`, `decidedAt`, `channel: ui \| mcp` (server-derived, R-13), and for a relayed answer `ownerWords` (F-20). |
| F-15 | The owner MAY also answer **"not a decision"**: the case closes as `not-a-decision`, the task continues as if the case had not opened, and the outcome is kept in the history so false alarms can be counted (R-22, D-14). Only the cockpit may give this answer. |
| F-31 | The owner MAY also answer **"leader decides"** (D-20, added 2026-09-14 after the interview): the case enters `delegated`, with the owner's optional comment as guidance. The task stays in `decision` – someone still has to answer, so the slot stays free and every refusal of F-12 holds. The leader receives `decision.delegated` (F-21) and MAY then answer that one case with `record_decision` carrying a required `reason` (bounded like `ownerWords`) instead of `ownerWords`; the answer records `by: 'leader'`, `delegatedAt` and `delegatedComment?`. Only the cockpit may delegate; a leader call to delegate is refused. The owner MAY **take it back** at any time before the leader answers, returning the case to `open`. A delegated case leaves the owner's badge and the attention bucket "needs you" (the run's pill reads "with the leader") and is included in the leader's morning count (F-30). When no MCP session is connected, the cockpit shows the action disabled with the reason "No leader is connected". A delegated answer is reopenable under F-18 like any other. Delegations are counted with the false alarms (§ 10) so the owner can see how often the gate is handed over. |
| F-16 | The case MUST live **on the run record** (`RunRecord.decision?`, optional, `.catch`) so every live surface – the badge, the multi-project counts, the notification, the attention dot – reads it from the run snapshots the workspace SSE already carries (R-10). The full history lives as events on the run's NDJSON (`decision` with an `action` of `requested`, `recorded`, `reopened`, `voided`, `not-a-decision`, `delegated`, `taken-back`), undotted so they stay out of the v2 `UiEvent` union. The run index row gets a slim `decisionPending?: true`. `raisedBy` is a role (`task-agent \| leader \| scope-check \| brief-check`), not an origin word; the journal row's origin stays `human \| leader \| system` and is server-derived (R-13). A delegated case flips the slim index flag from `decisionPending?: true` to `decisionDelegated?: true`, so the badge and the attention bucket drop it while the task page keeps its stopped banner (F-31). |
| F-17 | Answering and reopening MUST be guarded by the **case's own version token** (`rev1:decision:<caseId>:<seq>:<digest>`, minted by the existing helper), never the run's, which moves with every event. A stale or absent token returns 409 with the current decision so the cockpit can show who answered first (R-14). |
| F-18 | `actedOnAt` MUST be set by the engine at the first outward effect after the decision – the next agent turn started on the run, or a push, PR create, ready or merge on its branch – and never by a tool argument. Until it is set the owner MAY reopen; reopening returns the case to open, stops the task again and tells the agent at its next turn boundary; reopen is refused with the reason while a turn is in flight (R-15, R-16). After `actedOnAt` reopen is refused. Whether the leader may reopen is OD-4. |

### The leader (MCP)

| ID | Requirement |
| --- | --- |
| F-19 | No fifth MCP tool. Cases are read through `task_read view: 'decisions'` (paged, sealed cursor) and changed through two `execution_control` actions, `open_decision` and `record_decision`, which inherit `operationId` (required on both; a retried `open_decision` returns the first receipt and opens nothing twice), the stale-version discipline (the case token, F-17) and the refusal vocabulary (R-11). `open_decision` takes `{runId, category, question, plain, why, recommended?, evidence?}`; a call without `plain` is refused. |
| F-20 | `record_decision` MUST require `ownerWords` (non-empty, bounded at 1 000 characters) and stores `channel: 'mcp'`; on a `delegated` case (F-31) it requires `reason` instead and refuses `ownerWords`, so a relayed answer and a leader's own answer can never be confused in the record. The words land on the run's NDJSON and in the case; never in `mcp-audit.ndjson`, which carries digests only. Whether the agent receives the words verbatim or only the option label is OD-6. A leader that opens and records the same case is allowed (non-goal) but the record shows both operation ids and the seconds between them. |
| F-21 | A `decision` journal kind MUST be delivered to the leader like `question.asked`: `decision.requested` with the question, the plain text, the options and the derived list of refused moves; `decision.recorded`, `decision.reopened`, `decision.voided`, `decision.not-a-decision`, `decision.delegated` (with the owner's guidance; the leader may now answer with a `reason`), `decision.taken-back`, and `scope.reported` for the report-only net. The refusal message of every blocked tool names the case and says: take the question to the owner, record the answer with `record_decision` – or, on a delegated case, decide and record with a reason. |
| F-22 | The leader's base role instruction (`mcp/leader-delivery.ts`) MUST gain one line: never put new user-facing scope into a brief and never change what "done" means – open a case. The kit's reviewer skills MUST say that a finding which asks for new scope is a case for the owner, not a defect for the author (this is how the motivating case started). |

### Resuming

| ID | Requirement |
| --- | --- |
| F-23 | On a decision, the task MUST return to the queue and, when it gets a slot, **resume the agent with the context it had before it asked** (D-4): the backend's session resume (Claude Code `--resume`, the Codex app-server thread) inside the **same workflow step**, with the decision delivered as the next user message (`origin: human`, or `leader` with the owner words). The workflow chain continues after that step as if the turn had never stopped; gates and handoff run. The step timeout restarts at resume. |
| F-24 | When the context cannot be resumed – pi, an expired or missing session, a model no longer available, a reclaimed worktree – the **same step re-runs with a fresh agent** given the original prompt, the handoff notes and the decision (D-5). The run records which path was taken (`resumedWith: session \| fresh`), so the resume success rate can be measured (D-18). |
| F-25 | Headless `xezar run` – *proposal*: a case opened in a headless run prints the case (plain text, options) and exits with a distinct non-zero code, the way a failed run does; `review` keeps meaning success. The choice is OD-3 and is a protected CLI surface. |

### The cockpit

| ID | Requirement |
| --- | --- |
| F-26 | A **Decisions** menu item, second after Tasks, always on, with a violet count of open cases in the project that wait on the owner – `delegated` cases are excluded (F-31) – (hidden at 0 and while unknown, `99+` cap, `sr-only` words). A page of case cards with URL-backed Open / Decided segments (`TabLink`), oldest open first, decided newest first; empty, loading and error states per the design system; no filters in this version. The rule strip appears in the empty state only. |
| F-27 | With several projects, each collapsed project header shows its own open-case count. The count comes from a workspace-level read (the `runs-index` precedent) subscribed **once at the root**, never per reader (R-26). |
| F-28 | The task page: the status pill and dot follow `lib/attention.ts`, where the `decision` state gets its own row (tone pending, pulse, label "needs your decision"); a banner above the thread says the task is stopped and links to Decisions; the same card renders in the thread after the turn that raised it; the composer is disabled while a case is open, with the reason as its placeholder; a **Decisions tab** beside Session, Changes and Files lists every case of the task, open first, then decided. |
| F-29 | The card: header line (dot + "needs you", category word, raiser, age, blocked task link, and the task's GitHub issue and PR links from its refs – each hidden when absent, opening in a new tab, added 2026-09-14 at the owner's request for the widest context), the question, the plain-words text always visible, "Technical details" collapsed (why line + evidence), 2–4 stacked option buttons in a labelled `role="group"` with `aria-pressed`, the word "Recommended by the {raiser}" in muted text and never a colour, a comment box, a send row whose hint names what will be sent and whether it can be taken back, the ghost actions "Not a decision" and "Leader decides" (disabled with the reason when no leader is connected), and Send disabled until there is something to send. A decided card collapses to one line with who answered and, for a relayed answer, the quoted owner words and Reopen; a leader-decided delegated case shows the leader's reason and "delegated by you at {time}". A delegated card collapses to "With the leader · since {time}", the owner's guidance, and "Take it back". A voided card says "No longer needed" and why. The design-system findings U-1 to U-20 in the review record apply. |
| F-30 | The morning: the browser notification body for the new state is "Task needs your decision"; the leader's first `leader_events` page after a reconnect carries the count of open cases (D-19). |

## 6. State machine

States of a case: `open`, `delegated` (F-31), `decided`, `acted` (decided with `actedOnAt`), `not-a-decision`, `void`. "Reopened" is `open` with history.

| From | Event | Who fires it | To | Rule |
| --- | --- | --- | --- | --- |
| – | `XEZ:DECIDE` at a turn end, any step | turn-end parser | open | the run enters `decision`; slot released; session ended; chain suspended at this step |
| – | `open_decision` | leader (MCP) | open | refused when the run is terminal |
| – | brief net finds an unnamed surface | engine, at leader create/edit of a queued task | open | the run stays queued-but-stopped; it never dequeues while open |
| – | diff net finds an unnamed surface, blocking mode | engine, before the status write | open | the run enters `decision` instead of `review`/`done` |
| – | diff net finds an unnamed surface, report mode | engine | – | `scopeCheck` recorded; `scope.reported` to the leader; nothing stops |
| – | a raise while a case is already open on the run | any | open (unchanged) | OD-1 |
| open | decide in the cockpit (case token) | owner | decided | run re-queued; resume per F-23/F-24 |
| open | `record_decision` (owner words, operationId, case token) | leader | decided | same |
| open | "not a decision" | owner, cockpit only | not-a-decision | run re-queued as if no case; counted |
| open | "leader decides" (case token) | owner, cockpit only | delegated | run stays in `decision`; leaves the owner's badge; `decision.delegated` to the leader; counted |
| delegated | `record_decision` (reason, operationId, case token) | leader | decided | run re-queued; resume per F-23/F-24; `by: 'leader'` |
| delegated | `record_decision` with `ownerWords` | leader | delegated | refused: a delegated case takes a reason, not relayed words |
| delegated | "take it back" | owner, cockpit only | open | back on the owner's badge; `decision.taken-back` to the leader |
| delegated | decide in the cockpit | owner | decided | allowed – the owner may still answer directly; the leader is told |
| delegated | cancel or delete the run | owner or leader | void | |
| delegated | restart, timers | engine | delegated | the run stays in `decision`; nothing fires |
| open | decide with a stale or absent token | either | open | 409 with the current decision |
| open | cancel or delete the run | owner or leader | void | badge drops |
| open | the run failed for another reason | engine | open, task ended | OD-2 |
| open | restart | `recover()` | open | the run stays in `decision`; nothing synthesised |
| open | idle timer, nudge, monitoring wake, auto-resume | engine | open | none of them fire in `decision` |
| decided | first outward effect | engine | acted | `actedOnAt`; Reopen disappears |
| decided | reopen | owner (leader: OD-4) | open | refused while a turn is in flight; withdrawal delivered at the next boundary |
| decided | reopen after `actedOnAt` | any | decided | 409 |
| decided / acted | cancel or delete the run | owner or leader | void | |
| acted / void / not-a-decision | anything | – | unchanged | terminal |

Invariant, tested: **no state's only on-by-default exit is "a human types something"** except `open`, whose exits are decide, record, not-a-decision, leader-decides and void – and `open` is the one state that is allowed to wait for a human, because waiting for a human is its purpose. `delegated` waits for the leader, an agent; its owner-side exits (take it back, decide directly) keep it from becoming a dead end when the leader never comes.

## 7. Nonfunctional requirements

| ID | Requirement |
| --- | --- |
| N-1 | Zero configuration: no key to set, no file to create. The gate is on in every project. `XEZ_*` flags may only narrow it (none are proposed). |
| N-2 | Degrade, never fail: no `gh`, no remote, offline, no model, a read-only home – the case still opens (F-3 fallback), the brief net is skipped with its reason recorded, the diff net yields `unknown`. |
| N-3 | Old files, old versions: every new field optional with `.catch`; an older xezar reading a run in `decision` must not crash (it may show it as unknown status); the `decision` event type is undotted so it never enters the v2 protocol union. |
| N-4 | Cost: the brief net is one model turn per leader task creation or edit; the diff net one per writing task. Both are bounded (timeout, two attempts) and attributed – to whom is OD-5. |
| N-5 | Liveness: a case shows in the cockpit within one SSE frame of opening; the badge never shows a guessed number. |
| N-6 | Accessibility and responsive behaviour per the design system's ten rules and `new-designs.md`; the UX findings U-1 to U-20 are closed before the cockpit part merges. |

## 8. Reference scenarios

**S-01 – The motivating case, replayed.** The leader starts round 4 on #403 with a brief that says "add the shared attach control". The brief net compares it with #374, which asks for a wake path per client and names no control, and opens a `scope` case before the task runs. The task never dequeues. In the morning the owner reads: "Agents built a way for xezar to wake up the leader… While reviewing that work, they also added a button in Settings… You decide whether the button stays." The owner picks "Move it to a new issue" and writes one line. The task dequeues with the decision, the agent removes the control, gates and handoff run, PR #403 goes to review without the control. The button gets its own issue and its own design review.

**S-02 – The unattended night.** Ten leader tasks run from 22:00. Three raise cases (one `XEZ:DECIDE` from an agent, one `open_decision` from the leader before a release, one brief-net case on a new task). Each stopped task releases its slot; the other seven finish. The cockpit dies at 03:00 and is restarted; the three cases are still there. At 08:00 the Decisions badge says 3; the leader's first events page says 3. The owner answers all three in six minutes. Two resume by session; one (pi) re-runs its step fresh. All three finish before 09:00.

**S-03 – The relay.** The owner tells the leader in chat: "go ahead with the release". The leader calls `record_decision` with those words. The card shows "Decided — Publish · passed on by the leader · 09:05" and the quote. The owner reads it at 09:06, sees it matches, and does nothing. Later the owner sees a relayed answer that does not match what they said, clicks Reopen before the task acted, and answers in the cockpit; the agent is told at its next turn boundary.

**S-04 – The false alarm.** An agent raises a `scope` case for a renamed label. The owner clicks "not a decision". The task continues; the outcome is counted; after a month the counts show which raiser cries wolf and the skill text is tuned (D-14).

## 9. Acceptance criteria

| ID | Criterion |
| --- | --- |
| A-1 | A fresh project with no config shows the Decisions item; the page renders the empty state; nothing was written to configure it. |
| A-2 | `XEZ:DECIDE` at the end of a **non-final** step opens a case, moves the run to `decision`, releases its slot (a queued task starts), ends the session, and does not fail the step. |
| A-3 | `open_decision` on a running task takes effect at the run's next turn end; the run enters `decision`. |
| A-4 | The brief net: a leader-created task whose brief adds a route the linked issue does not name opens a `scope` case before the task dequeues; the same brief on a task created from the cockpit opens none; the same brief with no linked issue opens none and records `skipped: no-issue`. |
| A-5 | The diff net in report mode: a diff that adds a cockpit route the mandate does not name records `scopeCheck.ran` with one surface and emits `scope.reported`; a docs-only diff records an empty list; a model failure records `unknown` and the run is not blocked; the task page shows all three. |
| A-6 | While a run is in `decision`: `finish`, `continue`, a message, `POST /runs/:id/pr`, the idle timer, the autonomous nudge, the monitoring wake and auto-resume all do nothing and (for the routes) answer 409 `decision.pending`; `handoff_git ready` and `merge` refuse the run's PR from any run. |
| A-7 | Restart: a run in `decision` is unchanged after `recover()`; no `continue-N` step exists; the badge count is the same. |
| A-8 | Deciding in the cockpit re-queues the run; on a Claude Code or Codex run the agent resumes its prior session inside the same step and the chain continues through gates and handoff; on a pi run the same step re-runs fresh with the decision in its prompt; `resumedWith` says which. |
| A-9 | `record_decision` without `ownerWords`, without `operationId`, or with a stale case token is refused; with all three it decides the case, shows "passed on by the leader" and the quote, and a retried call with the same `operationId` returns the first receipt. |
| A-10 | Reopen before `actedOnAt` returns the case to open and the run to `decision`; reopen during a turn is refused with the reason; reopen after `actedOnAt` is refused. |
| A-11 | Two answers race: the second returns 409 with the first decision; the cockpit shows who answered and keeps the typed comment. |
| A-12 | Cancelling or deleting the run voids its case; the badge drops; "not a decision" continues the run and is counted. |
| A-13 | The badge shows nothing at 0, while loading and on error; `99+` above 99; a collapsed project header shows its own count from one root subscription. |
| A-14 | Every case shows the plain-words text by default and the technical text collapsed; a case cannot be created without `plain`; the engine-written summary is marked; with no model the case still opens with "summary unavailable". |
| A-15 | The task's Decisions tab lists every case of that task, open first, then decided; its open count equals the Decisions page's count for that task. |
| A-16 | Keyboard-only: a case can be read, an option pressed, a comment typed and sent, focus lands on the decided line, and a decided case reopened; both themes and 375 px pass the design-system checklist. |
| A-17 | The campaign replay: over the 23 merged campaign PRs with their issues as mandates, the brief net or the diff net flags #403 round 4 and #404; the false-alarm count on the other PRs is reported in the implementing PR (OD-7 sets the threshold). |
| A-18 | `xezar run` with a case behaves per OD-3 and never hangs. |
| A-19 | "Leader decides" moves the case to `delegated`, the run stays in `decision` with its slot free, the badge drops, `decision.delegated` reaches the leader; `record_decision` with a `reason` then decides it and re-queues the run, with `ownerWords` refused on that case; "take it back" returns it to `open` and to the badge; a leader call to delegate is refused; with no MCP session the action is disabled with the reason. |

## 10. Success metrics (D-18)

After one month of use, measured from the run records:

| Metric | Target |
| --- | --- |
| Leader tasks run overnight without the owner | yes, at least one night a week |
| The morning list holds cases, not repair work | 0 failed resumes needing manual repair |
| Resume success (`resumedWith` session or fresh, run finished) | above 95 % |
| Time from opening a case card to Send | under 2 minutes on average |
| The campaign replay | flags the Attach leader control |
| Cases handed to the leader ("leader decides") | counted and reported beside the false alarms; no target in month one – the number tells the owner whether the gate is wearing away |

## 11. Open decisions

| ID | Question | Options | Recommendation | Owner |
| --- | --- | --- | --- | --- |
| OD-1 | One open case per run, or several at once? | one / many | One – a second raise while one is open is refused with the reason; the composer rule, the badge and the tab count then all read the same | pending |
| OD-2 | A case whose task failed for another reason or already finished: void, or answerable into a follow-up task? | void / follow-up | Answerable into an Inbox follow-up carrying the case, the mandate and the words – a case nothing can act on must not sit on the badge | pending |
| OD-3 | Headless `xezar run` with a case | print and exit non-zero / refuse to open cases headlessly / exit 0 like review | Print the case and exit non-zero, distinct code; document in BC § 1 | pending |
| OD-4 | May the leader reopen a case ("I relayed that wrong")? | owner only / leader too | Leader too, recorded as such – it is the party most likely to notice | pending |
| OD-5 | The scope checks' runner, model, timeout and cost attribution | namer precedent (default runner, `namerModel` on Claude only) / always Claude haiku / project setting | Namer precedent, with a 60 s timeout; count the cost on the task; no new setting | pending |
| OD-6 | Does the agent receive `ownerWords` verbatim, or only the chosen option label plus the owner's comment? | verbatim / label only | Verbatim, marked "relayed by the leader" in the message, so the agent knows the provenance | pending |
| OD-7 | The ship threshold for switching the diff net from report to block | 0 false cases on the 21 non-drift PRs and both true positives / a rate | 0 false, 2 true, before it blocks anywhere; otherwise it blocks only leader-created and autonomous tasks | pending |
| OD-8 | Per-project categories | never / `.xezar/config.json` later | Later, as its own issue, after a month of counts | pending |

## 12. Backward compatibility and gate obligations

- `BACKWARD_COMPATIBILITY.md` § 1: the new run status and (OD-3) the headless exit code; § 2: every new route inventoried (`bc-route-inventory.test.ts` reads the built app); § 3: `RunRecord.decision`, `mandate`, `scopeCheck`, `resumedWith` as optional fields; § 7: the additive status enum; § 8: `XEZ:DECIDE` in the marker vocabulary.
- `packages/contract`: every new shape a zod schema with its type inferred; the `decision` status widens the enum additively; `contract-parity*` and `typed-bodies` cover the new routes; the closed journal-kind table gains `decision.*` and `scope.reported` with one scenario each in `event-catalog.test.ts`.
- MCP: `mcp-api-doc.test.ts -u` regenerates the reference; `api-coverage.testkit.ts` gets rows for `open_decision`, `record_decision` and `task_read view: decisions`; the tools registry is appended, never reordered.
- `.env.example` unchanged unless a `XEZ_*` flag is added (none proposed).
- `ensureDataGitignore` learns nothing new (the case lives on the run record).
- Design system: `components.md`, `coverage.md`, `cockpit.css`, `writing.md` and `lib/attention.ts` change in the same commit as the cockpit part; the PR carries `needs-design`.
- `AGENTS.md`: the runs-store row (new fields), the workflows row (the `decision` state and the suspended step), the MCP row (the two actions), the real-time row (the root subscription for counts).

## 13. Delivery plan

Each step is its own PR; the contract steps land first (D-17 says the three hard-to-undo parts ship in the same release, not in the same PR).

1. **Contract and record** – `decision` status, `RunRecord.decision` (including `delegatedAt`, `delegatedComment`, `by`), `mandate` at dequeue, `scopeCheck`, `resumedWith`, the events, the index flag, BC entries. No behaviour yet.
2. **The stopped state** – slot release, session end, no timers, `recover()`, the engine choke-point refusals, the cross-run PR refusal, the `attention.ts` row. This is the heart; A-2, A-6, A-7.
3. **Answering and resuming** – decide / not-a-decision / reopen routes with the case token; session resume inside the step; the fresh-agent fallback; `actedOnAt`. A-8 to A-12.
4. **The leader** – `open_decision`, `record_decision`, `task_read view: decisions`, the journal kinds, the refusal messages, the role-instruction line. A-3, A-9, A-19 (the leader half).
5. **The agent** – `XEZ:DECIDE` parsing in every backend's turn-end path, the non-final-step suspension, `plain` fallback, the mock. A-2, A-14.
6. **The brief net** – at leader create/edit; the issue read; A-4.
7. **The diff net, report mode** – the model call, `scopeCheck`, `scope.reported`, the campaign replay with its numbers. A-5, A-17.
8. **The cockpit** – nav item, page, card, task banner, composer rule, Decisions tab, badges and root subscription, notification; the design-system docs; `needs-design`. A-1, A-13 to A-16, A-19 (the cockpit half).
9. **Kit and skills text** – reviewer skills, integration preflight reading the PR refusal, the dogfooding note.
10. **Block mode for the diff net** – after OD-7 is met.
