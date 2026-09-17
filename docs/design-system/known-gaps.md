# Known gaps

Every place where the cockpit does the same thing more than one way, or where a comment and the code
disagree, found while inventorying `packages/web/src` on 2026-09-13. Nothing here was fixed in code. For
each gap: what differs, where, which form is the rule for new work and why, and the proposed fix. The rule
is the most common form, or the newest when usage is split. This file is the design backlog, not a
to-do list: an entry becomes a `design-debt` issue on the triggers [CONTRIBUTING.md](CONTRIBUTING.md) §6
names, and a fix arrives as its own change with the entry deleted.

Ids are never reused: a deleted entry retires its number, so a new entry takes the next number after the
highest ever used. G-01..G-23, G-26..G-28 and G-30..G-37 are live, G-24, G-25 and G-29 are retired, and
the next free id is G-38.

Counts are non-test files or occurrences in `packages/web/src`. Corrected counts in G-02, G-06,
G-08, G-11, G-15 and G-19: counts read on 2026-09-16. Other counts retain the original inventory date.

## Layout and composition

### G-01 Page header markup has five shapes

- **Differs**: heading size and wrapper. Canonical `sticky top-0 z-10 hidden h-14 … md:flex` + `h1 text-base font-semibold` (8 sites: `routes/tasks-overview.tsx`, `global-tasks.tsx`, `inbox.tsx`, `skills.tsx`, `skills-loading.tsx`, `workflows/workflows.tsx`, `settings/settings-shell.tsx` ×2). `bg-background/95 backdrop-blur` + `text-lg` (`routes/repo-git/repo-git.tsx`, `routes/github/github.tsx`). `text-[15px]`, sticky from `md` (`routes/task-thread/run-header.tsx`). Centred `text-lg` (`routes/new-task.tsx`). `text-xl` (`routes/compare-variants.tsx`). `text-2xl` in a `max-w-6xl` frame (`routes/automations/automations.tsx`).
- **Rule**: the canonical form. It is the majority and the newest list pages use it.
- **Fix**: extract a `PageHeader` component; migrate Git, GitHub, Compare and Automations. The run header is a different surface (editable title) and may stay.

### G-02 Three card spellings and a dead primitive

- **Differs**: `components/ui/card.tsx` (0 importers); ad-hoc `rounded-lg border border-border bg-card` (22 sites in 15 files); `rounded-xl border bg-card p-4` (`routes/automations/automations.tsx:115,148`).
- **Rule**: the ad-hoc string, plus `shadow-xs` for a raised container.
- **Fix**: either delete `card.tsx` or restyle it to the ad-hoc look and adopt it. Migrate the two `rounded-xl` cards.

### G-03 Chip class copied instead of imported

- **Differs**: `chipClass` (`components/picker-pill.tsx`) is re-declared by hand in `components/prompt-template-menu.tsx:67` and `routes/settings/prompt-templates-section.tsx:345`, both with `disabled:opacity-50` instead of `opacity-55`. Both copies also keep the old `h-[26px]` and so miss the `h-7 min-h-[24px]` density-scaled height and 24 px floor. `components/facet-filter.tsx` spells its filter chip `h-7` without the floor, so it is 21 px at Compact for real – under the 24 px minimum target size of WCAG 2.2 SC 2.5.8. This predates step 3b of #424.
- **Rule**: import `chipClass` (`h-7 min-h-[24px]`) for composer chips; `h-7` for filter chips.
- **Fix**: replace the two copies with the import; document the two heights as intentional or unify.
- **Status (#453 batch B3, settings)**: the settings copy is fixed: `prompt-templates-section.tsx` spells the `chipClass` look (`h-7`, `md:min-h-chip`, `disabled:opacity-55`) and grows to `min-h-tap` below `md`; its skill chips carry the same floors. It is spelled locally because B4 owns `chipClass`.
- **Status (#453 batch B4, task lists)**: fixed – `prompt-template-menu.tsx:70` imports `chipClass` (icon-only adds `w-7 min-w-chip px-0`), and `facet-filter.tsx:38` spells one `FILTER_CHIP` for the facet trigger and `ToggleChip`: `h-7`, `md:min-h-chip` on a desktop, `min-h-tap min-w-tap` below `md`. `chipClass` itself keeps `min-h-[24px]` (S12) and grows to 44 px with `max-md:min-h-tap max-md:min-w-tap`. The two heights stay: the composer chip and the filter chip are both `h-7` with a 24 px floor. The entry stays until B8 retires it.

### G-04 `text-danger` vs `text-destructive`

- **Differs**: `text-danger` ×63 in routes and components; `text-destructive` ×4 (`routes/automations/automations.tsx:195`, `routes/settings/agent-config-section.tsx:298,311`, `components/skills-import-panel.tsx:350`). The `--destructive` alias exists for the shadcn primitives.
- **Rule**: `text-danger` in app code. Dominant and newer.
- **Fix**: replace the four sites.
- **Status (#453 batch B3, settings)**: `agent-config-section.tsx` now uses `text-danger`, `border-danger/40` and `bg-danger/10`. Still open (B7): `automations.tsx:195`, `skills-import-panel.tsx:350`.

### G-05 Hand-rolled centered messages

- **Differs**: `CenteredState` (60 usages) vs the route error boundary (`components/route-error-boundary.tsx`), `routes/skills-loading.tsx` (a bare centred paragraph), `PageState` in `routes/automations/automations.tsx:204` (dashed box), and ~19 inline "Loading…" lines. `centered-state.tsx:17-18` says "Views never hand-roll a centered message"; the code does.
- **Rule**: `CenteredState` for page-level states; one muted line (`px-4 py-6 text-center text-xs text-soft-foreground`) inside a surface.
- **Fix**: migrate the error boundary, `skills-loading.tsx` and `PageState`.

### G-06 Two focus-ring idioms and one unconditional animation

- **Differs**: `focus-visible:ring-[3px] focus-visible:ring-ring/50` (eight primitives, 51 sites outside `components/ui`) vs `focus:ring-2 focus:ring-ring focus:ring-offset-2` on the dialog and sheet close buttons (`components/ui/dialog.tsx:73`, `sheet.tsx:78`). `focus-visible:border-ring` is on six primitives but not `button.tsx` or `scroll-area.tsx`. `tooltip.tsx:45` applies `animate-in` unconditionally where every other floating surface gates on `data-[state=open]`.
- **Rule**: the `focus-visible` ring.
- **Fix**: restyle the two close buttons; gate the tooltip animation.

### G-07 Primitive-level divergences

- **Differs**: Select puts its check indicator on the right, DropdownMenu on the left; Sheet is `bg-background`, Dialog `bg-card`; Tooltip `sideOffset` 0 vs 4 elsewhere; Sheet's close button uses `data-[state=open]:bg-secondary` and a hard `size-4` icon, Dialog's `bg-accent` and the auto size; Sheet exports no `Portal`/`Overlay`; variant APIs are cva (`badge`, `button`, `tabs`), inline unions (`select`, `switch`, `dropdown-menu`) or booleans (`sheet`); Textarea's disabled state lacks Input's `pointer-events-none`; `aria-invalid` styling is on four primitives only; `PopoverTitle` is typed as `h2` but renders a `div` (`components/ui/popover.tsx:67-70`).
- **Rule**: leave as is; they are documented in components.md.
- **Fix**: align on the next shadcn refresh; render `PopoverTitle` as the element it is typed as.

### G-08 Reduced-motion guards are inconsistent

- **Differs**: `motion-safe:animate-spin` ×12, `motion-reduce:animate-none` ×5, but bare `animate-pulse` in `components/status-dot.tsx:21` (every pulsing dot), `components/ui/skeleton.tsx:7`, `routes/new-task.tsx:540,1399`; bare `animate-spin` in `routes/task-thread/thread-items.tsx:156,344,571` and `routes/github/github.tsx:955,1050`. `status-dot.tsx:8-9` cites the "quiet motion" rule while shipping no guard. Three dots are hand-rolled instead of `StatusDot` (`components/project-groups.tsx:344`, `components/app-shell.tsx:602`, `components/composer/composer.tsx:725`); only the composer's carries the guard.
- **Rule**: new animation is `motion-safe:` or has `motion-reduce:animate-none`.
- **Fix**: add `motion-reduce:animate-none` to `statusDotVariants` and `Skeleton`; guard the five spinners; replace the three ad-hoc dots.
- **Status (#453 batch B5, thread, composer and launch menus)**: the thread is done – the three `thread-items.tsx` spinners are `motion-safe:animate-spin`, and the composer's hand-rolled dictation dot is `StatusDot tone="danger" pulse`. `design-debt-b5.test.tsx` fails on a bare spin or pulse in any B5 file. Still open (B7): `routes/new-task.tsx`, `routes/github/github.tsx`.

### G-09 Two diff renderers

- **Differs**: `components/run-diff.tsx` (review panel, compare view: own parser via `lib/unified-diff`, no gutter, no word diff, 300-line clamp, its own status badge map without `copied`, a third inline `fileKey`) vs `components/diff/` (seven routes: gutters, word marks, split mode, virtualisation). `run-diff.tsx:17` calls itself "the honest R3 interim".
- **Rule**: `Diff` from `@/components/diff`.
- **Fix**: migrate the review panel and compare view; delete `run-diff.tsx`.

### G-10 Destructive confirm styling is a copied string

- **Differs**: `bg-danger text-danger-foreground hover:brightness-[0.96]` copied in `routes/settings/remove-project.tsx:78`, `routes/settings/worktrees-panel.tsx:162`, `routes/task-thread/run-header.tsx:990`, `routes/workflows/workflows.tsx:668`; the irreversible overwrite confirm in `workflows.tsx:648` is unstyled; the same file uses "Keep it" and "Keep the file".
- **Rule**: tint every irreversible confirm; cancel reads "Keep it" unless a more specific kept outcome exists.
- **Fix**: add a `danger` Button variant and use it in `AlertDialogAction`.
- **Status (#453 batch B3, settings)**: `remove-project.tsx`, `worktrees-panel.tsx` and the agent-account remove confirm pass `buttonVariants({ variant: 'danger' })` to `AlertDialogAction`, cancel with "Keep it", and hand focus back to the opener (`useReturnFocus`); the per-row worktree Delete is `danger-ghost`. Still open: `task-thread/run-header.tsx` (B5), `workflows/workflows.tsx` (B7).
- **Status (#453 batch B5, thread, composer and launch menus)**: the run confirm (`routes/task-thread/run-header.tsx`) wears `buttonVariants({ variant: 'danger' })` and cancels with "Keep it". Focus return was not changed: it does not use `useReturnFocus`, and when the dialog opened from the phone kebab closes, focus lands on `<body>`, not on "Run actions" (measured 375 px, dark Compact for real and light Comfortable; #571 design review NB-3). Fix it with `useReturnFocus` in B8, as B3 did. Still open: `workflows/workflows.tsx` (B7).

### G-11 Raw `<select>` in settings while the Select primitive is unused

- **Differs**: `rounded-md border border-input bg-card px-3 py-1.5` on raw selects and inputs at 23 sites (`routes/settings/resources-section.tsx` ×13, `agents-section.tsx` ×6, `projects-section.tsx:217`, `accounts-section.tsx:426`, `worktrees-section.tsx:108`, `routes/repo-git/repo-branches.tsx:162`); `components/ui/select.tsx` has 0 importers.
- **Rule**: the raw control class for settings (it is what ships).
- **Fix**: decide between adopting `Select` and deleting it; extract the raw class into a `NativeSelect` component.
- **Status (#453 batch B3, settings)**: all 28 raw settings fields (the 22 listed plus `projects-section.tsx` ×2, `accounts-section.tsx:700` and `add-account-dialog.tsx` ×3) wear `nativeFieldClass` from `components/ui/input.tsx`, so they reach 44 px on a phone. Still open: `routes/repo-git/repo-branches.tsx` (B6).

### G-12 Search input markup duplicated

- **Differs**: a character-identical wrapper + `SearchIcon` + raw `<input>` in `routes/tasks-overview.tsx:195-208` and `routes/global-tasks.tsx:360-375`; `routes/skills.tsx:122-129` uses `Input`.
- **Rule**: `Input` with a leading icon.
- **Fix**: extract `SearchField`.
- **Status (#453 batch B4, task lists)**: `SearchField` (`routes/tasks-overview.tsx:431`) wraps `Input` with the leading icon; both task pages use it, so their search reaches 44 px on a phone. Still open (B7): `routes/skills.tsx` and the other search inputs.

### G-13 Settings field chassis copied three times

- **Differs**: `routes/settings/settings-field.tsx` (7 importers) vs private `Field` in `routes/settings/appearance.tsx:101-111`, `routes/settings/prompt-templates-section.tsx:391-400`, `routes/settings/agents-section.tsx:606-615`.
- **Rule**: `SettingsField`.
- **Fix**: replace the three copies.
- **Status (#453 batch B3, settings)**: fixed – the three private copies are gone and all three sections render `SettingsField`. The entry stays until the final #453 reconciliation (B8) retires it.

### G-14 Duplicated shell helpers

- **Differs**: the violet nav badge class is declared four times (`components/app-shell.tsx:581,592`, `components/project-groups.tsx:276,337`) and the Skills update marker twice; "folder not found" renders as a danger chip in `project-groups.tsx:229` and as soft text in `command-palette.tsx:503`; `(min-width: 768px)` is subscribed inline in `app-shell.tsx:206-215` and the shape copied in `ghost-code-backdrop.tsx:210-222` while `lib/use-desktop.ts` exists; `lib/sidebar-width.ts` and `lib/sidebar-collapse.ts` repeat the same read/normalise/write triple.
- **Also (#453 batch B4)**: `useIsDesktop()` asks `(min-width: 768px)` while Tailwind's `md:` is `48rem`. They agree only at the default 16 px font size. The Tasks pages' phone toolbar and the global cards are gated by the hook alone, so they are never hidden twice, but with a larger default font size a width between 768 px and `48rem` shows neither the header nor the phone toolbar. Fix with the hook (`lib/use-desktop.ts`, outside B4): query `48rem`.
- **Rule**: one `NavBadge`; the danger chip for a missing project; `useIsDesktop()`.
- **Fix**: extract `NavBadge`; reuse the hook; share a storage helper.

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

### G-16 Toast punctuation

- **Differs**: success toasts with a period ("Team skills refreshed.", "Command copied to clipboard.") vs without ("Worktree path copied", "Worktree removed"), roughly 6 to 8; "Command copied to clipboard." and "Command copied" are the same event in two files.
- **Rule**: no period on a short fragment; a period on a full sentence with a clause.
- **Fix**: normalise the ~14 toasts; share one `copyToClipboard` helper (three copies exist in `run-header.tsx`, `review-panel.tsx`, `task-changes.tsx`).
- **Status (#453 batch B4, task lists)**: the helper exists – `copyText` in `lib/clipboard-result.ts` answers `{ ok: true }` or `{ ok: false, reason }` and never throws, so a refused or missing clipboard is never reported as copied. It has no consumer yet. Still open (B5, B6, B7): move the three copies onto it and normalise the toasts.
- **Status (#453 batch B5, thread, composer and launch menus)**: `run-header.tsx` (the resume hint, the terminal fallback and the worktree path) and `review-panel.tsx` (the manual merge line) copy through `copyText`; a refusal toasts the payload ("Run manually: …", "Path: …"), never "copied". Their toasts are fragments: "Command copied", "No terminal found — command copied", "Worktree path copied" (writing.md §13). Still open (B6, B7): `routes/task-git/task-changes.tsx` and `routes/skills.tsx`.

### G-17 Two hand-written task tables

- **Differs**: `routes/tasks-overview.tsx` is driven by `TASK_COLUMNS`; `routes/global-tasks.tsx:656-740` hard-codes its columns with an identical `Th` and `TD_BASE` and duplicates `UsageTd`/`Dash`; it degrades by hiding columns at `lg:`/`xl:` instead of cards.
- **Rule**: `task-columns.ts` for the per-project table; the global table is documented as separate.
- **Fix**: share `Th`, `TD_BASE`, `UsageTd`; decide whether the global table should fold like the other.
- **Status (#453 batch B4, task lists)**: fixed – `TASK_TH_CLASS` and `TASK_TD_CLASS` (`lib/task-columns.ts:143,145`) and `USAGE_CELL_CLASS` (`lib/tasks-table.ts:355`) are the one grammar; both tables render the exported `TaskTh` and `UsageTd` (`routes/tasks-overview.tsx:464,900`) and share `Dash`. Below `md` the global page renders cards (`GlobalTaskCard`, `routes/global-tasks.tsx:887`) with the same facts as the project cards, so it no longer only hides columns. The entry stays until B8 retires it.

### G-18 Number formatting has two byte formatters

- **Differs**: `lib/tasks-table.ts:29-34` rounds MB and kB to whole numbers; `routes/task-git/worktree-files.ts:37-38` keeps one decimal.
- **Rule**: `formatMem` in `lib/tasks-table.ts`.
- **Fix**: import it in `worktree-files.ts`.
- **Status (#453 batch B4, task lists)**: one formatter with two named contracts – `formatBytes(bytes, 'memory' | 'file')` (`lib/tasks-table.ts:54`); `formatMem` is its memory form, and the file form matches `formatFileSize` byte for byte (pinned in `design-debt-b4.test.tsx`). The precisions differ on purpose: memory rounds, file sizes keep one decimal. Still open (B6): `routes/task-git/worktree-files.ts:36` still has its own copy.

### G-19 One-off icon sizes

- **Differs**: `size-[15px]` ×12, `size-[22px]`, `size-[19px]`, `size-[13px]`, `size-[9px]` (`routes/github/github.tsx:527`) beside the `size-3` / `size-3.5` / `size-4` scale.
- **Rule**: the scale.
- **Fix**: round the one-offs to the nearest step.
- **Status (#453 batch B4, task lists)**: the task-list one-offs are gone – `size-4` for the compare icon and the variant letter, `size-5.5` for the new-task button icon, and no fixed size on the table pin (`routes/tasks-overview.tsx`; the sidebar row pin was removed with the task list in #546), `size-1.5` for the reference status dot. Still open (B5, B7): `composer/composer.tsx`, `task-thread/agents-dock.tsx`, `plan-dock.tsx`, `step-rail.tsx` and `github/github.tsx`.
- **Status (#453 batch B5, thread, composer and launch menus)**: `size-4` for the composer paperclip and the dock glyphs (was `size-[15px]` ×9), `size-3.5` for the step-rail icons (was `size-[13px]`), `size-3` for the Tools chevron (was `size-[11px]`). Still open (B7): `github/github.tsx`.

### G-20 Dead primitives

- **Differs**: `components/ui/card.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx` have zero importers.
- **Rule**: do not use them until adopted (each entry in components.md says what to use instead).
- **Fix**: delete or adopt.

### G-21 Hover-only affordances without `no-hover:`

- **Differs**: `index.css:29-31` says "Reach for this on any control that is hidden until hover"; `no-hover:` is used in exactly two files (`components/pin-toggle.tsx:49`, `routes/tasks-overview.tsx:852,867`; the sidebar row pin went with the task list in #546). The composer's attachment remove overlay (`components/composer/composer.tsx:504`) reveals on `group-hover` and `group-focus-visible` only.
- **Rule**: `no-hover:` on every hover-revealed control.
- **Fix**: add the variant to the composer overlay and audit `group-hover` sites.
- **Status (#453 batch B4, task lists)**: the task lists are done – the pin (`components/pin-toggle.tsx`) and the table's rename pencil and pin (`routes/tasks-overview.tsx:852,867`) show on a no-hover device and grow to 44 px there. Still open (B5): the composer overlay, and the run header's rename pencil (`routes/task-thread/run-header.tsx:544`), which is `opacity-0` and about 22 px on a phone.
- **Status (#453 batch B5, thread, composer and launch menus)**: fixed – the composer's attachment remove mark shows on a no-hover device as a `size-5` corner badge (the thumbnail stays visible), and the run header's rename pencil and a user message's edit and remove actions show there and grow to 44 px. `e2e/design-debt-b5.e2e.ts` measures the pencil at 1024 px no-hover and keyboard reveal on a hover device. The audit of other `group-hover` sites in B5 files found no further hidden control. The entry stays until B8 retires it.
- **Follow-up (B8, #571 design review NB-2)**: the now-visible 44 px pencil takes 28 px away from the phone run title (`routes/task-thread/run-header.tsx`), so at 375 px the title cuts off after about 15 characters ("Summarize wha…", "— a parallel fan-o…"). This is the intended G-21 trade-off, not a defect, but the title is the first thing to read on the page. Fix in B8: let the phone title wrap to two lines, or offer Rename in the run-actions menu. Evidence: `captures/subagent-thread-dark-ultra-375-none.png`, `captures/queued-bubble-actions-dark-ultra-375-none.png`, `captures/BASE-e2c00ee-subagent-thread-dark-ultra-375-none.png` (`.local/xezar-tasks/7aead3b9-f82f-42b5-895c-852c382a4ce3/` in the primary checkout).
- **Follow-up (low, #571 design review NB-4)**: a queued message's action row ("Edit the prompt", "Edit message", "Remove message") opens as a mostly empty 44 px band above the bubble's text (`routes/task-thread/thread-items.tsx`); it works, it is just heavy. Proposed: put the actions on the text's own row, or below the text. Evidence: `captures/queued-bubble-actions-dark-ultra-375-none.png`, `captures/queued-bubble-editing-dark-ultra-375-none.png`.

### G-22 Save behaviour split inside one pane

- **Differs**: `routes/settings/resources-section.tsx` saves selects on change (245-252) but needs an explicit Save for the wake interval (327).
- **Rule**: on-change for selects and switches; explicit Save for text and numbers (this is what the pane does).
- **Fix**: none needed beyond the rule; document per control.
- **Status (#453 batch B3, settings)**: verified intentional, not a defect. `design-debt-b3.test.tsx` and `e2e/design-debt-b3.e2e.ts` pin it: a select writes on change, a number field writes nothing until Save.

### G-23 Small text below AA contrast in three token pairs

- **Differs**: `--soft-foreground` is `#a3a3a3` in `.light` (`styles/index.css:198`) – 2.5:1 on `--background`, 2.4:1 on `--muted` – and it colours 10–12.5 px text (eyebrows, hints, chip counts, table headers). `--danger-foreground` (`#ffffff`) on `--danger` (`#ef4444`) is 3.8:1 for the danger button and the danger toast. `--violet-foreground` on `--violet` is 3.1:1 for the nav badge (accepted in `styles/index.css` beside the token). AA needs 4.5:1 for text this size.
- **Rule**: keep the tokens; do not add more small text in `--soft-foreground` on light, and keep the badge count announced in words.
- **Fix**: darken light `--soft-foreground` to about `#767676` (4.5:1) and revisit the danger pair; then re-check every specimen swatch.
- **Also measured (#453 batch B4, 375 px, light theme)**: three ink tokens are below 4.5:1 as small text on the task lists – `--success` (`#10b981`) 2.5:1 and `--danger` (`#ef4444`) 3.8:1 in the `+`/`−` diff counts (`components/diff-stat.tsx`), and `--violet` (`#8f86e8`) 3.1:1 in a reference chip with no forge status (`components/reference-chip.tsx`). The dark theme passes. B4 may not change a token, so `e2e/design-debt-b4.e2e.ts` reports these three colours and fails on any other. Owner: a token change after B1, through B8 reconciliation.

### G-26 The thread header shows scrolled content through it

- **Differs**: the task thread's header is `bg-background/95 … backdrop-blur md:sticky` (`routes/task-thread/run-header.tsx:160`), so thread content scrolled under it stays faintly readable beside the title and meta line, most visibly in light theme. The canonical page header (G-01) is opaque.
- **Rule**: an opaque sticky header for new work.
- **Fix**: make the run header opaque, or strong enough that text behind it does not read. Seen in the 0.15.0 docs captures (#448, design review NB-2).

### G-27 The Tasks table gives the task title the least width

- **Differs**: the Task column has no width and is meant to take the remainder (`lib/task-columns.ts:38`), but its cell is `min-w-[220px] max-w-0` (`routes/tasks-overview.tsx`) inside an auto-layout table, so it stays at 220 px and titles cut at about 20 characters while fixed columns keep theirs. With every column open the fixed widths alone pass 1,000 px, so at 1280 px beside the sidebar the table scrolls sideways and IN / OUT is cut off.
- **Rule**: new columns take a fixed width; the title is the column that grows.
- **Fix**: let the Task column absorb the free width (fixed table layout, or no `max-w-0` on the title cell) and re-check the fold defaults at 1280. Seen in the 0.15.0 docs captures (#448, design review NB-7).

### G-28 The version chip truncates at Roomy density and in the phone drawer

- **Differs**: the sidebar footer leaves the version chip too little room, and its `truncate` span (`components/app-shell.tsx:750`) reads `v0.1…`. In the desktop sidebar that happens at Roomy, while Comfortable and Compact show the whole version. In the phone drawer it also happens at Comfortable (375 px, both themes; #559 design review NB-3). Compact in the phone drawer was not measured.
- **Rule**: a version number is never truncated.
- **Fix**: give the chip `shrink-0` and let the footer's other controls give way first. Seen in the 0.15.0 docs captures (#448, design review NB-9).

### G-30 The registered-projects table scrolls sideways on a phone

- **Differs**: at 390 px the Global → Projects "Registered projects" table (`routes/settings/projects-section.tsx:277`) scrolls inside its box (567 px of content in 356 px), squeezing the Project column to 60 px, instead of reflowing as cards below `md`; pre-existing, found in the B3 design review (#519, NB-2). Owner: B8 reconciliation of #453. It was given to B4, but `projects-section.tsx` is in no remaining batch manifest (B3 owned it and has merged), so the fix needs a manifest revision first.

### G-31 The reference panel is an unnamed dialog

- **Differs**: a conflicting pull request's panel takes `role="dialog"` so its "Resolve conflicts" button can be reached (`components/reference-chip.tsx:395`), but the dialog has no accessible name, so axe-core 4.12.1 reports `aria-dialog-name` on every surface, density and theme; the chip that opens it is named. Pre-existing on `main`; found by the axe pass for #453 B4 design-review finding B-1.
- **Rule**: a `role="dialog"` always carries a name, for example `aria-labelledby` pointing at the text that already heads it.
- **Fix**: name the panel from its first line (the reference and its status) and add the axe rule to the B4 browser pass. Owner: B8 reconciliation of #453; `reference-chip.tsx` is outside the B4 source change.

### G-32 The phone run header opens partly under the top bar

- **Differs**: on a phone the task thread opens scrolled to its end, and the run header scrolls with it (it is sticky only from `md`, `routes/task-thread/run-header.tsx:160`). With a thread slightly taller than the screen, the header's first row sits under the top bar. Measured at 375 px on the `subagents-run` fixture: the page scrolls 25 px on `main` and 37 px with the B4 44 px run tabs, so the "Run actions" button (`run-header.tsx:895`) shows 27 px of 44 before B4 and 15 px after. Its centre is then under the top bar (`components/app-shell.tsx:797`), which is why a click there is refused. Pre-existing; B4's taller tabs add 12 px. Found by the #529 CI run (`e2e/design-debt-b1.e2e.ts`, which now scrolls the button into view first).
- **Rule**: a control in the page's first row is fully visible when the page opens.
- **Fix**: open a short thread at its top, or keep the phone run header's first row visible. Owner: B5 (`run-header.tsx`) or B8 reconciliation of #453; the thread's scroll behaviour is outside B4.
- **Status (#453 batch B5, thread, composer and launch menus)**: not fixed, moved to B8 reconciliation. The cause is where the phone thread opens (at its end, `thread-scroller.tsx` / `thread-scroll.ts`), a behaviour the thread-scroll specs pin; changing it is a behaviour decision, not a class change. B5's 44 px rows make the header taller, so the first row sits further under the top bar. `e2e/design-debt-b5.e2e.ts` scrolls each control into view before it measures it.

### G-33 The composer footer reflows after the model pill enables

- **Differs**: on a phone, one or two frames after the composer's model pill (`components/engine-pills.tsx:204`) stops being disabled, the footer reflows. Measured at 375 px: before B4 the pill moves 28 px sideways; with the B4 44 px phone pills it wraps to the next line (from y 218 to y 266). A click aimed at the first position then misses. A person cannot tap that fast (the move is under 25 ms), but a test can. Pre-existing; B4's larger pills turn the shift into a wrap. `e2e/design-debt-b1.e2e.ts` now waits until the pill holds still.
- **Rule**: a control is in its final place when it becomes enabled.
- **Fix**: reserve the footer's space before the late content arrives, or enable the pill in the same render. Owner: B5 (composer) or B8 reconciliation of #453.
- **Status (#453 batch B5, thread, composer and launch menus)**: not fixed, moved to B8 reconciliation. The late enable comes from `components/engine-pills.tsx`, which is in no B5 manifest file; `composer.tsx` only hosts the footer.

### G-34 The Tools trigger in the phone drawer is under the phone target

- **Differs**: in the phone drawer footer the Tools trigger (`components/tools-menu.tsx:89`, `px-2 py-0.5 text-[11px]`) is a 76×23 px target, measured at 375 px in both themes, single and multi-project. Every other control in the drawer is 44 px. Pre-existing on `main`; after #546 made the drawer navigation-only it is the one undersized control left in it. Recorded 2026-09-17 from the #559 design review (NB-2).
- **Rule**: a touch target on a phone is 44 px (`patterns.md` §6, `verification.md` § Phone targets and chip floors).
- **Fix**: give the trigger a phone tap floor such as `min-h-tap` (released at `md:`), as New task has, and re-check the footer row width together with G-28.
- **Status (#453 batch B5, thread, composer and launch menus)**: fixed – the trigger is `min-h-tap … md:min-h-0` with the focus ring; measured 77 × 44 px at comfortable in the drawer. G-28 is unchanged.

### G-35 The command palette has no visible hint and no touch path

- **Differs**: since #546 removed the sidebar's `Search…` launcher, no rendered text in the cockpit shows `⌘K` or `Ctrl+K`. The palette (`components/command-palette.tsx`) opens from the keyboard only, so people cannot discover it, and a touch-only phone cannot open it at all. Nothing is lost: every palette destination stays reachable another way – views through the nav, projects through the project groups and Add project, tasks through the Tasks pages, Toggle theme through the footer, and skills through Skills. The owner accepted losing the click path. Recorded 2026-09-17 from the #559 design review (NB-1).
- **Rule**: document ⌘K/Ctrl+K where keyboard help is shown. The cockpit has no keyboard-help surface yet, so there is no place for the hint.
- **Fix**: when a keyboard-help surface exists, list ⌘K/Ctrl+K there. Bringing back a clickable launcher is not the fix.

### G-36 Rendered Markdown's code-block actions are under the phone target

- **Differs**: the copy and download buttons on a fenced code block in a thread message are 22–26 px at 375 px across the four densities (`data-streamdown="code-block-copy-button"`, `code-block-download-button`). They come from the Markdown library (`streamdown`), configured in `routes/task-thread/markdown.tsx`. Every other thread control is 44 px. Pre-existing; found by `e2e/design-debt-b5.e2e.ts`, which reports these buttons in `known-g36-markdown-actions.json` and fails on any other small target.
- **Rule**: a touch target on a phone is 44 px.
- **Fix**: pass the library's class hook for code-block actions, or render the actions through `Button size="icon-sm"`. Owner: B8 reconciliation of #453; `markdown.tsx` is in no batch manifest.

### G-37 The desktop run tabs overlap at 1280 px

- **Differs**: at 1280 px, in both themes, the "Session / Changes / Commits / Files" run tab labels print over each other (`routes/task-thread/run-header.tsx` tab row). The base revision (`e2c00eed`) shows the same overlap, so batch B5 did not cause it. Found by the #571 design review (NB-5).
- **Rule**: tab labels never overlap at any documented width.
- **Fix**: give the tab row enough width, or wrap or truncate the labels, so the four never collide at 1280 px. Owner: B8 reconciliation of #453, or a standalone issue.

## Comment vs code

| Comment says | Code does | Where |
| --- | --- | --- |
| "Views never hand-roll a centered message" | the error boundary, `skills-loading.tsx` and `PageState` do | `components/centered-state.tsx:17-18` (G-05) |
| pulse follows the "quiet motion" rule | no reduced-motion guard | `components/status-dot.tsx:8-9,21` (G-08) |
| `run-diff.tsx` is an interim to be replaced by `DiffFileBody`'s successor | the successor shipped; two consumers were never migrated | `components/run-diff.tsx:17,145-150` (G-09) |
| "Reach for this on any control that is hidden until hover" | the task lists, the thread's pencil and message actions, and the composer's remove mark use it (#453 B5) | `styles/index.css:29-31` (G-21) |
| `PopoverTitle` is typed `h2` | renders a `div` | `components/ui/popover.tsx:67-70` (G-07) |
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
