# Known gaps

Every place where the cockpit does the same thing more than one way, or where a comment and the code
disagree. Found while inventorying `packages/web/src` on 2026-09-13, and **reconciled in full on
2026-09-17** at the end of the #453 design-debt series (batch B8). For each gap: what differs, where,
which form is the rule for new work and why, and the proposed fix. The rule is the most common form,
or the newest when usage is split. This file is the design backlog, not a to-do list: an entry becomes
a `design-debt` issue on the triggers [CONTRIBUTING.md](CONTRIBUTING.md) §6 names, and a fix arrives as
its own change with the entry deleted.

## What the B8 reconciliation settled

Every row now has exactly one of three dispositions, stated in its own last bullet and dated:

- **Fixed** — the row is deleted and its id retired. Twenty rows went this way across B1–B8.
- **Filed** — the row stays and names the issue that owns it. Six issues cover twenty of the
  twenty-two remaining rows: **#593** small text below AA contrast (G-23, G-38, G-46), **#594**
  rendered Markdown's phone targets (G-36, G-45), **#595** phone and desktop layout (G-26, G-27,
  G-28, G-30, G-32, G-33, G-37), **#596** accessibility (G-06, G-31, G-39), **#597** the two diff
  endpoints' status words (G-41, server work), **#598** shared helpers and copy rows (G-14, G-15,
  G-16, G-42).
- **Kept, with a reason** — two rows: **G-20** (dead primitives; adding or deleting a catalogued
  component file belongs to one commit, which has merged) and **G-35** (the palette hint, whose own
  rule is conditional on a keyboard-help surface that does not exist).

So nothing here is merely deferred: a row is either gone, owned by a number, or carries the reason it
stays. Two rows to read first if you are picking work up: **G-31** is a live axe-core violation with a
small fix, and **G-14**'s `useIsDesktop()` query is the one item with a real user-visible failure mode.

Ids are never reused: a deleted entry retires its number, so a new entry takes the next number after
the highest ever used. **G-06, G-14, G-15, G-16, G-20, G-23, G-26, G-27, G-28, G-30, G-31, G-32, G-33,
G-35, G-36, G-37, G-38, G-39, G-41, G-42, G-45 and G-46 are live** (22 rows); **G-01 to G-05, G-07 to
G-13, G-17 to G-19, G-21, G-22, G-24, G-25, G-29, G-34, G-40, G-43 and G-44 are retired** (24
numbers); and **the next free id is G-47**. G-43 was retired by decision
[D-09](decisions.md#d-09-compares-pick-confirm-keeps-the-ordinary-contrast-action) (the B7 design
review) rather than by a fix: the pick confirm keeps its ordinary `contrast` action on purpose.

Counts are non-test files or occurrences in `packages/web/src`. Counts in G-15 and G-16 read on
2026-09-16; other counts retain the original inventory date, and a row's own disposition bullet says
what was re-read on 2026-09-17.

## The open gaps

In id order, not priority order — every row names its own owner in its last bullet. The original
topic groupings ("Layout and composition" and the rest) went with the rows that filled them: what is
left spans too many surfaces for the old headings to sort it usefully, and a reader coming from an
issue arrives by id.

### G-06 Two focus-ring idioms and one unconditional animation

- **Differs**: `focus-visible:ring-[3px] focus-visible:ring-ring/50` (eight primitives, 51 sites outside `components/ui`) vs `focus:ring-2 focus:ring-ring focus:ring-offset-2` on the dialog and sheet close buttons (`components/ui/dialog.tsx:73`, `sheet.tsx:78`). `focus-visible:border-ring` is on six primitives but not `button.tsx` or `scroll-area.tsx`. `tooltip.tsx:45` applies `animate-in` unconditionally where every other floating surface gates on `data-[state=open]`.
- **Rule**: the `focus-visible` ring.
- **Fix**: restyle the two close buttons; gate the tooltip animation.
- **Also found (#453 batch B6, Git tabs)**: a third idiom – none. The rows of both Git trees (`routes/task-git/changes-tree.tsx`, `files-tree.tsx`) carry no focus-visible class at all, so they wear the browser's default ring while the diff file header and the expandable gap row beside them wear the cockpit ring. Focus stays visible, so nothing is lost; it is a consistency gap. Found by the #574 design review (NB-5). Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: mostly fixed, remainder filed as **#596**. Both close buttons (`components/ui/dialog.tsx`, `sheet.tsx`) wear the `focus-visible:ring-[3px] focus-visible:ring-ring/50` idiom and the tooltip's animation is `motion-safe:` gated, so the two original divergences are gone. What is left is the Git tree rows carrying no focus-visible class at all; focus stays visible, so it is a consistency gap, and both trees are B6's files.

### G-14 Duplicated shell helpers

- **Differs**: the violet nav badge class is declared four times (`components/app-shell.tsx:581,592`, `components/project-groups.tsx:276,337`) and the Skills update marker twice; "folder not found" renders as a danger chip in `project-groups.tsx:229` and as soft text in `command-palette.tsx:503`; `(min-width: 768px)` is subscribed inline in `app-shell.tsx:206-215` and the shape copied in `ghost-code-backdrop.tsx:210-222` while `lib/use-desktop.ts` exists; `lib/sidebar-width.ts` and `lib/sidebar-collapse.ts` repeat the same read/normalise/write triple.
- **Also (#453 batch B4)**: `useIsDesktop()` asks `(min-width: 768px)` while Tailwind's `md:` is `48rem`. They agree only at the default 16 px font size. The Tasks pages' phone toolbar and the global cards are gated by the hook alone, so they are never hidden twice, but with a larger default font size a width between 768 px and `48rem` shows neither the header nor the phone toolbar. Fix with the hook (`lib/use-desktop.ts`, outside B4): query `48rem`.
- **Rule**: one `NavBadge`; the danger chip for a missing project; `useIsDesktop()`.
- **Fix**: extract `NavBadge`; reuse the hook; share a storage helper.
- **Final disposition (#453 B8, 2026-09-17)**: half fixed, remainder filed as **#598**. `NavBadge` exists as one shared component (`components/app-shell.tsx`, `data-slot="nav-badge"`) and `project-groups.tsx` imports it, so the four-times-declared badge class is gone. Still open there: `useIsDesktop()` queries `(min-width: 768px)` where Tailwind's `md:` is `48rem` (they agree only at a 16 px default font size — the one item here with a real failure mode), and the `sidebar-width.ts` / `sidebar-collapse.ts` storage triple, which `lib/files-tab-selection.ts` (added by this batch) now shares the shape of.

### G-15 Copy inconsistencies

| What differs | Majority (the rule) | Minority | Where |
| --- | --- | --- | --- |
| Load-error copy | "Could not load" (25 literal occurrences, case-insensitive) | "did not load" (10) | 9 of the 10 minority sites under `routes/settings/`, plus `routes/global-tasks.tsx` |
| Retry label | "Retry" (5) | "Try again" (3) | `routes/settings/provider-settings.tsx` has both |
| Search placeholder case | "Search tasks…" (12) | "search skills…" (6) | `routes/new-task.tsx`, `hand-to-agent.tsx`, `prompt-template-menu.tsx`, `prompt-templates-section.tsx` |
| Dash | ` — ` | ` – ` (6 literal occurrences, including one comment) | `routes/settings/mcp-api-section.tsx:160,172,201,224,315,808` |
| Negatives | "could not" | "couldn’t" (2, case-insensitive) | `routes/github/github.tsx:1252` (the file has both), `routes/task-thread/task-thread.tsx:540` |
| Apostrophes | curly `’` (28) | straight `'` (~12) | `routes/settings/appearance.tsx`, `compare-loading.tsx`, `task-commits.tsx`, `project-general.tsx` |
| Curly quotes | literal `“ ”` | `&ldquo;`/`&rdquo;` entities | `routes/workflows/workflows.tsx:641,658` |
| Narrow-a-list verb | "Filter skills…" | "search skills…" | `routes/settings/prompt-templates-section.tsx:357` |
| Empty list text | "Nothing matches." (5) | "No skills match.", "(no skills match)" | `routes/workflows/workflows.tsx:946`, `routes/skills.tsx:153` |
| Column label case | sentence case | "Tool Name" | `lib/task-columns.ts:62` |
| Heading period | none | "This page could not be displayed." | `components/route-error-boundary.tsx:27` |
| Oxford comma | omitted (25) | present (2) | `routes/settings/agents-section.tsx:315`, `notifications-section.tsx:97` |

- **Fix**: one copy pass over the minority sites; a `no-en-dash-in-ui` guardian rule.
- **Status (#453 batch B4, task lists)**: fixed rows – "Tool name" (`lib/task-columns.ts:62`), "Could not load tasks across projects" (`routes/global-tasks.tsx:367`) and "Search templates…" (`components/prompt-template-menu.tsx`). Still open (B5, B7): the placeholders in `routes/new-task.tsx` and `routes/github/hand-to-agent.tsx`, and the other rows.
- **Status (#453 batch B3, settings)**: the settings rows are fixed – "Could not load …" in all ten settings sites, "Retry" in provider settings, "Filter skills…", "Nothing matches." for the bookmarklet filter, the em dash in `mcp-api-section.tsx`, curly apostrophes in `appearance.tsx`, `project-general.tsx` and the hints of `agents-section.tsx`, `resources-section.tsx`, `mcp-connection-section.tsx`, `projects-section.tsx`, `accounts-section.tsx` and `prompt-templates-section.tsx`, and no Oxford comma in `agents-section.tsx`, `notifications-section.tsx` and `prompt-templates-section.tsx`. Still open (B4, B5, B7): the other rows. The guardian rule is not added.
- **Status (#546, navigation-only sidebar)**: the "Bucket label case" row is closed – the sidebar's `Needs you` bucket heading went with the sidebar task list, so the phrase now appears only as the lower-case attention label (`lib/attention.ts`).
- **Status (#453 batch B5, thread, composer and launch menus)**: the negatives row's `routes/task-thread/task-thread.tsx` site reads "Could not load earlier items · Retry". Still open (B7): `routes/github/github.tsx`, the placeholders in `routes/new-task.tsx` and `routes/github/hand-to-agent.tsx`, and the workflows rows.
- **Status (#453 batch B6, Git tabs)**: the apostrophes row's `task-commits.tsx` site is curly (“hasn’t”), and so are “merge commit’s” (`repo-commits.tsx`, `task-commits.tsx`), “repo’s” (`repo-git-loading.tsx`) and “task’s” (`commit-dialog.tsx`, `task-changes.tsx`, which used `&apos;`). Still open (B7): the other rows.
- **Status (#453 batch B7, remaining routes)**: fixed rows – the negatives row ("Could not load comments", `routes/github/github.tsx`), the apostrophes row (`compare-loading.tsx`, and `&apos;` in `skills-import-panel.tsx`), the curly quotes row (`workflows.tsx`), the empty list row ("Nothing matches." in `workflows.tsx`, `skills.tsx` and `skills-import-panel.tsx`), and the placeholders in `routes/github/hand-to-agent.tsx` ("Search workflows…", "Search skills…"). Still open: the three lower-case placeholders in `routes/new-task.tsx` ("search projects…", "search skills & workflows…"). They are asserted verbatim by `routes/new-task-project.test.tsx`, which § B7's manifest does not list, so the batch did not change them; the PR records it under "Reconciliation needed". The guardian rule is not added.
- **Final disposition (#453 B8, 2026-09-17)**: remaining rows filed as **#598**. Left: the two lower-case placeholders in `routes/new-task.tsx` ("search projects…", "search skills & workflows…"), asserted verbatim by `routes/new-task-project.test.tsx` and `routes/new-task.test.tsx`, which no batch manifest listed; the Retry/Try again split; the heading-period, negatives and Oxford-comma holdouts; and the proposed `no-en-dash-in-ui` guardian rule, which was never added.

### G-16 Toast punctuation

- **Differs**: success toasts with a period ("Team skills refreshed.", "Command copied to clipboard.") vs without ("Worktree path copied", "Worktree removed"), roughly 6 to 8; "Command copied to clipboard." and "Command copied" are the same event in two files.
- **Rule**: no period on a short fragment; a period on a full sentence with a clause.
- **Fix**: normalise the ~14 toasts; share one `copyToClipboard` helper (three copies exist in `run-header.tsx`, `review-panel.tsx`, `task-changes.tsx`).
- **Status (#453 batch B4, task lists)**: the helper exists – `copyText` in `lib/clipboard-result.ts` answers `{ ok: true }` or `{ ok: false, reason }` and never throws, so a refused or missing clipboard is never reported as copied. It has no consumer yet. Still open (B5, B6, B7): move the three copies onto it and normalise the toasts.
- **Status (#453 batch B5, thread, composer and launch menus)**: `run-header.tsx` (the resume hint, the terminal fallback and the worktree path) and `review-panel.tsx` (the manual merge line) copy through `copyText`; a refusal toasts the payload ("Run manually: …", "Path: …"), never "copied". Their toasts are fragments: "Command copied", "No terminal found — command copied", "Worktree path copied" (writing.md §13). Still open (B6, B7): `routes/task-git/task-changes.tsx` and `routes/skills.tsx`.
- **Status (#453 batch B6, Git tabs)**: `routes/task-git/task-changes.tsx`'s terminal fallback copies through `copyText` and toasts the same fragment as the run header (“No terminal found — command copied”); a refusal shows “Run manually: …”. Still open (B7): `routes/skills.tsx`.
- **Status (#453 batch B7, remaining routes)**: the fragments lost their period – "Team skills refreshed" (`routes/skills.tsx`), "xezar-skills updated" and "Some skill updates failed" (`components/skills-import-panel.tsx`), "Deleted “{name}”" (`routes/workflows/workflows.tsx`). The Workflows YAML Copy goes through `copyText`: it flips to "Copied" only when the clipboard took the text, and a refusal toasts "Could not copy the YAML — select it below instead". `writing.md` §13 still quotes the old "Team skills refreshed." (G-44).
- **Final disposition (#453 B8, 2026-09-17)**: one site left, filed as **#598**. All three hand-rolled copy helpers now go through `copyText` (`lib/clipboard-result.ts`) and the fragments lost their periods. The holdout is `routes/settings/bookmarklets-section.tsx` — "Bookmarklet URL copied." is a fragment with a period, and it is also the last copy site that does not ask `copyText`, so a refused clipboard is still reported there as a copy.

### G-20 Dead primitives

- **Differs**: `components/ui/card.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx` have zero importers.
- **Rule**: do not use them until adopted (each entry in components.md says what to use instead).
- **Fix**: delete or adopt.
- **Final disposition (#453 B8, 2026-09-17)**: kept, with a reason. All four still have zero importers. #453 gives adding and deleting catalogued component files to batch B1 in a single commit, so that mirror and coverage ownership stays in one place, and B1 has merged — no later batch may delete them, and B8 did not. They are harmless while the rule holds: each entry in `components.md` names what to use instead, `design-system-drift.test.ts` keeps their rows honest, and the two decisions that would close this row (adopt `Select` in settings per G-11, restyle or delete `card.tsx` per G-02) are design decisions, not cleanup. Revisit when a surface genuinely wants one of the four; deleting them is a `decisions.md` record, not a silent removal.

### G-23 Small text below AA contrast in three token pairs

- **Differs**: `--soft-foreground` is `#a3a3a3` in `.light` (`styles/index.css:198`) – 2.5:1 on `--background`, 2.4:1 on `--muted` – and it colours 10–12.5 px text (eyebrows, hints, chip counts, table headers). `--danger-foreground` (`#ffffff`) on `--danger` (`#ef4444`) is 3.8:1 for the danger button and the danger toast. `--violet-foreground` on `--violet` is 3.1:1 for the nav badge (accepted in `styles/index.css` beside the token). AA needs 4.5:1 for text this size.
- **Rule**: keep the tokens; do not add more small text in `--soft-foreground` on light, and keep the badge count announced in words.
- **Fix**: darken light `--soft-foreground` to about `#767676` (4.5:1) and revisit the danger pair; then re-check every specimen swatch.
- **Also measured (#453 batch B4, 375 px, light theme)**: three ink tokens are below 4.5:1 as small text on the task lists – `--success` (`#10b981`) 2.5:1 and `--danger` (`#ef4444`) 3.8:1 in the `+`/`−` diff counts (`components/diff-stat.tsx`), and `--violet` (`#8f86e8`) 3.1:1 in a reference chip with no forge status (`components/reference-chip.tsx`). The dark theme passes. B4 may not change a token, so `e2e/design-debt-b4.e2e.ts` reports these three colours and fails on any other. Owner: a token change after B1, through B8 reconciliation.
- **Also measured (#453 batch B6, 375–1280 px, light theme)**: two more sites paint the same token pairs as small text. The repository Branches tab spells a check's state in 10 px words – "passing" in `--success` at 2.54:1 and "failing" in `--danger` at 3.76:1 (`routes/repo-git/repo-branches.tsx`), the same pairs this entry already records for the diff counts. The review gate's manual-merge URL renders `text-primary` on white at **1.34:1**, which fails AA for text of any size, not only small text; that one was measured in the running cockpit and its source site is still to be located – `routes/task-thread/review-panel.tsx` paints its own manual path in `--soft-foreground`, so the lime ink comes from somewhere else on that surface. Both found by the #574 design review (NB-6, NB-7). B6 may not change a token. Owner: the same token change, through B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#593**, with G-38 and G-46. Every one of these is a token or blend change, and #453 gives token ownership to batch B1, which has merged; B4, B6 and B7 were each told to REPORT the colours rather than pass them, which is why their browser suites list them. The review gate's 1.34:1 lime manual-merge URL is the most serious of them and its source site is still unlocated.

### G-26 The thread header shows scrolled content through it

- **Differs**: the task thread's header is `bg-background/95 … backdrop-blur md:sticky` (`routes/task-thread/run-header.tsx:160`), so thread content scrolled under it stays faintly readable beside the title and meta line, most visibly in light theme. The canonical page header (G-01) is opaque.
- **Rule**: an opaque sticky header for new work.
- **Fix**: make the run header opaque, or strong enough that text behind it does not read. Seen in the 0.15.0 docs captures (#448, design review NB-2).
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**, with the other layout rows. `run-header.tsx` is B5's file and making the header opaque changes how the whole thread surface reads under scroll — a layout decision, not a class swap, and one a design review should see on its own.

### G-27 The Tasks table gives the task title the least width

- **Differs**: the Task column has no width and is meant to take the remainder (`lib/task-columns.ts:38`), but its cell is `min-w-[220px] max-w-0` (`routes/tasks-overview.tsx`) inside an auto-layout table, so it stays at 220 px and titles cut at about 20 characters while fixed columns keep theirs. With every column open the fixed widths alone pass 1,000 px, so at 1280 px beside the sidebar the table scrolls sideways and IN / OUT is cut off.
- **Rule**: new columns take a fixed width; the title is the column that grows.
- **Fix**: let the Task column absorb the free width (fixed table layout, or no `max-w-0` on the title cell) and re-check the fold defaults at 1280. Seen in the 0.15.0 docs captures (#448, design review NB-7).
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. `tasks-overview.tsx` is B4's file, and the fix changes the table's layout algorithm and the fold defaults together, so it needs its own before/after measurement at 1280 px.

### G-28 The version chip truncates at Roomy density and in the phone drawer

- **Differs**: the sidebar footer leaves the version chip too little room, and its `truncate` span (`components/app-shell.tsx:750`) reads `v0.1…`. In the desktop sidebar that happens at Roomy, while Comfortable and Compact show the whole version. In the phone drawer it also happens at Comfortable (375 px, both themes; #559 design review NB-3). Compact in the phone drawer was not measured.
- **Rule**: a version number is never truncated.
- **Fix**: give the chip `shrink-0` and let the footer's other controls give way first. Seen in the 0.15.0 docs captures (#448, design review NB-9).
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. `app-shell.tsx` is B2's file. Compact in the phone drawer was never measured, so the fix starts by finishing the measurement.

### G-30 The registered-projects table scrolls sideways on a phone

- **Differs**: at 390 px the Global → Projects "Registered projects" table (`routes/settings/projects-section.tsx:277`) scrolls inside its box (567 px of content in 356 px), squeezing the Project column to 60 px, instead of reflowing as cards below `md`; pre-existing, found in the B3 design review (#519, NB-2). Owner: B8 reconciliation of #453. It was given to B4, but `projects-section.tsx` is in no remaining batch manifest (B3 owned it and has merged), so the fix needs a manifest revision first.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. B8 did the part it could: `e2e/capture/manifest.ts` now carries a `settings-projects` shot state planned for 0.16.0, phone variant included, so whoever reflows the table has a before picture instead of a sentence. The reflow itself is `projects-section.tsx`, B3's file, and is a card-layout design.

### G-31 The reference panel is an unnamed dialog

- **Differs**: a conflicting pull request's panel takes `role="dialog"` so its "Resolve conflicts" button can be reached (`components/reference-chip.tsx:395`), but the dialog has no accessible name, so axe-core 4.12.1 reports `aria-dialog-name` on every surface, density and theme; the chip that opens it is named. Pre-existing on `main`; found by the axe pass for #453 B4 design-review finding B-1.
- **Rule**: a `role="dialog"` always carries a name, for example `aria-labelledby` pointing at the text that already heads it.
- **Fix**: name the panel from its first line (the reference and its status) and add the axe rule to the B4 browser pass. Owner: B8 reconciliation of #453; `reference-chip.tsx` is outside the B4 source change.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#596**. This is the most serious row left — a live axe-core `aria-dialog-name` violation on every surface, density and theme — and the fix is small (`aria-labelledby` pointing at the line that already heads the panel). It stays filed rather than fixed because `reference-chip.tsx` is B4's file and #453 AC-0 holds each batch to its own manifest; B8's brief named four deferred gaps to fix and this was not one of them. It should be picked up first of the six.

### G-32 The phone run header opens partly under the top bar

- **Differs**: on a phone the task thread opens scrolled to its end, and the run header scrolls with it (it is sticky only from `md`, `routes/task-thread/run-header.tsx:160`). With a thread slightly taller than the screen, the header's first row sits under the top bar. Measured at 375 px on the `subagents-run` fixture: the page scrolls 25 px on `main` and 37 px with the B4 44 px run tabs, so the "Run actions" button (`run-header.tsx:895`) shows 27 px of 44 before B4 and 15 px after. Its centre is then under the top bar (`components/app-shell.tsx:797`), which is why a click there is refused. Pre-existing; B4's taller tabs add 12 px. Found by the #529 CI run (`e2e/design-debt-b1.e2e.ts`, which now scrolls the button into view first).
- **Rule**: a control in the page's first row is fully visible when the page opens.
- **Fix**: open a short thread at its top, or keep the phone run header's first row visible. Owner: B5 (`run-header.tsx`) or B8 reconciliation of #453; the thread's scroll behaviour is outside B4.
- **Status (#453 batch B5, thread, composer and launch menus)**: not fixed, moved to B8 reconciliation. The cause is where the phone thread opens (at its end, `thread-scroller.tsx` / `thread-scroll.ts`), a behaviour the thread-scroll specs pin; changing it is a behaviour decision, not a class change. B5's 44 px rows make the header taller, so the first row sits further under the top bar. `e2e/design-debt-b5.e2e.ts` scrolls each control into view before it measures it.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. The cause is where the phone thread opens, which the thread-scroll specs pin, so it is a behaviour decision. B8 did settle its test-side symptom: #584's failure was this gap plus a scroll/click race, and `e2e/design-debt-b1.e2e.ts` now waits for the control to be in view, still and the topmost element at its own centre before clicking (`waitHittable`) — the spec is deterministic, the layout gap is still open, and the wait is what documents it.

### G-33 The composer footer reflows after the model pill enables

- **Differs**: on a phone, one or two frames after the composer's model pill (`components/engine-pills.tsx:204`) stops being disabled, the footer reflows. Measured at 375 px: before B4 the pill moves 28 px sideways; with the B4 44 px phone pills it wraps to the next line (from y 218 to y 266). A click aimed at the first position then misses. A person cannot tap that fast (the move is under 25 ms), but a test can. Pre-existing; B4's larger pills turn the shift into a wrap. `e2e/design-debt-b1.e2e.ts` now waits until the pill holds still.
- **Rule**: a control is in its final place when it becomes enabled.
- **Fix**: reserve the footer's space before the late content arrives, or enable the pill in the same render. Owner: B5 (composer) or B8 reconciliation of #453.
- **Status (#453 batch B5, thread, composer and launch menus)**: not fixed, moved to B8 reconciliation. The late enable comes from `components/engine-pills.tsx`, which is in no B5 manifest file; `composer.tsx` only hosts the footer.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. `engine-pills.tsx` is in no batch manifest; `composer.tsx` only hosts the footer. `waitPlaced` in `e2e/design-debt-b1.e2e.ts` keeps the browser suite honest about it meanwhile.

### G-35 The command palette has no visible hint and no touch path

- **Differs**: since #546 removed the sidebar's `Search…` launcher, no rendered text in the cockpit shows `⌘K` or `Ctrl+K`. The palette (`components/command-palette.tsx`) opens from the keyboard only, so people cannot discover it, and a touch-only phone cannot open it at all. Nothing is lost: every palette destination stays reachable another way – views through the nav, projects through the project groups and Add project, tasks through the Tasks pages, Toggle theme through the footer, and skills through Skills. The owner accepted losing the click path. Recorded 2026-09-17 from the #559 design review (NB-1).
- **Rule**: document ⌘K/Ctrl+K where keyboard help is shown. The cockpit has no keyboard-help surface yet, so there is no place for the hint.
- **Fix**: when a keyboard-help surface exists, list ⌘K/Ctrl+K there. Bringing back a clickable launcher is not the fix.
- **Final disposition (#453 B8, 2026-09-17)**: kept, with a reason, and it is not debt. The owner accepted losing the click path, every palette destination stays reachable another way, and this row's own rule is conditional: the hint belongs wherever keyboard help is shown, and the cockpit has no keyboard-help surface. There is nothing to fix until one exists — the row is the note that says so. Bringing back a clickable launcher is explicitly not the fix.

### G-36 Rendered Markdown's code-block actions are under the phone target

- **Differs**: the copy and download buttons on a fenced code block in a thread message are 22–26 px at 375 px across the four densities (`data-streamdown="code-block-copy-button"`, `code-block-download-button`). They come from the Markdown library (`streamdown`), configured in `routes/task-thread/markdown.tsx`. Every other thread control is 44 px. Pre-existing; found by `e2e/design-debt-b5.e2e.ts`, which reports these buttons in `known-g36-markdown-actions.json` and fails on any other small target.
- **Rule**: a touch target on a phone is 44 px.
- **Fix**: pass the library's class hook for code-block actions, or render the actions through `Button size="icon-sm"`. Owner: B8 reconciliation of #453; `markdown.tsx` is in no batch manifest.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#594**, with G-45. Both are the Markdown library's own controls; `markdown.tsx`, which configures it, is in no batch manifest.

### G-37 The desktop run tabs overlap at 1280 px

- **Differs**: at 1280 px, in both themes, the "Session / Changes / Commits / Files" run tab labels print over each other (`routes/task-thread/run-header.tsx` tab row). The base revision (`e2c00eed`) shows the same overlap, so batch B5 did not cause it. Found by the #571 design review (NB-5).
- **Rule**: tab labels never overlap at any documented width.
- **Fix**: give the tab row enough width, or wrap or truncate the labels, so the four never collide at 1280 px. Owner: B8 reconciliation of #453, or a standalone issue.
- **Also at 1024 px (#453 batch B6)**: the same header's action row overflows `main` by about 2 px there, and the four tab labels print over each other at that width too. Pre-existing; `run-header.tsx` is not a B6 file. Found by the #574 design review (NB-7), so the fix has to hold at 1024 px as well as 1280 px. Owner: unchanged.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#595**. Pre-existing on the base revision, and the fix has to hold at 1024 px as well as 1280 px.

### G-38 Syntax colours on a diff tint are below 4.5:1

- **Differs**: in the light theme, two syntax-token colours miss AA as 12 px code on the diff's tints – the number colour (`--syn-num`, `#b91c1c`) on a strong deletion word mark (`bg-diff-del-strong`) is 4.05:1, and the punctuation colour (`--syn-punc`, `#6b7280`) on a line tint is 4.42:1. The comment colour misses AA in **both** themes: `--syn-com` is 2.36:1 in light and 3.22:1 in dark (`#6b7280` on `bg-diff-add-bg`), so the dark theme does **not** pass. Measured on the review gate and the task Changes tab at 1280 px by `e2e/design-debt-b6.e2e.ts` (#453 B6) for the first two; the comment colour was measured composited by the #574 design review (NB-2), whose fixture carries a comment line where the browser suite's does not.
- **Rule**: keep the tokens; a syntax colour must still reach 4.5:1 on every `--diff-*` surface it is painted on.
- **Fix**: darken the two light `--syn-*` colours and the comment colour in both themes, or lighten the `--diff-*` tints, and re-measure every diff surface. B6 may not change a token (#453: B1 owns them), so the browser suite reports these colours instead of passing them. Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#593**, with G-23 and G-46. A token change, which B1 owns; the dark theme fails too, so it is not a light-theme polish item.

### G-39 The changed-files tree marks a file's status with colour alone

- **Differs**: in the task Changes tree (`routes/task-git/changes-tree.tsx:115`) an added or copied file is marked only by a green file icon and a renamed file carries no mark at all, while the diff card beside it spells "copied" and "renamed" in words. [README.md](README.md) rule 10 puts the word first and colour second, and colour alone is not readable for a reader who cannot tell the two greens apart; the icon is `aria-hidden`, so the row carries no accessible status either. Pre-existing; found by the #574 design review (NB-3).
- **Rule**: a status is a word, or an accessible name; colour only ever repeats it.
- **Fix**: give each row an `aria-label` carrying the status, or a short status word beside the file name, matching the diff card's vocabulary. Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#596**. `changes-tree.tsx` is B6's file. Whoever fixes it should read **#597** first: the two surfaces currently disagree about what to CALL a change, and adding a status word to the tree would entrench one of the two names.

### G-41 The same change is named two different things on two surfaces

- **Differs**: the review gate calls `src/copy.ts` "copied" while the task Changes tab calls the same file "added", and calls `logo.png` "binary" where the Changes tab calls it "image". The renderer is one engine; the difference comes from the two endpoints' own rename and copy detection (server-side diff flags), so the reader sees one change named twice moving between tabs. Found by the #574 design review (NB-4).
- **Rule**: one change has one name, whichever surface shows it.
- **Fix**: make the two endpoints ask `git diff` for the same detection, then re-check both surfaces. This is server work, not a design-system change, so it wants its own issue. Owner: B8 reconciliation of #453, or a standalone issue.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#597**, on its own. It is server work, not a design-system change — no class, token or component is wrong — and the renderer has been one engine since B6. The UI lane cannot fix it, so it gets its own issue rather than a line in a design-debt batch.

### G-42 `SearchField` cannot carry a slot, so four searches spell it by hand

- **Differs**: `SearchField` (`routes/tasks-overview.tsx:431`) takes `value`, `onChange`, `placeholder`, `label` and `className` and spreads nothing else onto its `Input`. The GitHub list (`data-slot="gh-search"`, `type="search"`), the Skills catalog (`skills-filter`), the skills import panel (`import-filter`) and the Workflows palette (`wb-filter`) need their slot – tests and the browser suite find them by it – so #453 B7 spelled the same `relative` wrapper, `SearchIcon` and `Input pl-8 md:text-[13px]` four times instead of importing it.
- **Rule**: one search field component.
- **Fix**: let `SearchField` forward the rest of `Input`'s props (and move it out of a route module into `components/`), then replace the four spellings. `tasks-overview.tsx` is B4's file, so B7 did not change it. Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#598**. `tasks-overview.tsx` is B4's file, and moving `SearchField` into `components/` adds a shared component — which #453 reserves for B1 — so it needs the coverage row and the drift test in the same commit.

### G-45 Rendered Markdown's image actions are under the phone target

- **Differs**: an image in rendered Markdown (a GitHub issue or pull request body, a comment) carries the Markdown library's own buttons – "Download image" at 24–40 px across the densities, and a hover-revealed download mark – beside the code-block copy button G-36 already records. Measured at 375 px by `e2e/design-debt-b7.e2e.ts`, which reports them in `known-g36-g45-markdown-actions.json` instead of passing them. The Markdown component (`routes/task-thread/markdown.tsx`) is B5's file, so B7 did not change it.
- **Rule**: every phone target is 44 × 44 px (#453 Q2); a touch-only reader sees every action.
- **Fix**: give the Markdown library's image and code-block actions the phone floor from `markdown.tsx`, as G-36 proposes for code blocks. Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#594**, with G-36.

### G-46 A GitHub label chip can sit below 4.5:1

- **Differs**: a label chip (`routes/github/github.tsx`, `LabelChip`) is painted from the repository's own label colour (`github-filter.ts` blends it toward `--foreground`), so its small text follows data the cockpit does not choose: the dry-run label "enhancement" composites at 4.03:1 on the light theme. The browser suite reports label colours separately rather than passing or failing them.
- **Rule**: small text is at least 4.5:1 on its actual surface.
- **Fix**: raise the blend toward `--foreground` until the composited ratio clears 4.5:1 for any label colour, and pin it with a unit test over the extreme colours. Owner: B8 reconciliation of #453.
- **Final disposition (#453 B8, 2026-09-17)**: filed as **#593**, with G-23 and G-38. Its blend is a pure function (`github-filter.ts`), so it is the one row of the three that can be pinned by a unit test rather than a browser measurement.

## Comment vs code

Four of the five rows this section opened with closed with their gaps at the #453 B8 reconciliation
(2026-09-17): the error boundary renders `CenteredState` (G-05), `statusDotVariants` and `Skeleton`
carry `motion-reduce:animate-none` (G-08), `no-hover:` is on every hover-revealed control the
inventory named (G-21), and `PopoverTitle` renders the `h2` it is typed as (G-07). One is left, and
it has no G id because nothing is inconsistent in the code — the comment is simply behind it.

| Comment says | Code does | Where |
| --- | --- | --- |
| the reference tones share `StatusDot`'s five roles | `ReferenceStatusTone` adds `info` and `conflict`, which `StatusDot` cannot paint | `lib/reference-status.ts:11-13`, `components/reference-chip.tsx:469` |

## Mockup fidelity (designs/quality-checks on the shared stylesheet)

The shared stylesheet keeps the mockup's own class values so the quality-checks pages look unchanged.
Where those values differ from the cockpit, the delta is recorded here and the cockpit value is the rule
for new work.

| Class | Mockup value (`cockpit.css`; the `qc-` rows live in `designs/quality-checks/styles.css`) | Cockpit value | Source |
| --- | --- | --- | --- |
| `.btn` (small button) | 30px, `padding 0 12px`, weight 500, 12.5px | `h-[30px] px-2.5 text-[12.5px] font-semibold` | `components/ui/button.tsx` |
| `.btn-new-task` | `calc(var(--spacing) * 10)` (40px), weight 500; `.new-task-row .btn-icon` matches at 40px | `h-10` (40px), `font-semibold`; Add project `size-11 md:size-10` | `components/app-shell.tsx:498`, `components/app-shell.tsx:704` |
| `.quick li` | fixed `height: 32px`, `padding 0 10px` | none since #546: the sidebar lists no tasks; the class stays in `cockpit.css` for existing mockups only | `components/task-quick-list.tsx` (removed, #546) |
| `.list-tabs span.on` | `bg card-2`, weight 500 | none in the sidebar since #546; the class stays in `cockpit.css` for existing mockups only | `components/task-quick-list.tsx` (removed, #546) |
| `.tasks-table th` | 11.5px, weight 500, no transform | `text-[11px] font-semibold tracking-[0.05em] uppercase` | `TASK_TH_CLASS`, `lib/task-columns.ts:143` |
| `.nav-badge.danger` | red badge | no red nav badge exists; the cockpit's badges are violet | design decision, pending review |
| `.qc-empty` | dashed box, 40px icon, 15px title | `CenteredState`: 72px tile, `text-2xl` | `components/centered-state.tsx` |
| `.qc-skeleton` | sheen sweep | `animate-pulse rounded-md bg-accent` | `components/ui/skeleton.tsx` |
| `.task-body` | `padding 18px 24px 24px`, fixed px | thread column `md:px-section md:py-section` (32 px on the density unit) | `routes/task-thread/task-thread.tsx:307` |
| `.task-head h1`, `.task-head .row` | `margin 8px 0 10px`, fixed px | tab row `mt-stack` (12 px) under the title | `routes/task-thread/run-header.tsx:222` |
| `.quick-head` | `padding 12px 22px 4px`, fixed px | none since #546: the sidebar has no bucket headings; the class stays in `cockpit.css` for existing mockups only | `components/task-quick-list.tsx` (removed, #546) |
| `.tasks-table td` | `padding 10px 12px`, height from content | `h-11 px-3` | `TASK_TD_CLASS`, `lib/task-columns.ts:145` |
| `.qc-toast` | card surface with a success icon | `bg-contrast text-contrast-foreground`, no icon | `components/ui/toaster.tsx` |
| `--diff-add` / `--diff-del` (removed) | mockup-only aliases | `text-success` / `text-danger` | `components/diff-stat.tsx` |
| `.qc-alert` | card with a danger-tinted border and icon | `banner-row` with the `alert` tone | `components/provider-banner.tsx` |
| `.btn.contrast:hover` (new) | the mockup had no hover, so a contrast button turned `--muted` on hover | `filter: brightness(0.96)` | `components/ui/button.tsx` |
| `.tasks-table tbody tr:hover` (new) | the mockup had no row hover | `hover:bg-muted` | `routes/tasks-overview.tsx` |

Proposed fix: when the quality-checks design gets its review, restyle those classes to the cockpit
values and drop the `qc-` prefixed ones in favour of the shared `.centered-state`, `.skeleton` and
`.toast` classes.
