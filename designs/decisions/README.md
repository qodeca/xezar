# Decisions – design handoff

| | |
|---|---|
| **Status** | Draft, revision 2 (2026-09-14) – the five-reviewer verdict and the owner interview applied; waiting for the first `design-review` verdict (see [§18](#18-design-review)); the open decisions are OD-1..OD-8 in the requirements, none of which changes the mockup |
| **Date** | 2026-09-14 |
| **Mockup** | Open [`index.html`](index.html) in a browser. No build or server needed. |
| **Replaces** | Nothing. Today no surface exists for this. |
| **Requirements** | [`docs/features/decisions/decisions-requirements.md`](../../docs/features/decisions/decisions-requirements.md) – F-1..F-31, the state machine, A-1..A-19, OD-1..OD-8. This README is the UI handoff; the requirements document is the contract. Where they disagree, the requirements win. |
| **Comes from** | `docs/features/mcp-server/leader-dogfooding-2026-09-13.md` § 14.2 (the "Attach leader" finding); the interview record [`decisions-grill-record-2026-09-14.md`](../../docs/features/decisions/decisions-grill-record-2026-09-14.md); the review record [`decisions-design-review-2026-09-14.md`](../../docs/features/decisions/decisions-design-review-2026-09-14.md) |

## 1. Summary

Some choices belong to the owner of a project, not to an agent and not to the leader that runs the agents: adding or removing something users see, changing what "done" means, a breaking change, or publishing and releasing.

This design:

1. Adds a **Decisions** menu item, always on, with a live count of open cases.
2. Adds a **Decisions** page: one card per case, modelled on the thread's ask card (which already mirrors Claude Code's `AskUserQuestion`).
3. Lets three parties open a case: a task agent (`XEZ:DECIDE`), the leader (`execution_control open_decision`), and xezar's own **brief check** when the leader creates or edits a task.
4. **Stops the task** in a new run state, `decision`: no slot, no session, no timer. The engine refuses every move that would carry the task past the case.
5. Records who answered – the owner in the cockpit, the leader quoting the owner, or the leader on its own after the owner handed the case over ("Leader decides", with a required reason) – and makes every answer visible and reversible until the task acts on it.
6. Sends the task back to the queue on the answer and resumes the agent with the context it had; a fresh agent re-runs the step when the session cannot be resumed.
7. Keeps the Inbox as it is: ideas that stop nothing stay in the Inbox; decisions that stop work live here.

It lives in the engine, not in this repository's `.xezar/` kit, because the kit reaches only this repository and every other user's project gets the engine alone.

## 2. Problem evidence

The evidence is in the requirements document § 1 and in the interview record. In one line: in the 2026-09-13 campaign a cockpit control was designed, built, reviewed three times, QA'd twice and design-approved – and no issue had asked for it. Every gate checked that it works and looks right. Nobody checked that the owner wanted it. The leader's brief for that task named the control; the issue did not. That is the case the brief check catches.

## 3. Users and jobs

| User | Job | What they need from this design |
|---|---|---|
| **Owner of the project** | "Is anything waiting on me, and what exactly am I deciding?" | One place with a true count; each card says the question in plain words, why it is theirs, and what each answer does |
| **Owner, in the morning** | "What stopped overnight, and did I really say that?" | Every decision kept with the words used and who delivered them; a relayed decision can be reopened until the task acts |
| **MCP leader (agent)** | "Can I move this task on?" | A machine-readable "no, a human decides" with the question to carry to the owner, and one way to record the answer |
| **Task agent** | "I am about to change what was asked – may I?" | A marker that goes to the owner, not to the leader |

## 4. Goals and non-goals

**Goals**

- A case is opened by an agent, by the leader, or by xezar itself; no case is opened by nobody.
- While a case is open, its task holds no slot and the engine refuses continue, finish, a message, a PR, ready and merge for it – from every caller.
- Only a human answer closes a case: typed in the cockpit, or recorded by the leader as the owner's quoted words; or the owner's "not a decision".
- The owner sees at a glance: how many cases are open, which task each stops, and why the leader could not decide it.
- Works in every project xezar runs, with zero configuration; autonomous tasks are not exempt.

**Non-goals** (requirements § 3)

- Proving the leader's relayed words are really the owner's. xezar shows them and makes reopening one click. MCP elicitation is later (§ 3 of the requirements, D-16).
- Stopping a hostile agent. This gate stops drift by accident, which is what happened.
- Replacing the Inbox, the review gate or the kit's labels.
- A cap on open cases, or per-project categories. The four categories are fixed in version 1.
- Blocking on the diff check. It is report-only in version 1 (`scopeCheck` with `ran | unknown | skipped`).

## 5. Files

| File | What it is |
|---|---|
| [`index.html`](index.html) | This overview: pages, decisions, phone preview, accessibility list |
| [`decisions.html`](decisions.html) | The menu item and the page in the app shell, three open cases |
| [`states.html`](states.html) | Badge, card and page states |
| [`task.html`](task.html) | The task page with the banner, the card, the scope-check line and the disabled composer; the task's Decisions tab; the leader's view |
| [`styles.css`](styles.css) | Feature rules only, on top of `../../docs/design-system/cockpit.css` |
| [`theme.js`](theme.js) | The mockup's light/dark switch |

## 6. Information architecture

- **Menu:** `Tasks · Decisions · Inbox · Git · GitHub · Automations · Skills · Workflows · Settings`. Decisions is second because it holds the things that stop work. No gate, no setting.
- **Route:** `/p/:projectId/decisions`, one page, two URL-backed segments (`TabLink`): `?tab=open` (default) and `?tab=decided`.
- **Order:** oldest open case first – it has waited longest. Decided: newest first, 20 per page with "Show older".
- **No filters** in this version.
- **A case belongs to one task** and lives on its run record. The same card renders on the Decisions page, in the task thread and on the task's Decisions tab; deciding in any place decides in all.
- **Task route:** `/p/:projectId/tasks/:id/decisions`, beside the existing `…/changes` and `…/files` segments.
- **Multi-project sidebar:** the active project's Decisions item shows its count; a collapsed project header shows its own count. All counts come from one workspace-level read subscribed once at the root (the `runs-index` precedent), never a per-reader query.

## 7. Screens

### 7.1 Menu item and badge

- `NavItems` row: label "Decisions", icon lucide `hand`, path `/decisions`, badge `decisions-open`, no availability gate.
- Badge: the existing violet count; hidden at 0 and while unknown; `99+` cap; `sr-only` ", N decisions waiting".
- Phone: the item is in the drawer; the mobile top bar shows the count with the same `sr-only` words.

### 7.2 Decisions page

- Page header: "Decisions" / "{n} decisions are waiting for you" (or "Nothing is waiting for you"). The header, the badge and the segment count all count cases.
- `TabLink` segments "Open {n}" / "Decided {n}".
- A single column of cards at the reading measure. One `sr-only` `role="status"` line for the list; the cards are not a live region.
- The rule strip appears in the empty state only.

### 7.3 Case card (new shared component: `DecisionCard`)

Top to bottom:

1. **Header line** – `Pill` with the amber pulsing dot and "needs your decision" (the `decision` state's own label from `lib/attention.ts`); a category chip on the muted surface reading Scope / Done means / Breaking change / Outside action; "raised by the agent | the leader | xezar · brief check"; the age in the soft colour; on its own line under that, the blocked task as a link with its ref, title and, for a brief-check case, "stopped before start" (owner: the title is the thing being decided about, it gets a line, not a corner); a third line holds the **GitHub links**: "issue #{n}" and "PR #{n}" (with "· merged" when it is), read from the run's refs (`issueNumber`, `prNumber`, `pullRequestUrl` via `runs/task-refs`), each hidden when the task has none, each opening GitHub in a new tab with the external icon and an sr-only ", opens GitHub in a new tab". Owner's requirement, 2026-09-14 evening: the widest context is one click away.
2. **Question** – one sentence, 14 px semibold; the largest text on the card.
3. **In plain words** – REQUIRED, always visible, 14 px body, under the "In plain words" eyebrow. Three to five short sentences for a person who did not read the thread. No file names, no tool names.
4. **Technical details** – a native `<details>`, closed by default, on `--card-2`, with the chevron icon in the summary. Inside, the **why line** then the evidence: a diff stat, the brief beside the issue quote, a short history, the agent's reasons. Never the full diff.
5. **Options** – 2–4 stacked full-width buttons, the ask card's exact look, in a `role="group"` labelled by the question, `aria-pressed`. One may carry "Recommended by the agent | leader" in muted text. Never a colour.
6. **Comment** – a `Textarea` (the component's own min height), placeholder "Add a comment for the {agent | leader} — optional…", visually hidden label "Comment".
7. **Send row** – the hint on the left in the muted colour ("Pick an option, write a comment, or both. You can take it back until the task acts on it." → "Sends “{option}” and your comment to the task. …"; for publish/release: "… cannot be taken back once the task acts."), then the ghosts "Not a decision" and "Leader decides" (disabled with "No leader is connected" beside it when no MCP session is open) and the primary "Send decision", disabled until an option is pressed or the comment is non-empty.

Decided card (collapsed): one line "Decided — **{option}** · by you · {time}", "· passed on by the leader · {time}" or "· by the leader · delegated by you at {time} · {time}"; the comment, the quoted owner words or the leader's reason; a foot line with how the task came back ("resumed with its context" / "re-ran the step with a fresh agent") and a ghost "Reopen" while the task has not acted. Delegated card: "**With the leader** · since {time} · {category}", the owner's guidance quoted, a foot line and a ghost "Take it back"; violet tint and the violet dot, since the leader is the one working. Void card: "**No longer needed** · the task was cancelled · {time}". Not-a-decision card: "**Not a decision** · by you · {time}" with the words and "Counted as a false alarm."

### 7.4 Task page

- The run is in the new `decision` state: the pill reads "needs your decision", the dot pulses amber, the sidebar row sits under NEEDS YOU. The task holds no slot – another queued task may be working in it.
- A banner above the thread (the review banner's shape, primary tone): "**Stopped – waiting for your decision.** The slot is free and the agent's session is closed. The task goes back to the queue the moment you decide, here or on the Decisions page, and picks up where it stopped." with an outline "Open Decisions" button.
- The same `DecisionCard` in the thread, after the turn that raised it (`XEZ:DECIDE` for an agent; a system turn for the brief check).
- A **scope-check line** in the step rail's spelling with the three-valued result: "ran · no user-facing surface outside the brief", "ran · 1 surface outside the brief: …", "unknown · the model did not answer in 60 s", "skipped · no writing step". Worst case two minutes after the last writing step.
- The composer is disabled with the placeholder "Decide above first — the agent cannot read a message until you do." and a hint line under it.
- **A Decisions tab** (`TabLink`) joins Session · Changes · Files, with a violet count of this task's open cases (hidden at 0). One list: open cases first, then a "Decided · {n}" group heading, newest first.

### 7.5 The leader (MCP)

See `task.html` § What the leader gets and the requirements F-19..F-21, F-30.

- `decision.requested` journal row with the question, the plain text, the options, the derived list of refused moves and the case version token; `decision.recorded`, `decision.reopened`, `decision.voided`, `scope.reported`.
- Every blocked tool refuses with `reason: "decision.pending"`, the case id and the question, and says: take it to the owner, record with `record_decision`.
- `execution_control record_decision` (requires `ownerWords`, `expectedVersion`, `operationId`) and `execution_control open_decision` (requires `plain`; a retried `operationId` returns the first receipt). `task_read view: 'decisions'` lists a task's cases.
- The first `leader_events` page after a reconnect carries the count of open cases.

## 8. States

### Badge

| State | Shows | Words |
|---|---|---|
| 0 open | nothing | – |
| 1–99 open | violet count | "Decisions, {n} decisions waiting" (sr-only) |
| 100+ | "99+" | "more than 99 decisions waiting" |
| loading / error | nothing | – (never a guessed number) |
| collapsed project with open cases | count on the group header | "{project}, {n} decisions waiting" |

### Card

| State | Look | What changes |
|---|---|---|
| Open | full card, Send disabled, hint says what can be sent and whether it can be taken back | – |
| Option pressed / comment typed | pressed option tinted; hint names what will be sent; Send enabled | – |
| Sending | Send reads "Sending…", card inert | focus moves to the next open card, or the heading |
| Decided by you | collapsed line "· by you"; comment quoted; how it resumed; Reopen | leaves Open, joins Decided; task re-queued |
| Decided through the leader | collapsed line "· passed on by the leader"; owner words quoted; Reopen | same |
| Acted on | Reopen gone; foot reads "Acted on at {time} — cannot be reopened." | set by the engine at the first outward effect |
| Reopen while a turn is in flight | Reopen refused; the button shows the reason | – |
| Reopened | full card again; header adds "reopened by you"; evidence gains "The earlier decision" | task stops again; agent told at its next turn boundary |
| Not a decision | collapsed, muted; "Not a decision · by you"; words quoted; "Counted as a false alarm." | task continues as if the case had not opened |
| With the leader | collapsed, violet tint; "With the leader · since {time}"; guidance quoted; "Take it back" | leaves the badge and "needs you"; task stays stopped; `decision.delegated` to the leader |
| Decided by the leader (delegated) | collapsed line "· by the leader · delegated by you at {time}"; reason quoted; Reopen | task re-queued |
| No longer needed | collapsed, muted; "the task was cancelled/deleted" | closes with the task |
| Someone else answered first | `banner-row alert` `role="alert"`: who, what, when; "Your answer was not sent; your comment is kept in the box." | the stale-write refusal on the case token |

### Page

| State | Component | Copy |
|---|---|---|
| Empty, Open | `CenteredState` with the hand icon, then the rule strip | "No decisions waiting" / "When an agent, the leader or xezar meets a choice that is yours, it appears here and in the menu." |
| Empty, Decided | `CenteredState` with a check | "Nothing decided yet" / "Decisions you make, and the ones the leader passes on for you, are kept here with the words that were used." |
| Loading | two card `Skeleton`s, sr-only status "Loading this project's decisions…" | – |
| Error | `CenteredState tone="danger"` | "Could not load the decisions" / server message verbatim; "Retry" |
| Hosted mode | none | Deciding changes a task record, not the host; the page refuses nothing |

## 9. Copy deck

| Where | Text |
|---|---|
| Menu | Decisions |
| Badge sr-only | , {n} decisions waiting |
| Page header | Decisions / {n} decisions are waiting for you / Nothing is waiting for you |
| Rule strip (empty state only) | **Only you can answer these.** Agents and the leader bring you the choices they may not make: new scope, what “done” means, breaking changes, and publishing or releasing. The task stops and frees its slot until you decide. The leader cannot decide for you. |
| Segments | Open {n} · Decided {n} |
| Status pill (the `decision` state) | needs your decision |
| Categories | Scope · Done means · Breaking change · Outside action |
| Raised by | raised by the agent · raised by the leader · raised by xezar · brief check |
| Task link suffix (brief check) | · stopped before start |
| GitHub links | issue #{n} · PR #{n} · PR #{n} · merged · sr-only ", opens GitHub in a new tab" |
| Plain-words eyebrow | In plain words |
| Technical summary | Technical details |
| Why line lead | Why this is yours: |
| Evidence headings | The brief ({who}, {time}) · The issue (#{n}) · How it got here · The agent’s reasons · Release · What happens · The earlier decision |
| Recommended | Recommended by the agent · Recommended by the leader |
| Comment placeholder | Add a comment for the agent — optional… / Add a comment for the leader — optional… |
| Send hint | Pick an option, write a comment, or both. You can take it back until the task acts on it. / Sends “{option}” and your comment to the task. You can take it back until the task acts on it. / Sends your comment to the task. … / for publish or release: **“{option}” cannot be taken back once the task acts.** |
| Actions | Not a decision · Leader decides · Send decision → Sending… |
| Leader decides, disabled | No leader is connected |
| Delegated line | With the leader · since {time} · {category} / You wrote: “{guidance}” / The leader answers over the MCP with a reason. The task stays stopped and its slot stays free until then. Not counted in your badge. · Take it back |
| Decided by the leader | Decided — {option} · by the leader · delegated by you at {time} · {time} / Leader’s reason: “{reason}” |
| Status pill (delegated) | with the leader |
| Task banner (delegated) | **Stopped – the leader is deciding.** Take it back on the card if you change your mind. · Open Decisions |
| Decided line | Decided — {option} · by you · {time} / Decided — {option} · passed on by the leader · {time} |
| Decided foot | The task went back to the queue and resumed with its context at {time}. / … and re-ran the step with a fresh agent at {time}. / The leader recorded these words as yours. If they are not, reopen the case. / Acted on at {time} — cannot be reopened. |
| Reopen | Reopen / refused: A turn is running — try again when it ends. |
| Not a decision | Not a decision · by you · {time} / The task continued as if the case had not opened. Counted as a false alarm. |
| Void | No longer needed · the task was cancelled · {time} / · the task was deleted · {time} |
| Race alert | **This case was decided a moment ago.** The leader recorded “{option}” at {time}, while you were writing. Your answer was not sent; your comment is kept in the box. Read the decision under Decided and reopen it if it is wrong. |
| Task banner | **Stopped – waiting for your decision.** The slot is free and the agent’s session is closed. The task goes back to the queue the moment you decide, here or on the Decisions page, and picks up where it stopped. · Open Decisions |
| Scope-check line | Scope check · ran · no user-facing surface outside the brief / ran · {n} surface(s) outside the brief: {list} / unknown · {reason} / skipped · {reason} |
| Task tab | Decisions {n} · sr-only ", {n} open" · group "Decided · {n}" |
| Composer | Decide above first — the agent cannot read a message until you do. / A plain message would let the task continue past the decision. Use the card. |
| Browser notification | Task needs your decision |
| Errors | Could not load the decisions · {server message} · Retry |

Rules applied: sentence case, ` — ` between clauses, `…` one character, curly quotes and apostrophes in shipped strings, no Oxford comma, `xezar` lower case, no contractions.

## 10. Developer notes

The engine contract is the requirements document (F-1..F-30, § 6 state machine). This section covers what the cockpit needs to know and every departure from the design system.

### 10.1 Where the case lives

- `RunRecord.decision?` (optional, `.catch`) – the open or last case: `{ id, category, raisedBy: 'task-agent' | 'leader' | 'scope-check' | 'brief-check', question, plain, why, options, recommended?, evidence?, openedAt, status: 'open' | 'decided' | 'not-a-decision' | 'void', answer?: { choice?, comment?, ownerWords?, channel: 'ui' | 'mcp', at, actedOnAt?, resumedWith?: 'session' | 'fresh' }, reopened?: [...], version }`.
- History: undotted `decision` events on the run's NDJSON with `action: requested | recorded | reopened | voided | not-a-decision`.
- The run index row carries `decisionPending?: true`. The badge, the multi-project counts, the attention dot and the notification all read run snapshots the workspace SSE already carries – no decisions query, no per-reader subscription.
- The case's own version token (`rev1:decision:<caseId>:<seq>:<digest>`) guards answer and reopen; the run's token moves with every event and is not used.

### 10.2 Who may close a case

- `POST /api/v1/p/:projectId/runs/:id/decision` – the cockpit. Body `{ choice?, comment?, expectedVersion }`; `{ notADecision: true, comment?, expectedVersion }` for the third answer (cockpit only).
- `execution_control record_decision` – the leader. Requires `ownerWords` (≤ 1 000 chars), stores `channel: 'mcp'`. On a **delegated** case it requires `reason` instead and refuses `ownerWords`; the answer records `by: 'leader'`.
- `POST …/runs/:id/decision/delegate` `{ comment?, expectedVersion }` and `…/decision/take-back` – the cockpit only (F-31). Delegating moves the case to `delegated`: the run stays in `decision`, `decisionPending` on the index row becomes `decisionDelegated`, so the badge and the attention bucket drop it while the task page keeps its stopped banner. `lib/attention.ts` gets a second row for the delegated run: bucket working, tone violet, pulse, label "with the leader".
- Both are refused with 409 when the case is not open or the token moved; the response carries the current answer so the cockpit can show the race alert and keep the typed comment.
- Nothing else. No `user-message` closes a case (the `XEZ:ASK` auto-resolve does not apply); that is why the composer is disabled while one is open.

### 10.3 The `decision` state and what it blocks

- New run status `decision`: the semaphore releases the slot, the session is ended the way `finish` ends one, no idle timer, no monitoring wake, no auto-resume, not in the queue. Survives a restart. Applies to autonomous tasks.
- Refusals at the engine choke points (`continueRun`, `finish`, `sendMessage`) with `decision.pending`; every caller – routes, MCP, timers – hits the one implementation. `handoff_git ready | merge` and the routes refuse a PR the stopped task carries, whichever run asks.
- `lib/attention.ts` gets the row: `decision` → bucket needs-you, tone pending, pulse, label "needs your decision". `lib/notifications.ts` body "Task needs your decision".

### 10.4 How a case opens

1. **A task agent** ends its turn with `XEZ:DECIDE <compact-json>` carrying `{ category, question, plain, why, recommended?, evidence? }`. `XEZ:ASK` is not extended. On an old engine the marker is prose: no card, and a non-final step fails closed – nothing continues silently.
2. **The leader** calls `execution_control open_decision`; `plain` is required.
3. **The brief check** runs at `task_create` and `organise_work edit_brief` when the brief and a linked issue both exist: one model turn (the namer's pattern) comparing the brief with the issue; a surface in the brief that the issue does not name opens a `scope` case before the task starts (`raisedBy: 'brief-check'`, task shown as "stopped before start").
4. **The diff check** after the last writing step is report-only: `scopeCheck: { status: 'ran' | 'unknown' | 'skipped', at, reason?, surfaces? }` on the run, the scope-check line on the task page, `scope.reported` to the leader. `unknown` is never "nothing to flag".

**The plain text is never optional.** A case without `plain` from an agent gets one written by the same model turn and marked `plainBy: 'xezar'` ("summary by xezar" on the card). A leader call without `plain` is refused.

### 10.5 Mandate

The mandate – the brief plus the linked issue, whoever wrote them – is frozen at **dequeue**, not at creation, so a queued brief stays editable; an edit while queued re-runs the brief check. Later edits go to `mandate.amendments[]` with their origin. With no issue, the brief is the mandate.

### 10.6 Resume

On an answer the run returns to `queued`. When it gets a slot the same workflow step resumes the agent's session (Claude Code `--resume`, the Codex thread) with the answer as the next user message (`origin: human`, or `leader` with the owner words); the step timeout restarts. When the session cannot be resumed (pi, expired session, reclaimed worktree) the same step re-runs with a fresh agent given the original prompt, the handoff notes and the answer. `resumedWith: 'session' | 'fresh'` is recorded and shown on the decided card.

### 10.7 Cockpit files to touch

| File | Change |
|---|---|
| `lib/attention.ts` | the `decision` row |
| `components/nav-items.ts` | new row `Decisions`, badge `decisions-open`, no gate |
| `components/app-shell.tsx`, `app-shell-container.tsx`, `project-groups.tsx` | counts from the run snapshots; mobile-bar count with `sr-only` words |
| `routes.tsx` | `/p/:projectId/decisions` (+ legacy redirect); `…/tasks/:id/decisions` |
| `routes/decisions.tsx` (new) | page, `TabLink` segments, list, states |
| `components/decision-card.tsx` (new) | the card; extract the option list from `routes/task-thread/ask-card.tsx` into a shared `AskOptions` so both render the same buttons |
| `routes/task-thread/task-thread.tsx` | banner, inline card, scope-check line, disabled composer; the Decisions `TabLink` with its count |
| `routes/task-thread/task-decisions.tsx` (new) | the task's Decisions tab: open cases, then "Decided · {n}" |
| `lib/notifications.ts` | body "Task needs your decision" |
| `api/` | SSE patch for the run snapshot's `decision` field (patch the cache in place, as runs do) |
| `docs/design-system/components.md`, `coverage.md`, `cockpit.css`, `writing.md`, `known-gaps.md` | component entry, coverage row, base class for the card, quoted copy, the departures below |

### 10.8 Mockup px → Tailwind

| Mockup | Tailwind (density lever preserved) |
|---|---|
| card `padding: 14px 16px; gap: 10px` | `px-4 pt-3.5 pb-3.5 space-y-2.5` (ask-card.tsx:82) |
| card border / background | `border-primary/25 bg-primary/[0.04]` (ask-card.tsx:82) |
| `.case-cat` | `rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground` |
| `.gh-link` | `inline-flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground hover:text-foreground hover:underline underline-offset-[3px]`; icon `size-3 text-soft-foreground`; `target="_blank" rel="noopener"` |
| question 14/600 | `text-sm font-semibold leading-snug` |
| plain 14/1.55 | `text-sm leading-relaxed` |
| why / evidence / turn 13/1.5 | `text-[13px] leading-normal text-muted-foreground` |
| details | `rounded-md border bg-card-2`; summary `min-h-9 px-2.5 text-[13px] font-medium` |
| pre 12/1.55 | `rounded-sm bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap` |
| option `padding: 10px 14px` | `rounded-md border px-3.5 py-2.5` + hover `border-primary/50 bg-primary/[0.06]`, pressed `border-primary/60 bg-primary/[0.06]` (ask-card.tsx:192-196) |
| option label 13.5/600, desc 12 | `text-[13.5px] font-semibold`, `text-xs text-muted-foreground` |
| hint 12 | `text-xs text-muted-foreground` |
| Send | `<Button>` default (primary); "Not a decision" `variant="ghost"` |
| banner | `rounded-md border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-[13px]` (review-panel.tsx:42, primary tone) |
| scope-check line | `rounded-md border bg-card px-3 py-2 text-[13px] text-muted-foreground`; result `font-mono text-xs` |
| phone targets | `md:` (768 px) breakpoint; `min-h-11` on options, summary, Send, Reopen, Retry |

### 10.9 Departures from the design system

| Departure | Reason | Where recorded |
|---|---|---|
| Category chip on `--muted`, not the ask card's primary chip | Three accent chips beside a primary Send invert "lime is the one call to action"; the accent chip fails contrast at 10 px under `data-accent="violet"` | `known-gaps.md` § Mockup fidelity, new `dec-*` row |
| A new run status (`decision`) with an `attention.ts` row | `waiting` is not a durable park (idle timer, restart recovery, autonomous nudge, auto-resume) | requirements F-10, D-12; BACKWARD_COMPATIBILITY.md § run statuses |
| Age in `--soft-foreground` | A timestamp, not meaning-bearing text; G-23 applies to nothing else on the card | `known-gaps.md` G-23 |
| Stand-in classes `.case-*`, `.banner`, `.scope-line`, `.task-column`, `.task-tabs` | New surfaces; every shared class (`.pill`, `.dot`, `.btn`, `.textarea`, `.tab-links`, `.skeleton`, `.centered-state`, `.banner-row`, `.group-heading`, `.version-chip`, `.eyebrow`) is used unchanged | this table |

### 10.10 Tests

- Contract parity for the new schemas and routes; `typed-bodies.test.ts` for the new bodies; `route-parity.test.ts` picks up the scoped routes; `mcp-api-doc.test.ts -u` for the two new actions and the `task_read` view; `api-coverage.testkit.ts` rows.
- Engine: the `decision` state releases the slot and arms no timer; refusals at the three choke points; restart with a case open stays in `decision`; `record_decision` without `ownerWords` is refused; a stale case token returns the current answer; reopen refused while a turn is in flight; a cancelled run voids its case; the `XEZ:ASK` auto-resolve does not close a case (pin the empty-input case); resume with session, fallback to fresh, `resumedWith` recorded; `XEZ:DECIDE` in a non-final step on the old parser fails closed.
- Brief check: brief names a Settings control, issue does not → case before start; brief within the issue → no case; no issue → skipped with the reason. Replay the 2026-09-13 campaign's leader briefs against their issues: the #403 round-4 brief must open a case; the false-alarm count goes into the implementing PR.
- Diff check: `ran` with a surface, `ran` empty, `unknown` on model timeout, `skipped` without a writing step; never a boolean.
- Cockpit: card renders each state; Send disabled/enabled rules; "Not a decision"; race alert keeps the comment; focus after Send; badge hides at 0 and while loading; keyboard path through details → options → comment → Send.
- Browser suite: open a case in dry-run, decide it, see the task re-queue and resume; phone width.

## 11. Accessibility

- Badge number hidden from screen readers; words instead – in the sidebar, the mobile bar and the collapsed project header.
- Category, "needs your decision", "Recommended" and "raised by" are words. Colour and icon reinforce only.
- Option buttons are real `<button>`s with `aria-pressed`; the group has `role="group"` labelled by the question.
- Technical details is a native `<details>`; it opens with Space/Enter and needs no script.
- The comment box has a visually hidden `<label>`.
- A disabled Send has its reason as visible text in the send row, in the muted colour.
- One `sr-only` `role="status"` line per surface announces a case that opens or is decided. The list, the banner and the cards are not live regions.
- After Send, focus moves to the next open card or to the page heading. The race alert is `role="alert"` and the typed comment is kept.
- The pulse and the skeleton stop under `prefers-reduced-motion`.
- The GitHub links say they open a new tab (sr-only), so nobody loses the page by surprise.
- Every control shows the existing `:focus-visible` ring. Tab order: task link → GitHub links → details → options → comment → Not a decision → Leader decides → Send → Reopen / Take it back.

## 12. Responsive

- Below `md` (768 px; the mockup sheet collapses at 860 px): the sidebar is the drawer; the mobile bar shows "Decisions" and the count;  option buttons, the details summary, Send, Reopen, Take it back and Retry are 44 px; Not a decision and Leader decides share a row and Send takes the row below them.
- Nothing scrolls sideways at 375 px: the question, the diff stat, the option labels and the decided line wrap (`overflow-wrap: anywhere`); the head line wraps to a second line for the long category words.
- The longest expected question is 400 characters (the `XEZ:ASK` cap, reused); the longest option label 60; owner words ≤ 1 000, shown `whitespace-pre-line`.
- Scanning many: the Open segment keeps full cards (the expected night wave is ~10); the Decided segment pages by 20.

## 13. Acceptance criteria

The behaviour criteria are A-1..A-18 in the requirements document § 9. The design-only criteria this mockup owns:

1. Every case shows the plain-words text by default at body size and the technical text collapsed; a card says "summary by xezar" when the engine wrote the plain text.
2. The card offers four answers – an option, a comment, "Not a decision", "Leader decides" – and the hint says whether the answer can be taken back; "Leader decides" is disabled with its reason when no leader is connected.
2a. A delegated case shows "With the leader", the guidance, and "Take it back"; it is not in the badge; a leader-decided delegated case shows the leader's reason and "delegated by you at {time}".
3. The decided card shows who answered, the words, how the task resumed, and Reopen only while the task has not acted.
4. The task page shows the stopped banner, the same card, the scope-check line with its three-valued result, the disabled composer, and a Decisions tab whose count matches the Decisions page for that task.
5. The badge shows nothing at 0, while loading and on error; `99+` above 99; the mobile bar carries the words.
6. Keyboard-only: a case can be read, an option pressed, a comment typed and sent, "Not a decision" given, "Leader decides" given and taken back, and a decided case reopened; focus never falls to `<body>` after Send.
7. Both themes and 375 px pass the design system's review checklist; the drift test, the guardian and the handoff lint are green.

## 14. Open decisions

The open decisions are OD-1..OD-8 in the requirements document § 11 (the leader reopening a relayed answer; the diff net's cost attribution; headless `xezar run`; whether the agent receives the owner's words verbatim; and four more). None of them changes the mockup; OD-6 (words verbatim or option label only) changes the leader block in `task.html` § 3 if the answer is "label only".

## 15. Delivery plan

The ten-step plan is in the requirements document § 13. The cockpit step carries `needs-design` and this mockup is its reference; the `DecisionCard`, the `attention.ts` row and the design-system docs land together.

## 16. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The brief check cries wolf | Owners stop reading cases | Replay on the campaign's briefs before merging; report the false-alarm rate in the PR; "Not a decision" counts them in production |
| The brief check misses a real case | Drift ships as before | It is one of three raisers; the diff check reports after the work; misses go into the dogfooding log |
| A relayed answer is wrong | The task acts on words the owner did not say | The words are shown; Reopen is one click until the task acts; `actedOnAt` closes the window honestly |
| The session cannot be resumed | The agent loses its context | The fresh-agent path re-runs the step with the prompt, the notes and the answer; `resumedWith` measures how often |
| Cases pile up overnight | A wave of tasks sits stopped | Stopped tasks hold no slot, so the rest of the queue runs; the badge, the notification and the leader's morning count say how many |
| Old run files | An older xezar reads a new record | Every new field optional with `.catch`; the unknown status degrades to the attention bucket's default |

## 17. References

- `docs/features/decisions/decisions-requirements.md` – the contract
- `docs/features/decisions/decisions-grill-record-2026-09-14.md` – the interview and the 20 decisions
- `docs/features/decisions/decisions-design-review-2026-09-14.md` – R-1..R-27, U-1..U-20, G-1..G-22
- `docs/features/mcp-server/leader-dogfooding-2026-09-13.md` § 14.2 – the finding
- `packages/xezar/src/core/ask.ts` – `XEZ:ASK`, the shape `XEZ:DECIDE` reuses
- `packages/web/src/routes/task-thread/ask-card.tsx` – the card this design extends
- `packages/web/src/routes/task-thread/review-panel.tsx:42` – the banner shape
- `packages/web/src/lib/attention.ts` – the status rows
- `docs/design-system/` – README, components, patterns, writing, new-designs, known-gaps

## 18. Design review

Pending. Revision 1 was reviewed on 2026-09-14 by five reviewers (business, engineering, UX, UI, design-system); the findings and their disposition are in the review record § 1–§ 6. Revision 2 applies U-1..U-20 and G-1..G-22.
