# Patterns

How the components compose into pages. Each pattern names its source, its rule for new work, and the
copy it uses. Where the codebase does the same thing two ways, the rule is the most common form (or the
newest when usage is split) and the alternatives are listed in [known-gaps.md](known-gaps.md).

## 1. App shell

Source: `packages/web/src/app.tsx`, `packages/web/src/components/app-shell.tsx`, `packages/web/src/routes.tsx`.

- Provider order: `QueryClientProvider → GlobalEventsProvider → RunNotifications → ThemeProvider → AppearanceProvider → BrowserRouter → LastLocationController → ReferenceStatusRegistry → AppShellContainer → RouteErrorBoundary → routes`, with one `<Toaster/>` beside the shell.
- Grid: `h-dvh`, four rows (mobile top bar · banner · `<main>` scroller · composer row). The document never scrolls.
- Every view lives under `/p/:projectId/`. Flat legacy paths redirect to the boot project. Global settings sit at `/settings/global`. Unknown project ids render `UnknownProjectRoute`; unknown paths render `NotFoundRoute`.
- Lazy routes each ship a sibling `*-loading.tsx` fallback that never imports from the lazy chunk.
- Document title grammar (`lib/use-document-title.ts`): `"{project} — {page} · xezar"`, `"{project} · xezar"`, `"{page} · xezar"`, else `"xezar"`. A task page uses the run title as the page label.
- The scroller resets to the top on route change except on `/tasks/:id`, where the thread owns arrival.

Rule: a new page is a route under the project scope, rendered inside `<main>`, with its own `*-loading.tsx`
when lazy. It never adds a provider above the shell.

## 2. Sidebar navigation and badges

Source: `components/app-shell.tsx`, `components/nav-items.ts`, `components/project-groups.tsx`.

The sidebar is navigation only (#546), on the desktop and in the phone drawer. Tasks are listed,
searched, sorted and pinned on the Tasks pages (§4), never in the sidebar.

- Order: brand row (`xezar` + repo chip; on a development build the tile carries the red "D" badge, decisions.md D-08) → `New task` (`contrast` button with a `kbd` C) and `Add project` → nav (`NAV_ITEMS`, `<nav aria-label="Main">`, which fills the column and scrolls on a short window) → footer, one row (`sidebar-footer-controls`): Tools menu · version chip · Global settings · theme toggle. There is no search launcher; ⌘K / Ctrl+K opens the palette from the keyboard (§7).
- Nav item: icon `size-4`, label `text-[13.5px] font-medium`, row `h-11 md:h-9 rounded-md px-2.5`; active `bg-muted font-semibold text-foreground` and `aria-current="page"`.
- Badges: a violet count (`rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground`) means "a person is wanted" (Inbox count, unread finished tasks). A `size-1.5` violet dot with `sr-only` text marks a Skills update. No badge while the count is unknown; none at zero.
- Multi-project: from the second registered project the flat nav becomes a pinned `All tasks` link (to the global Tasks page) above collapsible project groups. Each group is a header (chevron · name · waiting/review count badge · branch) and a body with that project's own nav only. Collapsed groups are remembered in `localStorage` (`xez-sidebar-collapsed`); the sidebar width (264–420 px) in `xez-sidebar-width`.

Rule: add a nav item by adding a row to `NAV_ITEMS` with a `match` list and, if gated, a capability flag.
Never add a nav link in the shell or the palette by hand.

## 3. Page headers

Source: `routes/tasks-overview.tsx`, `routes/global-tasks.tsx`, `routes/inbox.tsx`, `routes/skills.tsx`,
`routes/workflows/workflows.tsx`, `routes/settings/settings-shell.tsx`.

The rule (8 of 14 headers):

```
<header class="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background md:flex md:px-section">
  <h1 class="text-base font-semibold">Tasks</h1>
  <p class="text-[13px] text-muted-foreground">Markdown playbooks agents can follow.</p>
  …actions, tabs, a 240px search…
</header>
```

- Hidden below `md` because the shell's mobile top bar already names the page.
- The body below it is `flex flex-1 flex-col p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-section md:pb-section`, so the body starts `section` under the header and the title lines up with the content (`decisions.md` D-03).
- Variations that exist (G-01): the Git and GitHub pages use `bg-background/95 backdrop-blur` with `text-lg`; the run header is `text-[15px]` and sticky only from `md`; `/new` centres an `h1 text-lg`; Compare uses `text-xl`; Automations uses `text-2xl` inside a `max-w-6xl` frame.

## 4. Lists, cards and tables

Source: `routes/tasks-overview.tsx`, `routes/global-tasks.tsx`, `lib/task-columns.ts`, `lib/tasks-table.ts`,
`lib/task-groups.ts`, `lib/read-state.ts`.

- The desktop task table is driven by `TASK_COLUMNS` (`lib/task-columns.ts`): `Status, Task, Workflow, Tool name, Model, Branch, ±, Ref, IN / OUT, Cost, CPU, Mem, Started`. Header, `colgroup` and every row consume that list. A new column is three coordinated additions there.
- Wrapper `hidden overflow-x-auto rounded-lg border border-border bg-card shadow-xs md:block`; header cell `TASK_TH_CLASS` (`h-10 px-3 text-[11px] font-semibold tracking-[0.05em] uppercase text-soft-foreground`) and body cell `TASK_TD_CLASS` (`h-11 px-3 whitespace-nowrap`), both from `lib/task-columns.ts` and rendered by both tables through `TaskTh` and `UsageTd`; last row loses its bottom border; row `cursor-pointer hover:bg-muted` with clicks on `a, button, input` passing through. Foldable columns collapse to `42px` with an `aria-pressed` toggle in the header.
- Below `md` the same rows render as cards, `gap-list` apart: `rounded-lg border border-border bg-card p-inset shadow-xs`, a mono meta line (`workflow · tool · model · branch · diff · tokens · cost`) and an always-visible pin. The global Tasks page renders the same card (`GlobalTaskCard`) with its project link, reference chips and read/archive actions. A tap on the card opens the task; a tap on a nested link or button does only its own job.
- Phone targets: every control in a card, a row and the phone toolbar is 44 px at every density (`min-h-tap … md:min-h-0`). A 24 px reference chip sits on a 44 px line (`CHIP_SLOT`) and carries a 44 px `::before` hit area, so neighbouring chips never overlap. The card title link grows to 44 px with a negative top margin, so the card does not grow.
- Phone toolbar: below `md` the header is hidden, so both Tasks pages render its controls at the top of the body – the Active/Archived tabs (`ListViewTabs`), the page actions or the count, and the search (`SearchField`).
- Unread finished rows are `font-semibold text-foreground` with a trailing violet dot (`aria-label="unread"`, `title="Unread — not opened since it finished"`); read-done rows are `font-medium text-muted-foreground`.
- Cards elsewhere: `rounded-lg border border-border bg-card` (+ `shadow-xs` when raised, `p-inset` inside, `gap-list` between cards) is the spelling. The footer strip under a table sits `mt-list` below it. The `Card` primitive is unused (G-02).
- Group headings on `/tasks`: `text-[12px] font-semibold tracking-[0.04em] uppercase text-soft-foreground` with a mono count.
- Absent values print `—`; never a fabricated `0` or `$0.00`.

Rule: the task table goes through `task-columns.ts`; a cell that shows a runner or model goes through
`task-agent.tsx`; any other table uses `TASK_TH_CLASS` and `TASK_TD_CLASS` rather than copying them.

## 5. Status

Source: `lib/attention.ts`, `components/status-dot.tsx`, `components/pill.tsx`,
`routes/task-thread/step-rail.tsx`, `lib/reference-status.ts`.

`deriveAttention(run)` is the single derivation. First match wins:

| Run state | Bucket | Tone | Pulse | Label |
| --- | --- | --- | --- | --- |
| failed with `autoResumeAt` | none | pending | no | `scheduled` |
| failed | error | danger | no | `failed` |
| waiting | waiting | pending | yes | `needs you` |
| review | waiting | violet | yes | `needs review` |
| running, activity monitoring | running | violet | yes | `monitoring` |
| running | running | violet | yes | `running` |
| queued | none | neutral | no | `queued` |
| done | none | success | no | `done` |
| anything else | none | neutral | no | `cancelled` |

(`permission` and `unseen` buckets exist in the type and are never produced today.)

- Rendered as `<Pill dot={tone} pulse={pulse}>{label}</Pill>`: neutral chip, coloured 7px dot, lower-case label. A queued run appends ` #n`.
- Step rail: `CircleCheckIcon text-success` (done), `LoaderCircleIcon animate-spin stroke-pending motion-reduce:animate-none` with `role="status" aria-label="Step running"` (active), `CircleXIcon text-danger` (failed), `CircleIcon text-soft-foreground` (pending); a `h-0.5 bg-muted` progress bar with a `bg-pending` fill.
- References use their own vocabulary (`lib/reference-status.ts`): sentence-case label + lower-case hint, tones `success | danger | violet | info | neutral | pending | conflict`, composed as `Label — hint`.

Rule: never write a status colour by hand. Derive it, then render it through `StatusDot` (or a
`ReferenceChip` for a PR or issue). Colour is reinforcement; the word carries the meaning.

## 6. Empty, loading and error states

Source: `components/centered-state.tsx`, the six `*-loading.tsx` routes, `components/ui/toaster.tsx`.

| State | Rule | Example (quoted from the code) |
| --- | --- | --- |
| Empty | `CenteredState` with a lucide icon, a fragment title and a sentence subtitle that names the next action or the mechanism. `tone="primary" backdrop` only for the first-task hero. | "No tasks yet" / "Describe a task to get started." (`tasks-overview.tsx`) |
| Filtered to nothing | `CenteredState` quoting the needle. | "No matching tasks" / "No tasks match “fix”." |
| Feature off | `CenteredState` saying what is off and the env var that turns it on. | "The follow-up inbox is off" / "Agents are not asked to leave follow-ups. Set XEZ_FOLLOWUPS=1 and restart xezar to turn the inbox on." |
| Loading a page | `CenteredState` with `<LoaderCircleIcon className="motion-safe:animate-spin"/>`, "Loading X…" and a "Fetching …" subtitle. | "Loading task…" / "Fetching the run and its session transcript." |
| Loading inside a surface | one muted line, `px-4 py-6 text-center text-xs text-soft-foreground`. | "Loading changes…" |
| Load error | `CenteredState tone="danger"` with `TriangleAlertIcon`, a cockpit-written title and the server message as subtitle. | "Could not load this task" / `{error.message}` |
| Mutation error | `toast(error.message, { tone: 'danger' })`. | – |
| Inline validation | a sibling `<p class="text-[11px] text-danger">`; when valid the same slot holds a `text-soft-foreground` hint. | "Enter a whole number from 1 to 60 minutes." |
| Refusal (hosted mode 409) | neutral tone, the server's own sentence, and who can act. Actions with no honest disable reason are hidden, not disabled. | "Agent accounts are managed from the machine that owns the checkout — this cockpit runs in hosted mode." |
| Not found | `CenteredState` + `Back to tasks` outline button. | "Task not found" / "No run has this id. It may have been deleted, or the link is from another machine." |
| Page crashed | `RouteErrorBoundary` (`role="alert"`, "Try again"). | "This page could not be displayed." |

A list shows nothing at all until its data has answered; it never shows a false "No tasks yet".

## 7. Dialogs, sheets, command palette, toasts and notifications

- **Confirm (destructive)**: `AlertDialog`. Title as a question naming the object, body with the consequence and `There is no undo.` when true, footer `AlertDialogCancel` "Keep it" then a danger-tinted `AlertDialogAction` repeating the verb ("Delete", "Remove from list", "Cancel the run"). Success toast in one sentence.
- **Form dialog**: `Dialog` with title, description, the form, footer `outline` "Cancel" then the primary action, ⌘↵ / Ctrl+↵ submits. Model: `routes/task-git/commit-dialog.tsx` ("Commit changes" / "Committing…").
- **Footer order**: cancel first in DOM, confirm last; the primitive renders cancel-left / confirm-right from `sm:` and confirm-on-top on a phone.
- **Sheet**: left for navigation (mobile drawer), right for a drill-down (sub-agent sheet).
- **Command palette**: ⌘K / Ctrl+K anywhere, from the keyboard only (no visible launcher); on close, focus returns to the element that held it, else the phone top bar's menu button; `c` or ⌘N opens `/new`; groups in the order Recently finished · Views · Projects · Tasks · Actions · Skills.
- **Toasts**: top-right, 5 s, `default` or `danger` tone, one sentence. Success toasts may or may not end with a period today (G-16); new toasts end without one unless they are a full sentence with a clause.
- **Copy to clipboard**: through `copyText` (`lib/clipboard-result.ts`), which answers a refusal instead of throwing. Success is a fragment ("Command copied", "Worktree path copied"); a refused or missing clipboard never says copied – the toast carries the payload instead ("Run manually: {command}", "Path: {path}"). The task thread and the review panel use it.
- **Browser notifications**: off by default; fired only for a status change into `needs you`, `needs review` or `failed` while the tab is hidden; body `Task needs you`. Permission is requested on enable only.

## 8. Settings and forms

Source: `routes/settings/settings-shell.tsx`, `routes/settings/settings-field.tsx`, `routes/settings/registry.tsx`,
`routes/settings/appearance.tsx`, `routes/settings/resources-section.tsx`, `routes/settings/agents-section.tsx`.

- Shell: desktop left nav `hidden w-52 … border-r border-border p-stack md:flex` (`aria-label="Settings sections"`), items `rounded-md px-2.5 py-2 text-[13px] font-medium`, active `bg-muted text-foreground`; on phone a horizontal pill row, active pill `bg-contrast text-contrast-foreground`. Sections come from `SETTINGS_SECTIONS` with `scope` `project | global`.
- Field: `SettingsField({ title, hint, children })` → `<section class="flex flex-col gap-stack"><h2 class="text-sm font-semibold">` + `<p class="text-[13px] text-muted-foreground">` + control. Every section renders through it; do not declare a private copy. A pane lists its fields flat in `flex flex-col gap-section` (foundations.md §4.1).
- Save behaviour, by control: selects and switches save on change and may toast the new state; textareas and numeric inputs keep a local draft and an explicit `Save` button disabled while unchanged; the table column folds write optimistically with a keepalive PUT.
- Controls: `Input`, `Textarea`, `Switch`, raw `<select>`/`<input>` fields wearing `nativeFieldClass` (see Input in components.md), `Segmented` radio groups (`role="radiogroup"`, `rounded-md border border-border bg-card p-0.5`, checked `bg-muted text-foreground`; each segment `min-h-tap min-w-tap md:min-h-0 md:min-w-0` with the shared `focus-visible:ring-[3px]` ring).
- Phone targets: below `md` every settings target is at least 44 × 44 px at every density – the section pills, segments, text links (`inline-flex min-h-tap … md:min-h-0`, including links inside a sentence), a checkbox through its `<label>`, and settings chips (`min-h-tap md:min-h-chip`). `e2e/design-debt-b3.e2e.ts` measures every settings route and its open dialogs.
- Sentinels are spelled out in the hint (`0 = unlimited`, `Leave empty for no limit.`).
- Danger zone: `Remove` in `text-danger` (wrapping inside the button when the name is long), confirmed by an `AlertDialog` whose action wears `buttonVariants({ variant: 'danger' })`, whose cancel reads `Keep it`, and whose header is `min-w-0` so a long path cannot widen it. A confirm opened from state returns focus to its opener through `useReturnFocus` (`routes/settings/remove-project.tsx`).

## 9. The mobile drawer

Source: `components/app-shell.tsx`.

- Below `md` the sidebar is a `Sheet side="left"` at `w-[264px] bg-sidebar p-0`, opened by a real `SheetTrigger` in the top bar (`aria-label="Open menu"`, `size-11`) and closed by `aria-label="Close menu"`.
- It closes on route change and the moment `(min-width: 768px)` matches.
- It renders the same sidebar content as the desktop column, so it is navigation only: brand row, New task (+ Add project), nav or project groups, footer.
- The top bar titles itself from `activeNavItem(pathname)`.
- Touch targets are 44px (`h-11`, `size-11`); desktop rows relax to `md:h-9`. The footer's Tools trigger is `min-h-tap … md:min-h-0`.

## 10. Live updates

Source: `api/global-events.tsx`, `api/ws.ts`, `api/queries.ts` (`useHealthSubscription`), `lib/use-now.ts`.

- One `EventSource` on `/api/v1/workspace/events` for the app's life. Events `run`, `run-deleted`, `todos`, `usage`, `ping`, plus workspace events. A `run` event patches the runs list in place; the detail cache is merged only if already present; a `run-deleted` removes caches so a mounted page refetches into the 404.
- Reconcile (invalidate runs, index, todos, health, worktrees, provider status, the MCP leader status) on every reconnect, on `visibilitychange` to visible and on bfcache `pageshow`. A closed stream reopens after 3 s.
- One WebSocket on `/api/v1/ws`, opened on the first `subscribeTopic` and closed when no topic is held. Two topics today, both only when `capabilities.localHandoff` is true: `health`, session-global, subscribed once at the root; and `mcp-leader`, view-level, subscribed by Settings → MCP connection's leader control while it is on screen (`useMcpLeaderSubscription`). Remote mode opens no WebSocket.
- What "live" looks like: `StatusDot pulse`, `.shimmer` on the running tool verb and "Working…", a `LoaderCircleIcon` tail on a running thread, live CPU/Mem cells tinted `bg-violet/5`, animated diff totals. There is no connection-status chip.
- Backstops: the cross-project index polls every 15 s; ages tick with `useNow(30_000)`.

Rule: a new live signal is a WebSocket topic subscribed at the scope that matches its demand
(view-level in the view, session-global once at the root), never a `refetchInterval`. Patch the query
cache in place; the reconciling refetch is the source of truth.

## 11. The task thread

Source: `routes/task-thread/` (`run-header.tsx`, `thread-items.tsx`, `agents-dock.tsx`, `plan-dock.tsx`,
`step-rail.tsx`, `review-panel.tsx`, `ask-card.tsx`, `thread-scroller.tsx`, `task-thread.tsx`),
`components/composer/composer.tsx`, `components/tools-menu.tsx`.

- Phone targets: below `md` every thread control is at least 44 × 44 px at every density – the run header's details toggle, agent badge, resume hint and title pencil, the Agents and Plan dock headers and agent rows, the workflow summary, tool cards, context groups, tool streaks and the output toggle, message edit/remove and Cancel/Save, ask options, the review panel's links, the footer's PR and issue links, the history loader and the jump pill. Rows spell it `min-h-tap … md:min-h-<desktop>`; icon buttons add `min-w-tap … md:min-w-0`. `e2e/design-debt-b5.e2e.ts` measures every surface at all four densities.
- Hover-revealed actions (the title pencil, a message's edit and remove, the attachment remove mark) also carry `no-hover:` so a touch device sees them, and grow to 44 px there (`no-hover:min-h-tap no-hover:min-w-tap`). Keyboard focus reveals them with the focus ring.
- The jump pill is anchored by its bottom edge above the dock (`bottom-full pb-4`), so a taller phone pill never covers a dock header.
- Motion: every spinner is `motion-safe:animate-spin`; pulsing glyphs carry `motion-reduce:animate-none`; the dictation light is `StatusDot pulse`.
- The destructive run confirm follows §7: `buttonVariants({ variant: 'danger' })` and "Keep it".
- Rendered Markdown's code-block copy and download buttons come from the Markdown library and are below 44 px (G-36).
