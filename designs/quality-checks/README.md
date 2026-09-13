# Quality checks – design handoff

| | |
|---|---|
| **Status** | Draft – waiting for owner decisions (see [Open decisions](#open-decisions)) and a UX/UI design review (`xezar-ux-design`) |
| **Date** | 2026-09-13 |
| **Mockup** | Open [`index.html`](index.html) in a browser. No build or server needed. |
| **Replaces** | The "Quality checks" section on Project settings → MCP connection (issue #114, PR #255) |
| **Covers requirements** | F-22, A-22, U-M06, UX-M05 in `docs/features/mcp-server/mcp-project-leader-requirements.md` |

## 1. Summary

A check is a shell command in a workflow, for example the test gates or "Confirm the task is not blocked". When a check fails, the task is not complete.

Today that fact is hard to see and sometimes hidden:

- The failures are listed on a settings page that nobody opens when something breaks.
- The list never clears. Nothing can run a check again, so a card stays until someone archives the task.
- **A task can show a green "done" while a check never passed.** Continue on a failed task adds a new agent step, skips the old check, and can end the task as `done`.

This design:

1. Adds a **Checks** menu item with a live count of failing checks.
2. Adds a **Checks** page that groups failures by the next action.
3. Adds **Re-run check**, the missing legitimate way to pass a check.
4. Labels every task truthfully: **"done · check failed"** instead of a green "done".
5. Gives the leader the same fact through its MCP tools.
6. Shrinks the Settings section to the rule plus one live line.

## 2. Problem evidence

Measured on this repository's live data on 2026-09-13 (`GET /api/v1/p/xezar/runs`, 178 tasks):

| Measure | Value |
|---|---|
| Cards in the current Settings list | 15 |
| Of those, tasks still running or waiting | 0 |
| Tasks that ended `done` with a failed check | 8 |
| Tasks later redone in a newer task | at least 5 |
| Real code or test failures | 2 |
| Process or setup refusals | 13 |

Code facts behind the problem:

- The list is built in the browser from every non-archived task with a failed check step: `failingQualityChecks`, `packages/web/src/routes/settings/mcp-capabilities.tsx:256`.
- Continue on a failed task appends a `continue-N` step (`packages/xezar/src/workflows/run.ts:2707`). `settleSuccess` (`run.ts:4124`) never looks at the steps.
- No route or button re-runs a single step.
- The leader never reads the Settings page. It gets check results through `task_read`, `read_results_evidence` and `leader_events`.

## 3. Users and jobs

| User | Job | What they need from this design |
|---|---|---|
| **Person running xezar** | "Is anything broken that needs me?" | One place with a true count, and a clear next action for each failure |
| **Person reviewing a task** | "Is this task really finished?" | A task status that cannot say "done" when a check never passed |
| **MCP leader (agent)** | "Can I report this task as complete?" | A machine-readable "not complete" answer, and no way to skip a check |

## 4. Goals and non-goals

**Goals**

- The menu count is always the true number for the active project.
- Every failing check shows a legitimate next action: re-run, open the task, or archive.
- No surface calls a task complete while one of its checks never passed.
- The person and the leader read the same fact from the same server field.

**Non-goals**

- Dismissing, waiving or accepting a failing check. The spec forbids this (F-22, U-M06).
- A cross-project total in the menu. The cross-project index stops at 200 tasks per project, so its total could be wrong.
- Changing what Continue does (see open decision D1).
- Showing check output on the Checks page. The task page already shows it.
- Fixing the kit workflows that fail readiness by design. That is a separate kit change (see [Delivery plan](#10-delivery-plan)).

## 5. Files

| File | Content |
|---|---|
| `index.html` | Overview, decision table, phone preview, accessibility list |
| `checks.html` | The app shell with the new menu item and the full Checks page. Narrow the window below 860 px for the phone layout. |
| `states.html` | Badge states, all card states, empty, loading and error |
| `task.html` | Task list chip, task page banner and steps, leader tool changes |
| `settings.html` | MCP connection section before and after |
| `../../docs/design-system/cockpit.css` | The shared design-system stylesheet every page links first: tokens for both themes (verbatim from `packages/web/src/styles/index.css`, drift-tested) and the base component classes. |
| `styles.css` | Feature-specific rules only (check cards, the rule strip, the failed-check banner, the red Checks badge, the mockup empty/skeleton/toast). No tokens, no base classes. **Do not import this file into the app.** |
| `theme.js` | Mockup-only light/dark switch |

The mockup uses sample data based on real tasks. The command output on `task.html` is example text.

## 6. Information architecture

```
Sidebar (per project)
├── Tasks
├── Inbox
├── Checks            ← NEW  /p/:projectId/checks   badge: failing checks
├── Git
├── GitHub
├── Automations
├── Skills
├── Workflows
└── Settings
      └── MCP connection → "Quality checks": rule + one live line + link to Checks
```

- **Route:** `/p/:projectId/checks`. The existing `LegacyPathRedirect` sends a flat `/checks` to the boot project, so no extra redirect is needed.
- **Active state:** the item is active for paths that start with `/checks`.
- **Command palette:** ⌘K builds its Views group from the menu items, so Checks appears there without extra work.
- **Page title:** "Checks".

## 7. Screens

### 7.1 Menu item and badge

| Property | Value |
|---|---|
| Position | After Inbox, before Git |
| Label | Checks |
| Icon | lucide `ShieldCheck`. `ListChecks` is taken by Tasks. |
| Badge content | Number of failing checks in this project. `99+` above 99. |
| Badge hidden when | The count is 0, while loading, or when the data could not load |
| Badge style | Same shape as the Inbox badge (`rounded-full px-1.5 py-px text-[10.5px] font-semibold`), but `bg-danger text-danger-foreground` |
| Screen reader | The visible number is `aria-hidden`. The link reads "Checks, 6 failing checks" (singular: "1 failing check"). |
| Multi-project sidebar | Only the active project's group shows the number, like Inbox |

**Why red:** in the menu, violet means "someone wants you" (Inbox, unread tasks). Red is the cockpit's colour for a failed task. White on `--danger` is 3.8:1, higher than the shipped Inbox badge (3.1:1). Both are below AA for small text. The design review owns this call.

### 7.2 Checks page

Layout follows the Inbox page:

- **Header:** sticky, 56 px (`h-14`), title "Checks", subtitle "6 failing checks in 6 tasks". Hidden on phones, where the mobile bar shows the title and badge.
- **Body:** one centred column, max width 768 px (`max-w-3xl`), padding 20 px (12 px on phones).
- **Rule strip** at the top: lock icon plus the no-skip rule (copy in [§9](#9-copy-deck)).
- **Group 1 – "Can re-run":** tasks whose worktree still exists.
- **Group 2 – "Cannot re-run":** tasks whose worktree was removed.
- Each group header shows a name, a count and a one-line instruction.
- **Sort inside a group:** newest failure first.
- **Groups with no cards are not shown.** If both are empty, show the empty state.
- The list container is `aria-live="polite"`.

### 7.3 Check card

```
[⚠]  Check name                                   [↻ Re-run check] [Open task] [🗄]
     exact command · exit N
     Task title (link)   (● done · check failed)   Failed 14 h ago · 3 of 3 tries
     [ℹ hint – only in some states]
```

| Part | Spec |
|---|---|
| Container | `rounded-lg border border-border bg-card shadow-xs`, padding 14 px × 16 px, 10 px gap between cards |
| Status icon | `TriangleAlert` 16 px `text-danger`. It changes by state (see [§8](#8-states)). |
| Check name | 14 px, semibold. It comes from the step name. |
| Command | `font-mono` 11.5 px `text-muted-foreground`, wraps anywhere. The exit code is `text-danger`. |
| Task line | Task title as a link to `/tasks/:id`, 12.5 px medium. Then the status `Pill`. Then the time and tries in `text-soft-foreground`. |
| Status pill | The existing `Pill` with a `dot`. The colour lives in the dot, never the fill. |
| Primary action | "Re-run check": the contrast button (`bg-contrast text-contrast-foreground`), `RotateCcw` icon |
| Secondary action | "Open task": outline button. It opens the task page scrolled to the failed check's output. |
| Tertiary action | Archive: ghost icon button, `aria-label="Archive task <title>"` |
| Button height | 30 px. 40 px on phones, where the buttons wrap under the text. |
| Hint | `bg-card-2 border rounded-sm`, 12.5 px, with an `Info` icon, indented to the text column |

**What the card never shows:** the check's output. It can be long and can contain anything. It stays on the task page.

### 7.4 Task list and quick list

- The status pill reads **"done · check failed"** with a red dot. The record stays `done`.
- In the sidebar quick list, the dot for such a task is red instead of green. Its title tooltip reads "done · check failed".
- **Attention bucket:** such a task goes with failed tasks in "Needs you" (the `error` bucket in `lib/attention.ts`), not with finished work.

### 7.5 Task page

- **Banner** under the title, above the thread. It has a red-tinted border and `role="status"`.
  - Text: "This task is not complete." plus a sentence naming the check and how many steps did not run.
  - Actions: Re-run check, See output (scrolls to the check's output card).
- **Step rail:**
  - The failed check shows `CircleX` in red, labelled "check · failed · not passed since".
  - Steps after it, in a task that has ended, read **"did not run"** instead of "pending".
  - A `continue-N` step is labelled "does not replace a check".
- **Footer:** "Done, but not complete – check "<name>" never passed." with a link to the Checks page.

### 7.6 Settings → MCP connection

- Keep the section title "Quality checks".
- Replace the card list with:
  - The rule: "The leader cannot skip, waive or accept a failing check, and neither can an approval. A task with a failing check is not complete."
  - One row: an icon, "6 failing checks in this project" or "No failing checks in this project", and an "Open Checks" button.

## 8. States

### Badge

| State | Shows |
|---|---|
| Loading | Nothing |
| Error | Nothing |
| 0 | Nothing |
| 1–99 | The number |
| More than 99 | `99+` |

### Card

| State | When | Icon | Pill | Actions | Hint |
|---|---|---|---|---|---|
| **a. Failing** | Default | `TriangleAlert` red | "failed" or "done · check failed" | Re-run, Open task, Archive | – |
| **b. Re-running** | After Re-run is pressed, until the check ends | `RotateCcw` violet | "re-running check", pulsing violet dot | Disabled "Re-running…" with a spinner; "Watch output" | – |
| **c. Failed again** | The re-run ended with a non-zero exit and the same exit code as before | `TriangleAlert` red | "failed" | Re-run, Open task, Archive | "Same result as before. Re-running alone will not fix it…" |
| **d. Passed** | The re-run ended with exit 0 | `CircleCheck` green, green border | "running · <next step>" | – | Card leaves after about 2 s. Toast for 6 s. |
| **e. Task busy** | The task is `queued`, `running` or `waiting` | `TriangleAlert` red | Task's live status | Re-run with `aria-disabled` and `aria-describedby` pointing at the hint; Open task. **No Archive.** | "The agent is working on this task. You can re-run the check when it stops." |
| **f. Worktree removed** | The task's worktree no longer exists | `TriangleAlert` red, muted text | "failed" or "done · check failed" | Archive task (primary), Open task. **No Re-run.** | "This check can no longer run: the task's worktree was removed…" |

While a check re-runs (state b), the badge still counts it. The count drops only on a pass or an archive.

### Page

| State | Shows |
|---|---|
| Loading | Three skeleton cards; an sr-only "Loading this project's checks…" status |
| Empty | Green tick, "No failing checks", and one sentence |
| Could not load | Alert with a plain reason and "Try again". It reloads by itself on reconnect. |
| Re-run refused | Alert with a plain reason and the next step. Raw server errors are never shown. |

## 9. Copy deck

Use these strings exactly. Sentence case, en dashes, no jargon.

| Key | Text |
|---|---|
| `nav.label` | Checks |
| `nav.sr` | {n} failing check / {n} failing checks |
| `page.title` | Checks |
| `page.subtitle` | {n} failing checks in {m} tasks |
| `rule.title` | A failing check is never skipped. |
| `rule.body` | A task with a failing check is not complete. Nobody can dismiss it – not you and not the leader. It leaves this list when the check passes again, or when you archive the task. |
| `group.canRerun.title` | Can re-run |
| `group.canRerun.hint` | Fix the cause in the task, then re-run the check. |
| `group.cannotRerun.title` | Cannot re-run |
| `group.cannotRerun.hint` | The task's worktree was removed. Archive it or start a new task. |
| `card.exit` | exit {code} |
| `card.failedAgo` | Failed {relative time} |
| `card.failedAgain` | Failed again just now · re-run {n} |
| `card.tries` | {n} of {max} tries |
| `pill.doneCheckFailed` | done · check failed |
| `pill.rerunning` | re-running check |
| `action.rerun` | Re-run check |
| `action.rerunning` | Re-running… |
| `action.open` | Open task |
| `action.watch` | Watch output |
| `action.archive` | Archive task |
| `hint.failedAgain` | Same result as before. Re-running alone will not fix it. Open the task, read the output, and ask the agent to fix the cause first. |
| `hint.busy` | The agent is working on this task. You can re-run the check when it stops. |
| `hint.noWorktree` | This check can no longer run: the task's worktree was removed. Archive the task, or start a new task for this work. |
| `toast.passed` | {check name} passed. The task continues with its next step. |
| `empty.title` | No failing checks |
| `empty.body` | Every check in this project's tasks has passed, or its task was archived. New failures show here, and in the menu, the moment they happen. |
| `error.load.title` | Could not load the checks. |
| `error.load.body` | The connection to xezar was lost. This page reloads by itself when it comes back. |
| `error.rerun.title` | The check did not start. |
| `banner.title` | This task is not complete. |
| `banner.body` | The check "{name}" failed and has not passed since. The last {n} steps did not run. |
| `rail.didNotRun` | did not run |
| `rail.notPassedSince` | failed · not passed since |
| `rail.continue` | does not replace a check |
| `footer.notComplete` | Done, but not complete – check "{name}" never passed. |
| `settings.rule` | The leader cannot skip, waive or accept a failing check, and neither can an approval. A task with a failing check is not complete. |
| `settings.count` | {n} failing checks in this project |
| `settings.none` | No failing checks in this project |

## 10. Developer notes

### 10.1 One definition, on the server

**A failing check** is a step with `kind: 'check'` and `status: 'failed'` in a task that is not archived.

- Derive it **once on the server**, when a task is serialized. Add an optional field to the task response: `unresolvedChecks?: string[]` (step ids or names – settle this in the contract PR). Send it only when the list is not empty.
- **Do not persist it.** It is derived from `steps[]`, so old task files need no migration.
- **Do not add a task status.** `xezar run` exit codes and every status reader depend on the current values (`BACKWARD_COMPATIBILITY.md` §1). A new optional field is additive.
- Put the schema in `packages/contract` first, then the route. `contract-parity*.test.ts` must pass in both directions.
- Add the same optional field to the runs-index row (`runIndexEntrySchema`). It follows the `stepBackends` precedent. Update the row's field list in `BACKWARD_COMPATIBILITY.md` §2.

### 10.2 The count

- **Source:** `useRuns()` – the full, uncapped task list of the active project, already shared by the shell and patched live by the SSE `run` events.
- **Formula:** sum of `unresolvedChecks.length` over non-archived tasks.
- **Do not** count from `useRunsIndex`. It stops at 200 tasks per project.
- **Live updates:** no new WebSocket topic and no polling. The existing SSE `run` event already carries the full task record. A reconnect or tab refocus refetches.
- **Guard test:** the badge number equals the number of cards on the page for the same data.

### 10.3 Re-run check (new capability – proposed names)

- **Route:** `POST /api/v1/p/:projectId/runs/:id/rerun-check` with body `{ stepId }`.
  - Chain it into the runs family builder. Validate with `jsonZodValidator` / `paramZodValidator`. Put the request and response schemas in `packages/contract`.
  - Add the unscoped alias so `route-parity.test.ts` passes. Add the route to `BACKWARD_COMPATIBILITY.md` §2.
- **Behaviour:**
  - Run the saved command from `workflowDef` in the task's worktree.
  - On exit 0, set the step to `done` and continue the task's remaining pending steps.
  - On non-zero, keep `failed` and record a new `check-output` event.
- **Refuse with 409 and a person-readable reason when:**
  - the task is `queued`, `running` or `waiting`;
  - the worktree is gone;
  - `workflowDef` is missing (legacy records, #367);
  - the step is not a failed check.
- **Leader:** add a `rerun_check` action to `execution_control`. Do not add skip, waive or override. Regenerate the reference with `npm test -- packages/xezar/src/mcp/mcp-api-doc.test.ts -u` and add inventory records in `tools/api-coverage.testkit.ts`.
- **Security:** the command comes only from the task's saved `workflowDef`, never from the request body.

### 10.4 Leader wording

- `task_read`: list rows and the task view carry `unresolvedChecks`.
- `read_results_evidence`: replace the general `NOTES.done` text (`results-evidence.ts:232`) with a conditional note: "Not complete: check "<name>" never passed." Update the pinned test at `results-evidence.test.ts:315`.

### 10.5 Cockpit files to touch

| Area | File |
|---|---|
| Menu item | `packages/web/src/components/nav-items.ts` – new item, new badge value `'checks-count'` |
| Badge render | `packages/web/src/components/app-shell.tsx` (nav badge branch) and `project-groups.tsx` |
| Badge data | `packages/web/src/components/app-shell-container.tsx` |
| Route and title | `packages/web/src/routes.tsx` (route under `/p/:projectId`, `PAGE_TITLE_ROUTES`) |
| Page | `packages/web/src/routes/checks.tsx` (new) |
| Status label | `packages/web/src/lib/attention.ts` – a new rung for `done` with unresolved checks, in the `error` bucket |
| Task page | Banner, step rail wording, footer in the task thread components |
| Settings | `packages/web/src/routes/settings/mcp-capabilities.tsx` – replace the list |
| Shared text | Keep pill and label text in one module, like `lib/runner-label.ts`, so the phone card and desktop row cannot drift |

Tokens only: use `bg-danger`, `text-danger`, `bg-card-2` and the rest. No raw hex outside `styles/index.css`, which the design-guardian test enforces.

### 10.6 Tests to add or update

- **Unit:**
  - `nav-items.test.ts` (item order)
  - `app-shell.test.tsx` and `app-shell-container.test.tsx` (badge hidden at 0, loading and error; 99+; sr text)
  - `routes.test.tsx`
  - `command-palette.test.tsx` (path list)
  - `attention` tests
  - the new `checks.test.tsx`
  - `mcp-capabilities.test.tsx`
- **Server:**
  - the derived field (empty, one, several, archived, a retry that passed)
  - a Continue-then-done task still reports the check
  - every re-run refusal
  - `contract-parity`, `route-parity`, `typed-bodies`
  - MCP doc regeneration
- **Browser (`npm run test:e2e`):** `smoke.e2e.ts` nav list and badge; a Checks page spec driven by a dry-run task with a failing check.
- **Regression proof:** show the "Continue ends done with a failed check" test failing without the fix (`git stash push -- <source files>`), as `AGENTS.md` requires.

## 11. Accessibility

- Status is never shown by colour alone. Every red dot has words, and every card has an icon.
- The badge number is replaced for screen readers by a full phrase.
- The list is a polite live region. A check that fails or passes is announced without moving focus.
- A disabled Re-run keeps focus (`aria-disabled`, not `disabled`), and its reason is visible text linked with `aria-describedby`.
- All actions work by keyboard with the standard focus ring (`focus-visible:ring-[3px] ring-ring/50`).
- Icon-only Archive has a label that names the task.
- Pulse, spinner and skeleton sheen stop under `prefers-reduced-motion: reduce`.
- Touch targets are 40 px or more on phones.
- The light theme uses the same tokens. Check contrast in both themes during review.

## 12. Responsive

| Width | Layout |
|---|---|
| 860 px and up | Sidebar plus page. Card actions sit to the right of the text. |
| Below 860 px | Sidebar becomes the drawer. The mobile bar shows the menu button, "Checks" and the badge. Card actions wrap under the text at 40 px height. Page padding is 12 px. |
| Phone (390 px) | Previewed in `index.html`. The page never scrolls sideways. Long commands wrap. |

## 13. Acceptance criteria

1. With one non-archived task holding one failed check, the menu shows **Checks 1** and the page shows exactly one card.
2. The badge updates without a reload within a second of a check failing or passing.
3. The badge is hidden at 0, while loading, and on a load error.
4. A task that was continued to `done` over a failed check shows "done · check failed" in the task list, quick list and task page. It sits in "Needs you".
5. `task_read` and `read_results_evidence` report the unresolved check for that task.
6. **Re-run check** on a stopped task with a worktree runs the saved command:
   - exit 0 clears the card and continues the task;
   - a non-zero exit keeps the card with the new time.
7. Re-run is refused, with the plain reason shown, for a busy task, a missing worktree and a legacy task without `workflowDef`.
8. Archiving the task removes its cards and lowers the count. The Archived list still shows "done · check failed".
9. No surface anywhere offers dismiss, ignore, accept or waive for a check.
10. The Settings → MCP connection section shows the rule and the live line, and no card list.
11. All states in [§8](#8-states) are reachable and match the mockup in both themes and at 390 px.

## 14. Open decisions

| # | Question | Options | Recommendation | Blocks |
|---|---|---|---|---|
| **D1** | What happens when Continue succeeds on a task with a failed check? | **A1:** the task ends "done · check failed" and waits for Re-run. **A2:** xezar re-runs the failed check and the remaining steps by itself. | A1 now, A2 later as its own issue | Server PR and task page copy |
| **D2** | Does archive take a task out of the count? | **Yes:** archive means "dropped", and the red label stays in Archived. **No:** the count also covers archived tasks. | Yes | Count formula, empty state copy |
| **D3** | Badge colour | Red (danger) or violet (the existing "needs you" colour) | Red | Design review |

## 15. Delivery plan

| # | Pull request | Depends on |
|---|---|---|
| 1 | **Kit clean-up:** stop QA workflows failing "Confirm the task is not blocked" by design. Without it the badge never reaches 0. | – |
| 2 | **Server, contract, leader:** `unresolvedChecks`, leader wording, compatibility doc, tests | D1 |
| 3 | **Re-run check:** route, leader action, refusals | 2 |
| 4 | **Cockpit:** menu item and badge, Checks page, task labels, Settings change. Needs a `xezar-ux-design` review before done. | 2, 3, D2, D3 |

On the first day the badge will show about 15, from old tasks. Archive them to clear it.

## 16. Risks

| Risk | Mitigation |
|---|---|
| The badge is never 0 because some workflows fail by design, so people stop trusting it | Delivery step 1 fixes the kit first |
| Re-run runs a command in an old worktree against stale code | The card and banner say "fix the cause first". The run's output shows exactly what ran. |
| The derived field and the cockpit count disagree | One server definition, and a guard test that the badge equals the card count |
| Changing the `done` label surprises people who filter by status | The record status is unchanged. Only the label and attention bucket change. |

## 17. References

- Current section: `packages/web/src/routes/settings/mcp-capabilities.tsx`
- Issue #114, PR #255 (the original list); epic #67 (MCP leader)
- Spec: `docs/features/mcp-server/mcp-project-leader-requirements.md` – F-22 (line 73), A-22 (206), U-M06 (290), UX-M05 (322)
- Tokens: `packages/web/src/styles/index.css`
- Rules: `AGENTS.md` (HTTP API, Changing a mechanism that already works), `BACKWARD_COMPATIBILITY.md` §1 and §2
