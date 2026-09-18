# New issue in the GitHub tab — developer handoff

**Status: Draft.** Written by the kit's `design` workflow (`xezar-issue-create` is the skill it
launches; `xezar-ux-design` in authoring mode is the skill that wrote this). Static mockups plus
this handoff. No product code is part of this change.

Covers **PR 5** of [qodeca/xezar#468](https://github.com/qodeca/xezar/issues/468) — the "Optional UI
follow-up" row of the owner's sequenced plan, and criterion **IF-14**. Issue #468 stays open.

Open the mockups from disk, starting at [`index.html`](index.html). Owner questions, each with a
recommendation, are in [`open-questions.md`](open-questions.md).

---

## 1. Summary

The GitHub tab gets one control, **New issue**, at the end of its tab row. It opens a dialog that
states the destination, collects the person's brief in their own words, and starts an **ordinary
task** on this project with the `xezar-issue-create` skill selected. It reuses
`POST /api/v1/p/:projectId/runs` — the call the tab's "Hand this to the agent" panel already makes —
and adds **no issue-mutation endpoint**, no new route, no new `XEZ_*` flag and no new server
capability.

Starting the task is **not** approval of the issue body. The skill shows the exact title, body and
labels and asks **Create** or **Revise** through the task's own question flow (`XEZ:ASK` →
`AskCard`). This design puts that sentence on every surface it touches.

A second, smaller surface — a strip under the tab row — reports that a draft is running and links to
the task. It never answers the question.

Parity is part of the same implementation PR: the leader reaches the same capability with
`task_create` and a `skill` source. See § 11.

## 2. Problem evidence

| Observation | Source |
| --- | --- |
| The GitHub tab has no create control. `github.tsx:533` renders the issue/PR tabs; `hand-to-agent.tsx:183` calls `createRun`, not issue creation. | `packages/web/src/routes/github/github.tsx`, `hand-to-agent.tsx` (analysis at `bb271fc`) |
| The server's forge surface has no issue-create action — `forge/github.ts` discovers the repo and lists issues, nothing more. | `packages/xezar/src/server/forge/github.ts` |
| Zero literal `gh issue create` in `.xezar/skills/*.md` and `.xezar/workflows/*.yaml`. Filing today is an ad hoc task brief. | Reproduce with `rg -n --hidden 'gh issue create' .xezar/skills .xezar/workflows` (exit 1 = no matches) |
| The MCP registry has no issue-create tool; the filing path is `task_create` selecting the skill. | `packages/xezar/src/mcp/tools/index.ts`, `task-create.ts:52` |
| The owner decided the button is a later PR and that anything the UI can do the MCP must be able to do. | Owner, 2026-09-16 01:15, on #468 |
| The contract note already fixes the boundary this design must respect. | `docs/features/issue-filing/xez-issue-create-contract.md` § "Future integration and UI" |

## 3. Users and job

**Who.** The person operating this cockpit for this repository — most often its owner, sometimes a
contributor reading the tab to see what is open.

**What they are doing when they arrive.** They are in the GitHub tab. Either they have just read an
issue or a PR and realised a second, separate problem exists, or they searched the list for
something and found nothing. They are not in "file an issue" mode; they are in "look at the
tracker" mode, and filing is the thing they now have to do.

**What they just did.** Searched, filtered by label, or read an item's thread. On the empty-list
path they have *already performed the duplicate check* that the skill will perform again.

**What they do next.** Write two to six sentences of context, start the task, and go back to work.
They return when the task asks them to approve or revise — through the ordinary task attention
channel (the sidebar dot, the notification, the strip in this tab), not by waiting on this screen.

**Who it is not for.** A leader agent: it never opens the cockpit (owner rule, 2026-09-15, #439).
It uses the MCP path in § 11, which this design requires in the same PR.

## 4. Goals and non-goals

**Goals.**

1. One discoverable entry to file an issue, in the place the decision is made.
2. The person's own words reach the agent unchanged, and survive every failure on this screen.
3. It is never ambiguous that starting the task does not file the issue.
4. No new server capability: task APIs only.
5. The leader can do the same thing through the MCP, shipped together.

**Non-goals (deliberately not built).** Named here because a reader may expect them and will not
find them:

| Not built | Why |
| --- | --- |
| A form with title, body, labels and template fields | That is the skill's job, and a cockpit form would have to duplicate `.github/ISSUE_TEMPLATE/` parsing, label validation and the private-advisory routing. Two implementations of intake is exactly the drift this issue exists to remove. |
| Editing, closing, reopening, commenting or relabelling from the tab | The skill's boundary: one create per operation, never a mutation of an existing issue. The cockpit must not offer more than the procedure allows. |
| Create / Revise chips inside the GitHub tab | One question, one home. The thread's `AskCard` shows the exact body being approved; the tab cannot. |
| A "just filed" badge held in the browser | It would vanish on reload and would claim a list state the tab has not read. The stale-list strip says the true thing instead. |
| A `/github/new` route or a command-palette entry | The brief is one field and the person is mid-task. A second discovery path for a once-a-week action is not worth a route. |
| Picking a different skill under the New issue button | It would break the promise the label makes. Anyone who wants free choice already has the composer. |
| Any automatic filing — from the Inbox, from a failed run, at boot | Filing proposes work and always needs an authored brief. Nothing in this design starts a task without a person pressing a button. |
| Draft-only mode as a separate cockpit control | `draft-only` is an outcome the skill reports, not a mode the UI selects. A person who wants a draft says so in the brief. |

## 5. Screens and first read

Three pages in this folder: [`entry.html`](entry.html), [`states.html`](states.html),
[`phone.html`](phone.html).

**First read — what must be understood before anything is clicked.**

*In the tab:* that a control exists, that it belongs to this repository (the repo slug is already in
the header, one line above), and that it starts something rather than navigating. Achieved with a
button that reads **New issue** at the end of the tab row, not as a third tab.

*In the dialog, before scrolling or typing:* the destination (`qodeca/xezar`), the project, the
question being asked of the person, and the promise that nothing is filed yet. All four are above
the fold at 375 px, in that order: title → description → destination row → field label.

**Scanning many.** This design adds no new list. The issue list, its order, its grouping and its
row content are unchanged (`github.tsx`), and the existing forge search is what makes the empty
state a good place for the second entry. The only new repeated element is the draft strip, and
there is **at most one** per project — so there is nothing to sort, filter or search. If a future
change ever allows several drafts at once, the strip becomes a list and needs its own design.

**The distinction that matters most: starting is not filing.** In words, in this order of
prominence:

1. the dialog description — "Nothing is filed until you approve it";
2. the standing note above the footer — "**Starting is not filing.** The agent shows you the exact
   title, body and labels, then asks you to Create or Revise in the task";
3. the button label — **Start drafting**, never *Create* and never *File*;
4. the strip while it runs — "**Drafting an issue**".

No colour, tone or icon carries it. The `i-info` glyph on the note reinforces only.

## 6. States

Every state has its own sentence, and every one keeps whatever has been typed.

| State | Where | What it shows |
| --- | --- | --- |
| **Available, empty brief** | dialog | **Start drafting** disabled; the reason is visible text in the footer ("Describe the issue to start"), wired with `aria-describedby`. |
| **Available, brief typed** | dialog | The default in `entry.html` § 3. |
| **Starting** | dialog | Button becomes `Starting…` with the spinner; the textarea is disabled but readable and still full; Cancel is disabled. |
| **Start failed** | dialog | `role="alert"` above the footer, the server's own message, then "Your text is still here." The dialog does not close and the brief is not cleared. |
| **Skill unavailable** | dialog | The button still opens the dialog. A conflict-bordered note names the capability and what is lost with it — template intake, closed-issue duplicate search, the Create/Revise step — offers **Start an ordinary task** (the same text, plain `quick-task`) and **Manage skills**. `Start drafting` is disabled. Nothing is installed, downloaded or written. |
| **Hosted / remote mode** | dialog | Not a refusal — `POST /runs` is not gated on `capabilities.localHandoff`, so there is no 409 to render. One note: "**This cockpit runs in hosted mode.** The task runs on the machine hosting xezar and the issue is filed with that machine's GitHub login, not yours. Agent accounts are not offered here." The last sentence is existing behaviour: `agentProfile` is refused with 409 in hosted mode, so `EnginePills` renders without account rows. |
| **No `gh`, no auth, no remote** | whole tab | Unchanged: the existing `CenteredState` "GitHub is unavailable here" with the server's reason and **Try again**. **No New issue control** — the header that would carry it is not rendered, and there is no destination to name. See OQ-1. |
| **Loading** | whole tab | Unchanged skeleton; no control. A button naming a repository the cockpit has not read yet would be a guess. |
| **Tab error** | whole tab | Unchanged `CenteredState` "Could not load GitHub" with `list.error.message`. |
| **Running** | strip | Violet dot, pulsing; "**Drafting an issue** — searching for duplicates."; **View task →**. `role="status"`. |
| **Waiting on you** | strip | Amber dot; "**The agent is asking about the issue draft** — Create or Revise."; **Answer →**. The strong text is `--pending-strong`, never the soft `--pending`. |
| **Stale or partial** | strip | "**Issue #501 filed** — this list was synced before that, at 04:12." with **Refresh →**. The tab never claims a count it has not read. |
| **Empty list, nothing matched** | list | The existing empty text, then a rule and the second **New issue** entry. |

## 7. Copy deck

Sentence case, no trailing period on buttons and headings, `…` as one character, ` — ` as the
clause join, curly quotes around user text, no Oxford comma, no contractions, `xezar` lower case
(`docs/design-system/writing.md`).

| Key | String |
| --- | --- |
| `newIssue.button` | `New issue` |
| `newIssue.title` | `New issue` |
| `newIssue.description` | `An agent drafts the issue, searches open and closed issues for a duplicate and shows you the exact text. Nothing is filed until you approve it.` |
| `newIssue.destinationLabel` | `Destination` |
| `newIssue.projectLabel` | `Project` |
| `newIssue.briefLabel` | `What is the problem or the request?` |
| `newIssue.briefPlaceholder` | `Describe what happened, or what you want to change…` |
| `newIssue.briefHint` | `The agent asks for anything it still needs — reproduction, expected behaviour, the version.` |
| `newIssue.viewSkill` | `View skill` |
| `newIssue.note` | `Starting is not filing. The agent shows you the exact title, body and labels, then asks you to Create or Revise in the task.` |
| `newIssue.start` | `Start drafting` |
| `newIssue.startPending` | `Starting…` |
| `newIssue.cancel` | `Cancel` |
| `newIssue.shortcutHint` | `⌘↵ to start` (`submitShortcutHint()` supplies the platform form) |
| `newIssue.emptyBriefHint` | `Describe the issue to start` |
| `newIssue.keptHint` | `Your text is kept either way` |
| `newIssue.startError` | `Could not start the task — {reason}. Your text is still here.` |
| `newIssue.toast` | `Added to the queue — issue draft` |
| `newIssue.skillMissing` | `The issue-create skill is not installed in this project. An ordinary task can still be started with your text, but without the skill there is no template intake, no duplicate search across closed issues and no Create or Revise step before the issue is filed. xezar installs nothing on its own.` |
| `newIssue.skillMissing.plain` | `Start an ordinary task` |
| `newIssue.skillMissing.manage` | `Manage skills` |
| `newIssue.hosted` | `This cockpit runs in hosted mode. The task runs on the machine hosting xezar and the issue is filed with that machine's GitHub login, not yours. Agent accounts are not offered here.` |
| `newIssue.emptyList.lead` | `An agent can draft one, check for duplicates once more and show you the text before it is filed.` |
| `draftStrip.running` | `Drafting an issue — searching for duplicates.` |
| `draftStrip.running.link` | `View task →` |
| `draftStrip.waiting` | `The agent is asking about the issue draft — Create or Revise.` |
| `draftStrip.waiting.link` | `Answer →` |
| `draftStrip.stale` | `Issue #{n} filed — this list was synced before that, at {time}.` |
| `draftStrip.stale.link` | `Refresh →` |

Two strings are **not** ours and must not be rewritten: the tab's own
`GitHub is unavailable here` explainer and the provider gate
`Connect an agent provider to run this item.` / `Configure providers` in `hand-to-agent.tsx`.

## 8. Component mapping and tokens used

Everything below exists today. Nothing in this design proposes a new primitive or a new token.

| Surface | Reuse | Source |
| --- | --- | --- |
| The button | `Button` `variant="outline"` `size="sm"`, `PlusIcon` | `components/ui/button.tsx` |
| The dialog | `Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter` | `components/ui/dialog.tsx` |
| The brief box | `Textarea`, `aria-label`, `aria-keyshortcuts="Control+Enter Meta+Enter"` | `components/ui/textarea.tsx`, pattern from `hand-to-agent.tsx:311` |
| The backend pills | `EnginePills` with `accounts`, `useResolvedEngine`, `engineRunBody` | `components/engine-pills.tsx` |
| Provider gate copy and link | the `gh-provider-gate` block, lifted as-is | `hand-to-agent.tsx:270` |
| The skill chip | the `source-tag project` grammar; **View skill** opens `SkillPreviewDialog` | `components/skill-detail.tsx` |
| The strip's dot and tone | `deriveAttention(run)` → bucket `running` / `waiting`; `StatusDot` | `lib/attention.ts` |
| The strip's link | `Link` from `lib/project-router` | `lib/project-router.tsx` |
| Confirmation | `toast(...)` | `components/ui/toaster.tsx` |
| Tab row | `TabLink`, unchanged | `components/tab-link.tsx` |
| Empty state text | the existing `gh-empty` block, extended | `github.tsx:571` |
| Draft persistence | the same store the hand-off box uses, under its own key | `routes/github/hand-to-agent-draft.ts` |

**Tokens used** (all from `index.css` via `cockpit.css`; none added):
`--background`, `--card`, `--card-2`, `--border`, `--foreground`, `--muted-foreground`,
`--soft-foreground`, `--primary`, `--violet`, `--pending`, `--pending-strong`, `--conflict`,
`--danger`, `--success`, `--radius`, `--radius-sm`, `--radius-lg`, `--mono`, `--sans`,
`--shadow-modal`, and the rhythm scale `--spacing`, `--spacing-row`, `--spacing-stack`,
`--spacing-list`, `--spacing-inset`, `--spacing-group`, `--spacing-section`.

**One local class is a reproduction, not a proposal.** `styles.css` § 4 (`.ask-demo`) reproduces
the shipped `AskCard` so the states page can show the question this design hands off to.
`cockpit.css` has no base class for it. Nothing in the cockpit changes for it; if the shared sheet
ever grows an `.ask-card`, delete the block.

## 9. Developer notes

**Files a developer will touch.**

| File | Change |
| --- | --- |
| `packages/web/src/routes/github/github.tsx` | The tab-row action, the empty-state second entry, the draft strip, and the state that remembers which run is the current draft. |
| `packages/web/src/routes/github/new-issue-dialog.tsx` | **New.** The dialog: brief, destination, engine pills, the four notes, the start mutation. Modelled on `hand-to-agent.tsx`. |
| `packages/web/src/routes/github/new-issue-draft.ts` | **New**, or a second key in `hand-to-agent-draft.ts`: the brief survives close, reload and a failed start. |
| `packages/web/src/routes/github/github.test.tsx` | The component assertions in § 12. |
| `packages/xezar/src/mcp/tools/task-create.ts` | No change expected — verify and pin instead (§ 11). |
| `docs/design-system/*` | Only if a token, primitive or shared component changes. This design needs none. |

**Data.**

- Skill availability: `useSkills()` → is there a skill named `xezar-issue-create`? Use the name,
  never a path: a project skill shadows a global one and both are valid.
- Destination: `gh.repo` from the tab's existing payload. Project: the route's `projectId`.
- Hosted mode: `useHealth().data.capabilities.localHandoff === false`.
- The current draft run: store its id the way `queuedRunId` is stored for hand-off, then read the
  live record from the runs cache and derive the strip's bucket with `deriveAttention`. Do **not**
  add a poll — the global SSE stream already patches the cache.

**The start call.** Exactly one shape, and it is the composer's:

```ts
createRun({
  task: brief,
  source: { source: 'skill', ref: 'xezar-issue-create' },
  ...engineRunBody(resolved),
})
```

No `autonomous: true` — ever. An autonomous run skips the review gate and the owner rule is that a
brief, not a flag, authorises filing; an interactive run is what makes Create / Revise reachable.
No `worktree: false`: filing needs no checkout of its own and the default is correct.

**What must not happen.** No `PUT`/`POST` that mutates an issue. No new route on the server. No
client-side `gh` call. No writing of skill content, no install prompt that writes anything.

## 10. Accessibility

The bar is `.xezar/skills/xezar-ux-design.md` point 7, and it is not optional.

- **New issue** is a real `<button>` in the tab row, reached by Tab directly after the two tabs.
- Opening moves focus into the brief textarea; closing returns focus to the opening button. The
  shipped `Dialog` does both — do not override `onCloseAutoFocus`.
- Escape closes and the brief survives, because it is in the draft store, not component state.
- ⌘/Ctrl+Enter starts from inside the textarea (`aria-keyshortcuts`), as the hand-off box does; a
  bare Enter inserts a newline.
- Every control is labelled: the textarea by its `<label>`, the icon-only refresh by `aria-label`.
- The disabled **Start drafting** carries a visible reason linked with `aria-describedby`, never a
  `title` alone.
- The draft strip is `role="status"` — announced politely on appearance and on change, never
  stealing focus. The changed issue count after a refresh is announced the same way.
- A failed start is `role="alert"` inside the dialog, above the footer.
- Meaning is never in colour alone: each strip sentence names its state with the dot removed, and
  amber text is `--pending-strong` (the soft `--pending` fails contrast as text in light).
- Both themes work through tokens; no `dark:` variant, no raw hex.
- Verified in a real browser per `docs/testing/agent-browser.md` at 375 px and at desktop width, in
  both themes, before the implementation PR merges. **Not verified in this design change** — see
  § 19.

## 11. MCP parity

Owner rule, 2026-09-16: a capability the cockpit gains must be reachable by the leader. The
implementation PR ships both halves or neither.

The tool already exists and needs **no new action**. The leader's equivalent of pressing
**New issue** and typing a brief is:

```json
{
  "tool": "task_create",
  "action": "start",
  "operationId": "<client-generated, 8–128 chars>",
  "prompt": "<the filing brief, in the leader's own words>",
  "source": { "source": "skill", "ref": "xezar-issue-create" }
}
```

Parity rules the implementation PR must hold:

1. **Same skill name, same project, same defaults.** Omitted options resolve as the composer
   resolves them; `task-create.ts` mirrors that on purpose and `task-create.test.ts` proves it.
2. **Same authority.** `task_create` with a skill source is *not* a filing grant — the shared skill
   says so in step 1 and the local wrapper repeats it. What authorises autonomous filing is the
   brief naming the issue to file. The button and the tool are identical in this respect.
3. **No new MCP issue tool.** Non-goal 7 of the analysis, and the contract note forbids it.
4. **The refusal shapes match.** If the skill is missing, both paths say so and file nothing: the
   dialog with its note, the tool by the task reporting `draft-only` with the reason.
5. **Documentation.** `docs/features/mcp-server/mcp-api.md` is regenerated only if a tool changes;
   if it does not, the parity is recorded in the PR body and in a `task_create` test, not by
   editing the generated file.

## 12. Acceptance criteria and test expectations

From **IF-14**: *"If the optional UI is accepted, New issue starts the scoped skill task and
preserves the brief; it does not directly file an issue."* Falsifiers: wrong project or skill, lost
draft, missing unavailable-skill explanation, or direct issue mutation.

| # | Criterion a tester can check | How |
| --- | --- | --- |
| AC-1 | **New issue** appears in the GitHub tab on both the Issues and the Pull requests view when the tab is available. | Component test; browser QA. |
| AC-2 | Pressing it opens a dialog naming the destination repository and the project. | Component test asserts the repo slug from the payload is rendered. |
| AC-3 | Starting posts exactly one `POST /runs` with `source: {source:'skill', ref:'xezar-issue-create'}`, `task` equal to the typed brief byte for byte, and **no** `autonomous: true`. | Component test on the captured request body. *(IF-14 falsifier: wrong skill.)* |
| AC-4 | No request is made to any issue-mutating route, on any path through the dialog. | Component test asserts the fetch mock saw only `/runs`; route inventory shows no new route. *(IF-14 falsifier: direct mutation.)* |
| AC-5 | The task is created in the project the route is scoped to. | Component test under `/p/<other>/github` asserts the scoped URL. *(IF-14 falsifier: wrong project.)* |
| AC-6 | Closing the dialog, reloading the page, or a failed start all leave the brief intact. | Component test: type → close → reopen; type → failed mutation → assert the value. *(IF-14 falsifier: lost draft.)* |
| AC-7 | With no `xezar-issue-create` in `useSkills()`, the dialog still opens, shows the explanation, keeps the brief, disables **Start drafting** and offers an ordinary task. | Component test with the skill removed from the fixture. *(IF-14 falsifier: missing explanation.)* |
| AC-8 | The ordinary-task fallback posts the same brief with **no** `source`. | Component test on the body. |
| AC-9 | With `capabilities.localHandoff === false` the control still works and the hosted sentence is rendered; no 409 is expected or handled. | Component test with a hosted health fixture. |
| AC-10 | With `gh.available === false` no **New issue** control exists anywhere in the tab. | Component test asserting absence. |
| AC-11 | While the tab is loading or errored, no **New issue** control exists. | Component test asserting absence. |
| AC-12 | A running draft shows one strip with `role="status"`; when the run enters `waiting` the sentence and the link verb change. | Component test driving the run record through both states. |
| AC-13 | Keyboard: Tab reaches the button after the tabs; Enter opens; focus lands in the textarea; Escape closes and returns focus; ⌘/Ctrl+Enter starts. | Browser QA, both themes. |
| AC-14 | Nothing scrolls sideways at 375 px in either theme, and the action and dialog buttons are at least 44 px tall. | Browser QA at 375 px per `docs/testing/agent-browser.md`. |
| AC-15 | The MCP call in § 11 starts the same task with the same skill and project. | `task-create` test; the PR records one real leader call. |

**Red-proof requirement.** Each new assertion must be shown failing against a named break before it
is accepted — the repository's rule in `AGENTS.md` § "Prove the regression test fails without the
fix". Suggested breaks: drop `source` from the body (AC-3), hard-code `projectId` (AC-5), clear the
draft on close (AC-6), render the dialog unconditionally when the skill is missing (AC-7).

## 13. Responsive and what gets cut

Below `md` the GitHub tab's list pane **is** the page. Cut order, tightest first:

| At | What goes | What never goes |
| --- | --- | --- |
| Narrow desktop pane (360 px) | The `synced Nm ago` chip truncates first, as today. | The tab counts, the **New issue** button, the search box. |
| < 768 px | **New issue** leaves the tab row and becomes a full-width 44 px row beneath it — two tabs plus a button cannot share 375 px without truncating a count, and a truncated count is a wrong number. The draft strip's link wraps to its own full-width line. | The button itself, its label (never icon-only: an icon-only `+` in a tab row reads as "add a tab"), and the strip's sentence. |
| Dialog < 640 px | The footer stacks in `column-reverse` — the shipped `DialogFooter` rule, unchanged — so **Start drafting** is the top of the stack and **Cancel** is under it, and the `⌘↵` hint drops to the bottom of the stack where it is out of the way. | The destination row, the brief, the standing note. |
| 375 px | The engine pills wrap onto their own line; the destination row wraps label-above-value. | Nothing else. No horizontal scroll anywhere. |

## 14. Worst case, measured

| Dimension | Number | Source |
| --- | --- | --- |
| Longest issue list the tab renders | 45 open issues in `qodeca/xezar` today; the fetch cap is `LIST_LIMIT = 1000` | `gh issue list --state open`, 2026-09-16; `github.tsx:90` |
| Longest issue title in that list | 140 characters | measured over the 45 open issues, 2026-09-16 |
| Longest destination slug the dialog may print | 140 characters (GitHub's 39-character owner + `/` + 100-character repo) | GitHub's own limits; assumption, not measured here — the row wraps with `overflow-wrap: anywhere` so it cannot overflow |
| Longest brief the field must accept | 100 000 characters — the contract's `task` bound | `packages/contract/src/runs.ts:744` |
| Realistic brief | two to six sentences, roughly 200–900 characters; the box shows about 6 lines before it scrolls | assumption from the existing hand-off box's usage |
| Slowest state on this screen | the `POST /runs` round trip — sub-second locally; the button shows `Starting…` for its whole duration and the dialog never closes optimistically | assumption; measure during browser QA |
| Slowest state the strip covers | the duplicate search inside the task: `gh issue list --state all` over 45 open plus several hundred closed issues, plus the agent's own reading — minutes, not seconds. This is why the strip exists rather than a spinner in the dialog. | assumption; the task is an ordinary task and is watched like one |
| Narrowest width | 375 px, both themes | `docs/design-system/new-designs.md` § 6 |

## 15. Open decisions

Full text and a recommendation for each is in [`open-questions.md`](open-questions.md).

| # | Question | Recommendation |
| --- | --- | --- |
| OQ-1 | Should **New issue** appear when GitHub is unavailable, offering the skill's local-draft fallback? | **No.** Keep the tab's explainer; the composer already reaches that path. |
| OQ-2 | Should the dialog offer a **Draft only** choice, or stay one path? | **One path.** `draft-only` is an outcome, not a mode. |
| OQ-3 | Does the draft strip belong in the GitHub tab only, or in the shell? | **GitHub tab only** for this PR. |
| OQ-4 | Should the empty-state entry pre-fill the brief with the search text? | **Yes**, as the first line, editable. |
| OQ-5 | Is `qodeca/xezar` always the destination, or should the dialog offer a repository picker? | **Always the tab's repository.** No picker. |
| OQ-6 | Do the engine pills belong in this dialog, or should it inherit the project default silently? | **Keep them.** Parity with the hand-off panel. |

**Departures from the design system.** One, recorded here as the rules require: `styles.css` § 4
(`.ask-demo`) is a static reproduction of the shipped `AskCard`, added because `cockpit.css` carries
no base class for it. It changes nothing in the cockpit and proposes no new component. There are no
other departures — no new token, no new primitive, no new pattern, no badge in a new colour.

## 16. Delivery plan

1. This design folder and its review (**this PR**, `needs-design`, mockups only).
2. Owner answers OQ-1 … OQ-6; the design review verdict lands as a `## Design review` PR comment
   and § 19 links it.
3. The implementation PR, after PR 2 (`.xezar/skills/xezar-issue-create.md`, #493) has merged:
   the cockpit surface **and** the MCP parity assertions together, with red-proof evidence for every
   new assertion, plus browser QA at 375 px in both themes.
4. Documentation follows the merge, never before it (`docs/features/issue-filing/`).

## 17. Risks

| Risk | Mitigation |
| --- | --- |
| A person reads **New issue** as "file it now" and is surprised by the question. | Four separate statements say otherwise, starting with the button label. Browser QA should watch for anyone pressing Start and then leaving. |
| The skill is renamed upstream and the button silently loses its skill. | The lookup is by name, so a rename degrades to the unavailable state, which explains itself. A test pins the name; the wrapper pins the upstream revision (`b2308e9`). |
| The strip and the sidebar attention dot disagree about the same run. | Both derive from `deriveAttention`. Nothing else maps a status to a word or a colour (design system rule 7). |
| Several drafts at once race to file the same issue. | The contract is explicit that receipts are not a cross-task lock. The design allows one strip; the skill re-checks immediately before creating. Filing keeps one owner. |
| Hosted mode files issues under the host's login without the person realising. | Said plainly in the dialog. It is the only hosted-mode difference that matters here. |
| This design is judged as approval to implement. | It is not. A design review approves a design; the implementation PR is separate and carries its own gates, QA and review. |

## 18. References

- Tracking issue: [qodeca/xezar#468](https://github.com/qodeca/xezar/issues/468) — stays open.
- Consumer boundary: `docs/features/issue-filing/xez-issue-create-contract.md`.
- Owner's analysis and IF-01…IF-14: the spec attached to #468 (private working copy; not a
  dependency of this folder).
- Local wrapper: `.xezar/skills/xezar-issue-create.md` in PR #493 (branch `xez/81153ea1`).
- Shared procedure: `qodeca/xezar-skills`, `skills/xez-issue-create/`, pinned revision `b2308e9`,
  read 2026-09-16.
- Design system: `docs/design-system/README.md` and, for this folder, `new-designs.md`,
  `patterns.md`, `components.md`, `writing.md`, `known-gaps.md`.
- Surfaces read: `packages/web/src/routes/github/github.tsx`,
  `packages/web/src/routes/github/hand-to-agent.tsx`,
  `packages/web/src/routes/task-thread/ask-card.tsx`, `packages/web/src/lib/attention.ts`,
  `packages/xezar/src/mcp/tools/task-create.ts`.

## 19. Design review

Pending.
