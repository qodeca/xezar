# Known gaps

Every place where the cockpit does the same thing more than one way, or where a comment and the code
disagree, found while inventorying `packages/web/src` on 2026-09-13. Nothing here was fixed in code. For
each gap: what differs, where, which form is the rule for new work and why, and the proposed fix. The rule
is the most common form, or the newest when usage is split. This file is the design backlog, not a
to-do list: an entry becomes a `design-debt` issue on the triggers [CONTRIBUTING.md](CONTRIBUTING.md) §6
names, and a fix arrives as its own change with the entry deleted.

Ids are never reused: a deleted entry retires its number, so a new entry takes the next number after the
highest ever used. G-01..G-23 and G-25 are live, G-24 is retired, and the next free id is G-26.

Counts are non-test files or occurrences in `packages/web/src`.

## Layout and composition

### G-01 Page header markup has five shapes

- **Differs**: heading size and wrapper. Canonical `sticky top-0 z-10 hidden h-14 … md:flex` + `h1 text-base font-semibold` (8 sites: `routes/tasks-overview.tsx`, `global-tasks.tsx`, `inbox.tsx`, `skills.tsx`, `skills-loading.tsx`, `workflows/workflows.tsx`, `settings/settings-shell.tsx` ×2). `bg-background/95 backdrop-blur` + `text-lg` (`routes/repo-git/repo-git.tsx`, `routes/github/github.tsx`). `text-[15px]`, sticky from `md` (`routes/task-thread/run-header.tsx`). Centred `text-lg` (`routes/new-task.tsx`). `text-xl` (`routes/compare-variants.tsx`). `text-2xl` in a `max-w-6xl` frame (`routes/automations/automations.tsx`).
- **Rule**: the canonical form. It is the majority and the newest list pages use it.
- **Fix**: extract a `PageHeader` component; migrate Git, GitHub, Compare and Automations. The run header is a different surface (editable title) and may stay.

### G-02 Three card spellings and a dead primitive

- **Differs**: `components/ui/card.tsx` (0 importers); ad-hoc `rounded-lg border border-border bg-card` (25 sites in 15 files); `rounded-xl border bg-card p-4` (`routes/automations/automations.tsx` ×2).
- **Rule**: the ad-hoc string, plus `shadow-xs` for a raised container.
- **Fix**: either delete `card.tsx` or restyle it to the ad-hoc look and adopt it. Migrate the two `rounded-xl` cards.

### G-03 Chip class copied instead of imported

- **Differs**: `chipClass` (`components/picker-pill.tsx`) is re-declared verbatim in `components/prompt-template-menu.tsx:67` and `routes/settings/prompt-templates-section.tsx:345`, both with `disabled:opacity-50` instead of `opacity-55`. `components/facet-filter.tsx` adds a third chip height (`h-7` vs `h-[26px]`).
- **Rule**: import `chipClass`; `h-[26px]` for composer chips, `h-7` for filter chips.
- **Fix**: replace the two copies with the import; document the two heights as intentional or unify.

### G-04 `text-danger` vs `text-destructive`

- **Differs**: `text-danger` ×63 in routes and components; `text-destructive` ×4 (`routes/automations/automations.tsx:195`, `routes/settings/agent-config-section.tsx:298,311`, `components/skills-import-panel.tsx:350`). The `--destructive` alias exists for the shadcn primitives.
- **Rule**: `text-danger` in app code. Dominant and newer.
- **Fix**: replace the four sites.

### G-05 Hand-rolled centered messages

- **Differs**: `CenteredState` (60 usages) vs the route error boundary (`components/route-error-boundary.tsx`), `routes/skills-loading.tsx` (a bare centred paragraph), `PageState` in `routes/automations/automations.tsx:204` (dashed box), and ~19 inline "Loading…" lines. `centered-state.tsx:17-18` says "Views never hand-roll a centered message"; the code does.
- **Rule**: `CenteredState` for page-level states; one muted line (`px-4 py-6 text-center text-xs text-soft-foreground`) inside a surface.
- **Fix**: migrate the error boundary, `skills-loading.tsx` and `PageState`.

### G-06 Two focus-ring idioms and one unconditional animation

- **Differs**: `focus-visible:ring-[3px] focus-visible:ring-ring/50` (eight primitives, 58 route sites) vs `focus:ring-2 focus:ring-ring focus:ring-offset-2` on the dialog and sheet close buttons (`components/ui/dialog.tsx:73`, `sheet.tsx:78`). `focus-visible:border-ring` is on six primitives but not `button.tsx` or `scroll-area.tsx`. `tooltip.tsx:45` applies `animate-in` unconditionally where every other floating surface gates on `data-[state=open]`.
- **Rule**: the `focus-visible` ring.
- **Fix**: restyle the two close buttons; gate the tooltip animation.

### G-07 Primitive-level divergences

- **Differs**: Select puts its check indicator on the right, DropdownMenu on the left; Sheet is `bg-background`, Dialog `bg-card`; Tooltip `sideOffset` 0 vs 4 elsewhere; Sheet's close button uses `data-[state=open]:bg-secondary` and a hard `size-4` icon, Dialog's `bg-accent` and the auto size; Sheet exports no `Portal`/`Overlay`; variant APIs are cva (`badge`, `button`, `tabs`), inline unions (`select`, `switch`, `dropdown-menu`) or booleans (`sheet`); Textarea's disabled state lacks Input's `pointer-events-none`; `aria-invalid` styling is on four primitives only; `PopoverTitle` is typed as `h2` but renders a `div` (`components/ui/popover.tsx:67-70`).
- **Rule**: leave as is; they are documented in components.md.
- **Fix**: align on the next shadcn refresh; render `PopoverTitle` as the element it is typed as.

### G-08 Reduced-motion guards are inconsistent

- **Differs**: `motion-safe:animate-spin` ×11, `motion-reduce:animate-none` ×5, but bare `animate-pulse` in `components/status-dot.tsx:21` (every pulsing dot), `components/ui/skeleton.tsx:7`, `routes/new-task.tsx:540,1399`; bare `animate-spin` in `routes/task-thread/thread-items.tsx:344,571` and `routes/github/github.tsx:955,1050`. `status-dot.tsx:8-9` cites the "quiet motion" rule while shipping no guard. Three dots are hand-rolled instead of `StatusDot` (`components/project-groups.tsx:344`, `components/app-shell.tsx:602`, `components/composer/composer.tsx:725`); only the composer's carries the guard.
- **Rule**: new animation is `motion-safe:` or has `motion-reduce:animate-none`.
- **Fix**: add `motion-reduce:animate-none` to `statusDotVariants` and `Skeleton`; guard the four spinners; replace the three ad-hoc dots.

### G-09 Two diff renderers

- **Differs**: `components/run-diff.tsx` (review panel, compare view: own parser via `lib/unified-diff`, no gutter, no word diff, 300-line clamp, its own status badge map without `copied`, a third inline `fileKey`) vs `components/diff/` (seven routes: gutters, word marks, split mode, virtualisation). `run-diff.tsx:19` calls itself "the honest R3 interim".
- **Rule**: `Diff` from `@/components/diff`.
- **Fix**: migrate the review panel and compare view; delete `run-diff.tsx`.

### G-10 Destructive confirm styling is a copied string

- **Differs**: `bg-danger text-danger-foreground hover:brightness-[0.96]` copied in `routes/settings/remove-project.tsx:78`, `routes/task-thread/run-header.tsx:990`, `routes/workflows/workflows.tsx:667`; the irreversible overwrite confirm in `workflows.tsx:658` is unstyled; the same file uses "Keep it" and "Keep the file".
- **Rule**: tint every irreversible confirm; cancel reads "Keep it" unless a more specific kept outcome exists.
- **Fix**: add a `danger` Button variant and use it in `AlertDialogAction`.

### G-11 Raw `<select>` in settings while the Select primitive is unused

- **Differs**: `block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs …` on raw selects and number inputs ×5 (`routes/settings/resources-section.tsx:245,276,304,321`, `routes/settings/agents-section.tsx:238`); `components/ui/select.tsx` has 0 importers.
- **Rule**: the raw control class for settings (it is what ships).
- **Fix**: decide between adopting `Select` and deleting it; extract the raw class into a `NativeSelect` component.

### G-12 Search input markup duplicated

- **Differs**: a character-identical wrapper + `SearchIcon` + raw `<input>` in `routes/tasks-overview.tsx:195-208` and `routes/global-tasks.tsx:360-375`; `routes/skills.tsx:122-129` uses `Input`.
- **Rule**: `Input` with a leading icon.
- **Fix**: extract `SearchField`.

### G-13 Settings field chassis copied three times

- **Differs**: `routes/settings/settings-field.tsx` (7 importers) vs private `Field` in `routes/settings/appearance.tsx:101-111`, `routes/settings/prompt-templates-section.tsx:391-400`, `routes/settings/agents-section.tsx:606-615`.
- **Rule**: `SettingsField`.
- **Fix**: replace the three copies.

### G-14 Duplicated shell helpers

- **Differs**: the violet nav badge class is declared four times (`components/app-shell.tsx:581,592`, `components/project-groups.tsx:276,337`) and the Skills update marker twice; "folder not found" renders as a danger chip in `project-groups.tsx:229` and as soft text in `command-palette.tsx:503`; `(min-width: 768px)` is subscribed inline in `app-shell.tsx:206-215` and the shape copied in `ghost-code-backdrop.tsx:210-222` while `lib/use-desktop.ts` exists; `lib/sidebar-width.ts` and `lib/sidebar-collapse.ts` repeat the same read/normalise/write triple.
- **Rule**: one `NavBadge`; the danger chip for a missing project; `useIsDesktop()`.
- **Fix**: extract `NavBadge`; reuse the hook; share a storage helper.

### G-15 Copy inconsistencies

| What differs | Majority (the rule) | Minority | Where |
| --- | --- | --- | --- |
| Load-error title | "Could not load X" (14) | "X did not load" (9) | 8 of 9 under `routes/settings/` |
| Retry label | "Retry" (5) | "Try again" (3) | `routes/settings/provider-settings.tsx` has both |
| Search placeholder case | "Search tasks…" (12) | "search skills…" (6) | `routes/new-task.tsx`, `hand-to-agent.tsx`, `prompt-template-menu.tsx`, `prompt-templates-section.tsx` |
| Dash | ` — ` (334) | ` – ` (10) | 9 in `routes/settings/mcp-api-section.tsx`, 1 in `mcp-connection-section.tsx:448` |
| Negatives | "could not" (21) | "couldn’t" (7) | `routes/github/github.tsx` has both |
| Apostrophes | curly `’` (28) | straight `'` (~12) | `routes/settings/appearance.tsx`, `compare-loading.tsx`, `task-commits.tsx`, `project-general.tsx` |
| Curly quotes | literal `“ ”` | `&ldquo;`/`&rdquo;` entities | `routes/workflows/workflows.tsx:641,658` |
| Narrow-a-list verb | "Filter skills…" | "search skills…" | `routes/settings/prompt-templates-section.tsx:357` |
| Empty list text | "Nothing matches." (5) | "No skills match.", "(no skills match)" | `routes/workflows/workflows.tsx:946`, `routes/skills.tsx:153` |
| Column label case | sentence case | "Tool Name" | `lib/task-columns.ts:62` |
| Heading period | none | "This page could not be displayed." | `components/route-error-boundary.tsx:27` |
| Bucket label case | "Needs you" (heading) | "needs you" (dot label) | `lib/task-groups.ts:20` vs `lib/attention.ts:111`, intentional per the comment |
| Oxford comma | omitted (25) | present (2) | `routes/settings/agents-section.tsx:315`, `notifications-section.tsx:97` |

- **Fix**: one copy pass over the minority sites; a `no-en-dash-in-ui` guardian rule.

### G-16 Toast punctuation

- **Differs**: success toasts with a period ("Team skills refreshed.", "Command copied to clipboard.") vs without ("Worktree path copied", "Worktree removed"), roughly 6 to 8; "Command copied to clipboard." and "Command copied" are the same event in two files.
- **Rule**: no period on a short fragment; a period on a full sentence with a clause.
- **Fix**: normalise the ~14 toasts; share one `copyToClipboard` helper (three copies exist in `run-header.tsx`, `review-panel.tsx`, `task-changes.tsx`).

### G-17 Two hand-written task tables

- **Differs**: `routes/tasks-overview.tsx` is driven by `TASK_COLUMNS`; `routes/global-tasks.tsx:656-740` hard-codes its columns with an identical `Th` and `TD_BASE` and duplicates `UsageTd`/`Dash`; it degrades by hiding columns at `lg:`/`xl:` instead of cards.
- **Rule**: `task-columns.ts` for the per-project table; the global table is documented as separate.
- **Fix**: share `Th`, `TD_BASE`, `UsageTd`; decide whether the global table should fold like the other.

### G-18 Number formatting has two byte formatters

- **Differs**: `lib/tasks-table.ts:29-34` rounds MB and kB to whole numbers; `routes/task-git/worktree-files.ts:37-38` keeps one decimal.
- **Rule**: `formatMem` in `lib/tasks-table.ts`.
- **Fix**: import it in `worktree-files.ts`.

### G-19 One-off icon sizes

- **Differs**: `size-[15px]` ×9, `size-[22px]`, `size-[19px]`, `size-[13px]`, `size-[9px]` (`routes/github/github.tsx:527`) beside the `size-3` / `size-3.5` / `size-4` scale.
- **Rule**: the scale.
- **Fix**: round the one-offs to the nearest step.

### G-20 Dead primitives

- **Differs**: `components/ui/card.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx` have zero importers.
- **Rule**: do not use them until adopted (each entry in components.md says what to use instead).
- **Fix**: delete or adopt.

### G-21 Hover-only affordances without `no-hover:`

- **Differs**: `index.css:29-31` says "Reach for this on any control that is hidden until hover"; `no-hover:` is used at exactly two sites (`components/task-quick-list.tsx:339`, `routes/tasks-overview.tsx:807`). The composer's attachment remove overlay (`components/composer/composer.tsx:504`) reveals on `group-hover` and `group-focus-visible` only.
- **Rule**: `no-hover:` on every hover-revealed control.
- **Fix**: add the variant to the composer overlay and audit `group-hover` sites.

### G-22 Save behaviour split inside one pane

- **Differs**: `routes/settings/resources-section.tsx` saves selects on change (245-252) but needs an explicit Save for the wake interval (325).
- **Rule**: on-change for selects and switches; explicit Save for text and numbers (this is what the pane does).
- **Fix**: none needed beyond the rule; document per control.

### G-23 Small text below AA contrast in three token pairs

- **Differs**: `--soft-foreground` is `#a3a3a3` in `.light` (`styles/index.css:198`) – 2.5:1 on `--background`, 2.4:1 on `--muted` – and it colours 10–12.5 px text (eyebrows, hints, chip counts, table headers). `--danger-foreground` (`#ffffff`) on `--danger` (`#ef4444`) is 3.8:1 for the danger button and the danger toast. `--violet-foreground` on `--violet` is 3.1:1 for the nav badge (accepted in `styles/index.css` beside the token). AA needs 4.5:1 for text this size.
- **Rule**: keep the tokens; do not add more small text in `--soft-foreground` on light, and keep the badge count announced in words.
- **Fix**: darken light `--soft-foreground` to about `#767676` (4.5:1) and revisit the danger pair; then re-check every specimen swatch.

### G-25 No rhythm scale; between-block spacing is chosen per file

- **Differs**: the six rhythm tokens exist (`styles/index.css` `@theme static`, foundations.md §4.1), but only the Settings panes use them (`gap-section` between fields, `gap-stack` inside one). Everywhere else the gap between blocks is a bare number picked per file: thread rows `pb-2.5` (`routes/task-thread/thread-scroller.tsx`), cards `p-4` with `gap-2.5` between them (`routes/inbox.tsx`), page bodies `p-3 … md:p-5` (`routes/settings/settings-shell.tsx`, `routes/global-tasks.tsx`).
- **Rule**: the rhythm tokens – a gap between blocks is `row`, `stack`, `list`, `inset`, `group` or `section`; the settings fields already use them.
- **Fix**: step 2 of #424 moves the cockpit onto the tokens (design `designs/design-system-air/` § 9.2) and deletes this entry, with a `design-debt` issue linked for the sibling mockups.

## Comment vs code

| Comment says | Code does | Where |
| --- | --- | --- |
| "Views never hand-roll a centered message" | the error boundary, `skills-loading.tsx` and `PageState` do | `components/centered-state.tsx:17-18` (G-05) |
| pulse follows the "quiet motion" rule | no reduced-motion guard | `components/status-dot.tsx:8-9,21` (G-08) |
| `run-diff.tsx` is an interim to be replaced by `DiffFileBody`'s successor | the successor shipped; two consumers were never migrated | `components/run-diff.tsx:19,145-150` (G-09) |
| "Reach for this on any control that is hidden until hover" | two sites use it | `styles/index.css:29-31` (G-21) |
| `PopoverTitle` is typed `h2` | renders a `div` | `components/ui/popover.tsx:67-70` (G-07) |
| the reference tones share `StatusDot`'s five roles | `ReferenceStatusTone` adds `info` and `conflict`, which `StatusDot` cannot paint | `lib/reference-status.ts:11-13`, `components/reference-chip.tsx:469` |

## Mockup fidelity (designs/quality-checks on the shared stylesheet)

The shared stylesheet keeps the mockup's own class values so the quality-checks pages look unchanged.
Where those values differ from the cockpit, the delta is recorded here and the cockpit value is the rule
for new work.

| Class | Mockup value (shipped in `cockpit.css`) | Cockpit value | Source |
| --- | --- | --- | --- |
| `.btn` (small button) | 30px, `padding 0 12px`, weight 500, 12.5px | `h-[30px] px-2.5 text-[12.5px] font-semibold` | `components/ui/button.tsx` |
| `.btn-new-task` | 34px | `h-9` (36px), `font-semibold` | `components/app-shell.tsx:516` |
| `.list-tabs span.on` | `bg card-2`, weight 500 | `bg-card font-semibold shadow-xs` | `components/task-quick-list.tsx:192` |
| `.tasks-table th` | 11.5px, weight 500, no transform | `text-[11px] font-semibold tracking-[0.05em] uppercase` | `routes/tasks-overview.tsx:414-422` |
| `.nav-badge.danger` | red badge | no red nav badge exists; the cockpit's badges are violet | design decision, pending review |
| `.qc-empty` | dashed box, 40px icon, 15px title | `CenteredState`: 72px tile, `text-2xl` | `components/centered-state.tsx` |
| `.qc-skeleton` | sheen sweep | `animate-pulse rounded-md bg-accent` | `components/ui/skeleton.tsx` |
| `.qc-toast` | card surface with a success icon | `bg-contrast text-contrast-foreground`, no icon | `components/ui/toaster.tsx` |
| `--diff-add` / `--diff-del` (removed) | mockup-only aliases | `text-success` / `text-danger` | `components/diff-stat.tsx` |
| `.qc-alert` | card with a danger-tinted border and icon | `banner-row` with the `alert` tone | `components/provider-banner.tsx` |
| `.btn.contrast:hover` (new) | the mockup had no hover, so a contrast button turned `--muted` on hover | `filter: brightness(0.96)` | `components/ui/button.tsx` |
| `.tasks-table tbody tr:hover` (new) | the mockup had no row hover | `hover:bg-muted` | `routes/tasks-overview.tsx` |

Proposed fix: when the quality-checks design gets its review, restyle those classes to the cockpit
values and drop the `qc-` prefixed ones in favour of the shared `.centered-state`, `.skeleton` and
`.toast` classes.
