# Components

Every primitive in `packages/web/src/components/ui/` and every shared module in
`packages/web/src/components/` (including `composer/` and `diff/`). One entry per file, in a fixed order:
purpose · source · variants and props that matter · states · rules · accessibility · where used.
"Where used" counts importing files outside tests on 2026-09-13. Class strings are quoted from the source.

Definitions the drift test uses:

- **Primitive**: a non-test `.tsx` file in `packages/web/src/components/ui/`.
- **Shared component**: a non-test `.ts` or `.tsx` file directly in `packages/web/src/components/` or in
  `packages/web/src/components/composer/` or `packages/web/src/components/diff/`. Helper modules
  (`nav-items.ts`, `composer-text.ts`, `diff/types.ts`) count: they carry rules a design must know.

Shared foundations: `components.json` (shadcn `new-york`, base colour `neutral`, CSS variables, lucide);
`lib/utils.ts` exports `cn` (`twMerge(clsx(...))`, taught that `shadow-modal` is a shadow step).
Every primitive sets `data-slot="<name>"`; variant-bearing ones add `data-variant` / `data-size`. Radix
comes from the single `radix-ui` package; there is no `sonner`, the toast is hand-rolled.

## 1. Primitives (`src/components/ui/`)

### Button

- **Purpose**: every clickable action. Two filled CTAs, two quiet shapes, one destructive shape.
- **Source**: `packages/web/src/components/ui/button.tsx`. Exports `Button`, `buttonVariants`.
- **Variants** (`variant`, default `primary`): `primary` = `bg-primary text-primary-foreground hover:brightness-[0.96]`; `contrast` = `bg-contrast text-contrast-foreground hover:brightness-[0.96]`; `outline` = `border border-border bg-card hover:bg-muted`; `ghost` = `text-muted-foreground hover:bg-muted hover:text-foreground`; `danger-ghost` = `text-danger hover:bg-danger/10`. There is deliberately no `secondary`, `destructive` or `link`.
- **Sizes** (`size`, default `default`): `default` = `h-9 px-3.5 text-[13.5px]`; `sm` = `h-[30px] rounded-sm px-2.5 text-[12.5px]`; `icon` = `size-9`; `icon-sm` = `size-[30px] rounded-sm`.
- **Base**: `inline-flex … gap-[7px] rounded-md font-semibold … focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50`; unsized svg children become `size-4`. `asChild` renders a Radix `Slot`.
- **States**: hover (brightness or background), focus-visible ring, disabled (50% opacity, no pointer events), pending (caller swaps the label to `Verb-ing…` and disables).
- **Rules**: DO use `contrast` for the sidebar CTA and dialog confirms, `primary` for the one send/start action on a surface, `outline` for cancel, `ghost` for icon buttons, `danger-ghost` for destructive row actions. DO NOT hand-write `bg-danger text-danger-foreground` on a confirm when the confirm is destructive; the three current copies are known gap G-10. DO NOT add a `secondary` variant.
- **Accessibility**: an icon-only button MUST carry `aria-label`. Touch targets on phone are `size-11`.
- **Where used**: 44 files (most-imported primitive).

### Badge

- **Purpose**: a small label chip (`git`, `already added`).
- **Source**: `packages/web/src/components/ui/badge.tsx`. Exports `Badge`, `badgeVariants`.
- **Variants** (`variant`, default `default`): `default` (`bg-primary`), `secondary` (`bg-secondary`), `destructive` (`bg-destructive`), `outline` (`border-border text-foreground`), `ghost`, `link`. Base `rounded-full border border-transparent px-2 py-0.5 text-xs font-medium`; svg children forced to `size-3`. `asChild` supported.
- **States**: hover only when rendered as a link (`[a&]:hover:…`); focus-visible ring; `aria-invalid` styling.
- **Rules**: DO use `outline` and `ghost` (the two variants the cockpit uses). DO NOT use Badge for run status; that is `Pill` + `StatusDot`.
- **Accessibility**: plain span; no role.
- **Where used**: 3 files (`add-project-dialog.tsx`, `settings/accounts-section.tsx`, `settings/agent-config-section.tsx`).

### Card

- **Purpose**: stock shadcn card (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`).
- **Source**: `packages/web/src/components/ui/card.tsx`. Root class `flex flex-col gap-6 rounded-lg border bg-card py-6 text-card-foreground shadow-xs`.
- **States**: none.
- **Rules**: the cockpit does not use this primitive. The card spelling in use is the ad-hoc `rounded-lg border border-border bg-card` (22 sites in 15 files) with `shadow-xs` where it is a raised container. That ad-hoc string, with `p-inset` inside and `gap-list` between cards, is the rule for new work (known gap G-02). DO NOT introduce a third spelling (`rounded-xl border bg-card p-4` exists twice, in `routes/automations/automations.tsx`).
- **Where used**: 0 files.

### Collapsible

- **Purpose**: unstyled open/close wrapper (Radix).
- **Source**: `packages/web/src/components/ui/collapsible.tsx`. Exports `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`. Adds only `data-slot`.
- **Rules**: the trigger MUST be a real button (Radix supplies `aria-expanded`). Rotate the chevron with `rotate-90` (`-rotate-90` when collapsed) and `transition-transform`.
- **Where used**: 4 files (`run-diff.tsx`, `compare-variants.tsx`, `task-thread/step-rail.tsx`, `task-thread/thread-items.tsx`).

### Command

- **Purpose**: cmdk list and the `CommandDialog` wrapper for the palette and every searchable picker.
- **Source**: `packages/web/src/components/ui/command.tsx`. Exports `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator`.
- **Props that matter**: `CommandDialog` takes `title` (default `"Command Palette"`), `description` (default `"Search for a command to run..."`, both rendered `sr-only`), `showCloseButton` (default `true`), and a custom `filter` forwarded to cmdk so a dialog can rank its own results.
- **States**: `CommandItem` uses `data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground` and `data-[disabled=true]:opacity-50`; input `h-12`, items `px-2 py-3`.
- **Rules**: DO give every dialog a `title` and `description` (the default description is the one `...` in the codebase; pass your own). DO render `<CommandEmpty>Nothing matches.</CommandEmpty>`. DO NOT rely on the default subsequence scorer for id-like data; pass `filter` (see `paletteScore`).
- **Accessibility**: the sr-only header names the dialog; cmdk drives arrow keys and selection without moving DOM focus.
- **Where used**: 8 files (`command-palette.tsx`, `composer/composer.tsx`, `facet-filter.tsx`, `prompt-template-menu.tsx`, `routes/github/github.tsx`, `routes/github/hand-to-agent.tsx`, `routes/new-task.tsx`, …).

### Dialog

- **Purpose**: a modal for forms and previews.
- **Source**: `packages/web/src/components/ui/dialog.tsx`. Exports `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger`.
- **Props that matter**: `DialogContent showCloseButton` (default `true`); `DialogFooter showCloseButton` (default `false`, renders an `outline` "Close" button).
- **Look**: overlay `bg-black/50` with fade; content `w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border bg-card p-6 shadow-modal duration-200 … zoom-in-95 sm:max-w-lg`; footer `flex flex-col-reverse gap-2 sm:flex-row sm:justify-end`.
- **States**: open/closed animations on `data-[state]`; close button `opacity-70 hover:opacity-100` with a `focus:ring-2` ring (the older idiom, known gap G-06).
- **Rules**: DO put the cancel button first in DOM order and the confirm last (the footer reverses on phone so the confirm sits on top). DO use `AlertDialog` instead when the action is destructive. DO NOT nest a scroller taller than `max-h-[80dvh]` (skill preview) without `overflow-y-auto`.
- **Accessibility**: always render `DialogTitle` (`sr-only` if visually elsewhere) and a `DialogDescription`, or pass `aria-describedby={undefined}` deliberately.
- **Where used**: 9 files.

### AlertDialog

- **Purpose**: the confirm surface for destructive or irreversible actions. Replaces the banned native `confirm()`.
- **Source**: `packages/web/src/components/ui/alert-dialog.tsx`. Exports the Radix parts plus `AlertDialogAction` (styled `buttonVariants({ variant: "contrast" })`) and `AlertDialogCancel` (`outline`).
- **Look**: same overlay and content as Dialog with `sm:max-w-md`, no close button.
- **States**: no outside-click dismiss; focus starts on the cancel action.
- **Rules**: DO title it as a question (`Delete this task?`), state the consequence, add `There is no undo.` when true, and word the cancel as the kept outcome (`Keep it`). DO tint a destructive action with `bg-danger text-danger-foreground hover:brightness-[0.96]`. DO NOT use it for a non-destructive form.
- **Accessibility**: `role="alertdialog"` from Radix.
- **Where used**: 8 files (`compare-variants.tsx`, `plan-review.tsx`, `settings/accounts-section.tsx`, `settings/remove-project.tsx`, `settings/worktrees-panel.tsx`, `task-thread/link-safety-dialog.tsx`, `task-thread/run-header.tsx`, `workflows/workflows.tsx`).

### Sheet

- **Purpose**: a side drawer (a Radix Dialog anchored to an edge).
- **Source**: `packages/web/src/components/ui/sheet.tsx`. Exports `Sheet`, `SheetTrigger`, `SheetClose`, `SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription`.
- **Props that matter**: `side` (`top | right | bottom | left`, default `right`), `showCloseButton` (default `true`). Left/right are `w-3/4 sm:max-w-sm`; the shell overrides to `w-[264px]`.
- **Look**: `bg-background shadow-modal`, slide in 500ms, out 300ms.
- **Rules**: DO use `side="left"` for navigation (the mobile drawer) and `right` for detail drill-downs (sub-agent sheet). DO give it an `sr-only` `SheetTitle`.
- **Where used**: 2 files (`app-shell.tsx`, `task-thread/subagent-sheet.tsx`).

### DropdownMenu

- **Purpose**: action menus and radio pickers.
- **Source**: `packages/web/src/components/ui/dropdown-menu.tsx`. Exports the full Radix set (`DropdownMenu`, `Trigger`, `Content`, `Group`, `Label`, `Item`, `CheckboxItem`, `RadioGroup`, `RadioItem`, `Separator`, `Shortcut`, `Sub`, `SubTrigger`, `SubContent`, `Portal`).
- **Props that matter**: `Content sideOffset` default `4`; `Item variant` `default | destructive` (`data-[variant=destructive]:text-destructive`); `inset` on item, label and sub-trigger.
- **Look**: content `min-w-[8rem] rounded-md border bg-popover p-1 shadow-md` with slide/zoom animations; items `focus:bg-accent`.
- **Rules**: DO use `DropdownMenuRadioGroup` for single-choice pills (`PickerPill`). DO use `variant="destructive"` for delete/cancel items. Indicators sit on the left (Select's sit on the right, G-07).
- **Where used**: 7 files (`app-shell.tsx`, `open-in-menu.tsx`, `picker-pill.tsx`, `tools-menu.tsx`, `settings/accounts-section.tsx`, `task-git/git-toolbar.tsx`, `task-thread/run-header.tsx`).

### Popover

- **Purpose**: anchored floating panel (filters, template picker, reference chip card, composer autocomplete).
- **Source**: `packages/web/src/components/ui/popover.tsx`. Exports `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor`, `PopoverHeader`, `PopoverTitle`, `PopoverDescription` (the last three are local additions).
- **Props that matter**: `align` default `center`, `sideOffset` default `4`; `collisionPadding` is merged with the keyboard insets (`keyboardAwareCollisionPadding`) so a popover near the composer clears the iOS keyboard.
- **Look**: `w-72 rounded-md border bg-popover p-4 shadow-md` with slide/zoom animations.
- **Rules**: DO prevent `onOpenAutoFocus` when the popover opens from hover or from typing (the reference chip, the composer menu). DO clamp lists to `--radix-popover-content-available-height`.
- **Accessibility**: `PopoverTitle` renders a `div` although typed as `h2` (G-07).
- **Where used**: 10 files.

### Tooltip

- **Purpose**: short hover label.
- **Source**: `packages/web/src/components/ui/tooltip.tsx`. Exports `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`.
- **Props that matter**: `TooltipProvider delayDuration` default `0`; `TooltipContent sideOffset` default `0`; the arrow always renders. `Tooltip` does not self-wrap in a provider.
- **Look**: `bg-contrast text-contrast-foreground rounded-md px-3 py-1.5 text-xs text-balance`, `animate-in fade-in-0 zoom-in-95` (unconditional, G-06).
- **Rules**: DO wrap the table in one `TooltipProvider`. DO prefer the native `title` attribute for tooltips that merely add information (~110 sites); Tooltip is for the column header toggles. DO NOT rely on a tooltip as the only carrier of meaning on touch.
- **Where used**: 2 files (`routes/global-tasks.tsx`, `routes/tasks-overview.tsx`).

### Input

- **Purpose**: single-line text field.
- **Source**: `packages/web/src/components/ui/input.tsx`. Exports `Input`.
- **Look**: `h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-base shadow-xs … placeholder:text-soft-foreground md:text-sm`; focus `focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50`; invalid `aria-invalid:border-destructive aria-invalid:ring-destructive/20`; disabled `pointer-events-none cursor-not-allowed opacity-50`.
- **Rules**: DO keep `text-base` on phone (iOS zooms below 16px). DO pair with `Label htmlFor` or `aria-label`. Two routes hand-roll the search input markup instead of using Input (G-12); new search fields use `Input`.
- **Where used**: 9 files.

### Textarea

- **Purpose**: multi-line field that grows with content.
- **Source**: `packages/web/src/components/ui/textarea.tsx`. Exports `Textarea`.
- **Look**: `field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-base shadow-xs … md:text-sm`; same focus and invalid rings as Input; disabled has no `pointer-events-none` (G-07).
- **Rules**: DO submit with ⌘↵ / Ctrl+↵ (`isSubmitShortcut`) and keep plain Enter as a newline in dialogs. DO save on an explicit button for long text; never PUT on every keystroke.
- **Where used**: 8 files.

### Label

- **Purpose**: form label (Radix).
- **Source**: `packages/web/src/components/ui/label.tsx`. Class `flex items-center gap-2 text-sm leading-none font-medium select-none`; dims with a disabled `peer` or `group`.
- **Where used**: 2 files (`clone-project-dialog.tsx`, `routes/automations/automations.tsx`).

### Select

- **Purpose**: stock shadcn select.
- **Source**: `packages/web/src/components/ui/select.tsx`. `SelectTrigger size` `sm | default` (`h-8` / `h-9`); `SelectContent position` defaults to `item-aligned`.
- **Rules**: unused. Settings pages render a raw `<select>` with a raw class of the shape `block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50` – that exact string at two sites (`routes/settings/agents-section.tsx:237`, `routes/repo-git/repo-branches.tsx:162`), width and focus variants at eight more (G-11). That raw select is the rule for new settings work until the gap is closed.
- **Where used**: 0 files.

### Switch

- **Purpose**: on/off preference.
- **Source**: `packages/web/src/components/ui/switch.tsx`. `size` `sm | default`; track `data-[state=checked]:bg-primary data-[state=unchecked]:bg-input`; thumb `bg-background` (equals `--primary-foreground` in dark, so no `dark:` needed).
- **States**: checked/unchecked, focus-visible ring, disabled 50%.
- **Rules**: DO save on change and toast the new state (`Live title updates on`). DO put the visible label in a `SettingsField` title.
- **Accessibility**: `role="switch"` and `aria-checked` from Radix; label via `aria-label` or `aria-labelledby`.
- **Where used**: 4 files (settings: agents, notifications, provider, skills).

### Tabs

- **Purpose**: segmented tabs (Radix).
- **Source**: `packages/web/src/components/ui/tabs.tsx`. Exports `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `tabsListVariants`.
- **Variants** (`TabsList variant`, default `default`): `default` = `bg-muted` track, active trigger `bg-card font-semibold text-foreground shadow-xs`; `line` = transparent track with a `after:` underline on the active trigger. Trigger text `text-[12.5px] font-medium`.
- **Rules**: DO use Tabs for real panel switching. For URL-backed segments use `TabLink`; for filters that re-slice one list use `aria-pressed` toggle buttons (`SegmentedControl`, the Active/Archived tabs).
- **Where used**: 1 file (`settings/accounts-section.tsx`).

### Separator

- **Purpose**: 1px rule. `decorative` defaults to `true`.
- **Source**: `packages/web/src/components/ui/separator.tsx`.
- **Rules**: unused; routes use `border-t border-border` or `divide-y`. Either is fine.
- **Where used**: 0 files.

### ScrollArea

- **Purpose**: stock Radix scroll area.
- **Source**: `packages/web/src/components/ui/scroll-area.tsx`. Always renders a vertical `ScrollBar`.
- **Rules**: unused. The cockpit relies on native `overflow-y-auto overscroll-contain` and the slim 8px scrollbars from the base layer.
- **Where used**: 0 files.

### Skeleton

- **Purpose**: loading placeholder block.
- **Source**: `packages/web/src/components/ui/skeleton.tsx`. Class `animate-pulse rounded-md bg-accent`.
- **Rules**: prefer `CenteredState` with a spinner for page-level loading (six `*-loading.tsx` routes do). Skeleton is for list rows whose shape is known (GitHub list). The pulse has no reduced-motion guard (G-08).
- **Where used**: 1 file (`routes/github/github.tsx`).

### Toaster

- **Purpose**: transient "that worked / that did not" line. A module-level store, not a library.
- **Source**: `packages/web/src/components/ui/toaster.tsx`. Exports `toast(message, { tone })`, `resetToasts`, `Toaster`, types `ToastTone`, `ToastItem`.
- **Props that matter**: `tone` `default | danger` (default `default`). Lifetime `TOAST_MS = 5000`, exit `EXIT_MS = 200`.
- **Look**: outlet `fixed top-[calc(61px+env(safe-area-inset-top))] right-[calc(16px+env(safe-area-inset-right))] z-[60] … md:top-[calc(16px+env(safe-area-inset-top))]`; toast `max-w-[min(360px,calc(100vw-32px))] rounded-md px-3.5 py-2.5 text-[13px] font-medium shadow-modal`, `bg-contrast text-contrast-foreground` or `bg-danger text-danger-foreground`; `motion-safe:` slide from the right.
- **Rules**: DO call `toast(error.message, { tone: 'danger' })` in every mutation `onError` (the repo-wide error doctrine: the server's words, verbatim). DO keep success toasts to one short sentence. DO NOT call `toast.success` or `toast.error`; they do not exist.
- **Accessibility**: each toast is `role="status"`.
- **Where used**: 41 files import `toast`; one (`app.tsx`) mounts `Toaster`.

## 2. Shared components (`src/components/`)

### AppShell

- **Purpose**: the presentational shell: fixed sidebar plus one scrolling main region.
- **Source**: `packages/web/src/components/app-shell.tsx`. Exports `AppShell`, `useSidebarNavigate`, `routeOwnsScrollArrival`, types `RepoChip`, `AppShellProps`.
- **Props that matter**: `repo`, `inboxCount`, `unreadCount`, `skillsUpdateAvailable`, `version`, `latestVersion`, `channel` (development-build badge), `taskQuickList`, `toolsMenu`, `forgeAvailable`, `inboxAvailable`, `automationsAvailable`, `singleProject`, `banner`, `projectGroups` (replaces the flat nav).
- **Layout**: root `flex h-dvh overflow-hidden … pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]`; main column `grid grid-rows-[auto_auto_1fr_auto]` (mobile top bar · banner · scroller · composer); `<main data-slot="main" class="row-start-3 min-h-0 overflow-y-auto overscroll-contain">` is the only scroller. Desktop sidebar `hidden md:flex … border-r border-border bg-sidebar`, width from state (264–420px) with an ARIA `separator` resize handle. Mobile drawer is a `Sheet side="left"` at `w-[264px] bg-sidebar`.
- **Nav row**: `flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[34px]`; active adds `bg-muted font-semibold text-foreground` and `aria-current="page"`. The `md:h-[34px]` height moves to `md:h-9` in step 3b of #424.
- **Badges**: `ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground` (Inbox count, unread count); the Skills update marker is a `size-1.5` violet dot plus `sr-only` text.
- **Brand tile and development-build badge** (#442, decisions.md D-08): the private `BrandTile` renders `/xezar.svg` as `<img data-slot="brand-tile" alt="" aria-hidden="true" class="size-[26px] shrink-0 rounded-sm">`. When the `channel` prop is `'dev'` it wraps the image in `relative flex shrink-0` and adds `<span data-slot="dev-badge" title="Development build" class="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-danger text-[9px] leading-none font-semibold text-primary-foreground ring-2 ring-sidebar">` holding an `aria-hidden` "D" and `sr-only` "Development build". Any other value renders the bare image. `AppShellContainer` passes `health.channel ?? null`.
- **States**: drawer open/closed (closes on route change and when `(min-width: 768px)` matches), active route, absent data renders nothing (no repo chip, no badge at 0 or null).
- **Rules**: DO add a nav item in `nav-items.ts`, never in the shell. DO keep the shell presentational; data lives in `AppShellContainer`. DO NOT add a second page scroller.
- **Accessibility**: `<nav aria-label="Main">`, `aria-current`, `SheetTitle` "Navigation" (`sr-only`), `aria-label="Open menu"` / `"Close menu"`, resize handle `role="separator" aria-orientation="vertical" aria-valuenow/min/max` with arrow, Home and End keys.
- **Where used**: 2 files (`app-shell-container.tsx`, `project-groups.tsx`).

### AppShellContainer

- **Purpose**: wires health, todos, runs and the registry into `AppShell`; mounts `CommandPalette`, `ListViewProvider`, the provider banner and the quick list; sets the document title.
- **Source**: `packages/web/src/components/app-shell-container.tsx`. Exports `AppShellContainer`, `repoChipOf`, `skillsUpdateMarkerOf`.
- **Rules**: badge counts are `?? null` (no badge while unknown), never `?? 0`. The project switcher appears only from the second registered project.
- **Where used**: 2 files (`app.tsx`, `settings/bookmarklets-section.tsx`).

### AppearanceProvider

- **Purpose**: owns accent, density and width; applies `data-*` attributes in a layout effect; writes the full appearance object to `ui-state.json`.
- **Source**: `packages/web/src/components/appearance-provider.tsx`. Exports `AppearanceProvider`, `useAppearance`.
- **States**: a failed write toasts the server's message and refetches.
- **Where used**: 2 files (`app.tsx`, `settings/appearance.tsx`).

### ThemeProvider and ThemeToggle

- **Purpose**: theme preference (`light | dark | system`) and the one-button cycle.
- **Source**: `packages/web/src/components/theme-provider.tsx` (`ThemeProvider`, `useTheme`), `packages/web/src/components/theme-toggle.tsx` (`ThemeToggle`, `NEXT_THEME`).
- **Look**: `Button variant="ghost" size="icon-sm"` with `SunIcon | MoonIcon | MonitorIcon` showing the choice, not the resolved palette.
- **Accessibility**: `aria-label="Theme: {current}. Switch to {next}."`, `title="Theme: {current}"`.
- **Where used**: provider 4 files; toggle 2 files (`app-shell.tsx`, `command-palette.tsx`).

### CenteredState and TwinkleBackdrop

- **Purpose**: the one template for loading, paused, error and empty states. "Views never hand-roll a centered message."
- **Source**: `packages/web/src/components/centered-state.tsx`. Exports `CenteredState`, `TwinkleBackdrop`, type `CenteredStateTone`.
- **Props**: `icon` (required), `title` (required), `subtitle`, `children`, `actions`, `tone` `neutral | primary | danger` (default `neutral`), `backdrop` (default `false`), `heading` `h1 | h2` (default `h1`), `className`.
- **Look**: root `flex min-h-full flex-1 flex-col items-center justify-center px-6 py-12 text-center`; tile `size-[72px] rounded-[18px] border` with tone `neutral` = `border-border bg-card text-foreground shadow-xs`, `primary` = `border-primary/25 bg-primary/15 text-primary`, `danger` = `border-danger/20 bg-danger/15 text-danger`; title `text-2xl font-semibold text-balance`; subtitle `text-sm text-pretty text-muted-foreground`; actions `flex gap-3 pt-2`.
- **Rules**: DO use `heading="h2"` under an existing page heading. DO use `tone="danger"` with the server message as the subtitle for load errors. DO reserve `backdrop` for the hero empty state (first task, `/new`). DO NOT hand-roll a centered message (the route error boundary and `skills-loading.tsx` do; G-05).
- **Accessibility**: the backdrop is `aria-hidden` and `pointer-events-none`; twinkles are `motion-safe:animate-pulse`.
- **Where used**: 39 files.

### StatusDot

- **Purpose**: the 7px dot, the design system's single carrier of status colour.
- **Source**: `packages/web/src/components/status-dot.tsx`. Exports `StatusDot`, `statusDotVariants`, type `StatusDotTone`.
- **Variants**: `tone` `success | pending | danger | violet | neutral` (default `neutral`) → `bg-success | bg-pending | bg-danger | bg-violet | bg-soft-foreground`; `pulse` adds `animate-pulse`. Base `inline-block size-[7px] shrink-0 rounded-full`.
- **Rules**: DO derive tone and pulse from `deriveAttention(run)`. DO give it `role="img"` and `aria-label={attention.label}` when it stands alone. DO NOT hand-roll a dot (three ad-hoc dots exist, G-08).
- **Where used**: 12 files.

### Pill

- **Purpose**: the neutral status chip. Colour lives in the dot, never in the fill.
- **Source**: `packages/web/src/components/pill.tsx`. Props `dot?: StatusDotTone`, `pulse?: boolean`, span props.
- **Look**: `inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-xs font-medium whitespace-nowrap text-muted-foreground`.
- **Rules**: DO render `attention.label` (lower case) inside. DO NOT tint the pill background by status.
- **Where used**: 4 files (`compare-variants.tsx`, `global-tasks.tsx`, `task-thread/run-header.tsx`, `tasks-overview.tsx`).

### PickerPill and RunnerPill

- **Purpose**: the composer's single-choice bordered pill (runner, model, account).
- **Source**: `packages/web/src/components/picker-pill.tsx`. Exports `chipClass`, `chevron`, `PickerPill`, `RunnerPill`, type `RunnerAccountChoice`.
- **Look** (`chipClass`): `inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55`.
- **Props**: `slot`, `ariaLabel`, `label`, `value`, `options[{value,label,desc?}]`, `onPick`, `disabled`, `readOnly`, `hint`, `disabledHint`, `status`.
- **States**: enabled, read-only (`cursor-default`, no hover), disabled (bare button in a `title` span so the reason still shows), open menu (`DropdownMenuRadioGroup`), catalog status row.
- **Rules**: DO import `chipClass` rather than copy it (two copies exist, G-03). The runner pill shows the raw backend id on purpose; product names come from `runner-label.ts` everywhere else.
- **Where used**: 5 files.

### EnginePills

- **Purpose**: runner + model pill pair for surfaces that start a run outside `/new` (Inbox, GitHub).
- **Source**: `packages/web/src/components/engine-pills.tsx`. Exports `EnginePills`, `useResolvedEngine`, `engineBody`, `engineRunBody`, types `EnginePick`, `ResolvedEngine`.
- **Rules**: the runner pill is hidden on a single-backend host; the model pill is read-only when models are locked (`Model selection is locked to native coding-agent settings.`).
- **Where used**: 3 files.

### FacetFilter, ToggleChip, SegmentedControl

- **Purpose**: the global Tasks page filters.
- **Source**: `packages/web/src/components/facet-filter.tsx`.
- **Look**: FacetFilter trigger `inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground …`, active `border-violet/40 bg-violet/10 text-foreground`; checkbox `size-4 rounded-[4px] border`, checked `border-violet bg-violet text-violet-foreground`; ToggleChip `tag` tone `border-violet/25 bg-violet/10 text-violet`, selected `border-violet bg-violet text-violet-foreground`; SegmentedControl `inline-flex gap-0.5 rounded-md bg-muted p-[3px]`, segment `h-6 rounded-[6px] px-2.5 text-[12px] font-medium`, active `bg-card font-semibold text-foreground shadow-xs`.
- **Rules**: a filter that re-slices one list uses `aria-pressed`, not a tablist. Counts show `0` on purpose.
- **Accessibility**: `aria-label="Filter by {label}"`, `role="option" aria-checked`, `role="group"`.
- **Copy**: `Nothing to filter by`, `Search {label}…`, `Clear {label}`, `{n} selected`.
- **Where used**: 1 file (`routes/global-tasks.tsx`).

### TabLink

- **Purpose**: one underline tab for URL-backed segments (Session | Changes | Files; Changes | Commits | Branches).
- **Source**: `packages/web/src/components/tab-link.tsx`. Props `to`, `active`, `onClick`, `children`.
- **Look**: `-mb-px flex h-8 items-center rounded-t-md border-b-2 px-3 text-[13px] font-medium`; active `border-foreground font-semibold text-foreground`; inactive `border-transparent text-muted-foreground hover:bg-muted hover:text-foreground`.
- **Accessibility**: a real `<Link>` with `aria-current="page"`.
- **Where used**: 3 files.

### ListView

- **Purpose**: the in-memory Active/Archived filter shared by the sidebar and the tables.
- **Source**: `packages/web/src/components/list-view.tsx`. Exports `ListViewProvider`, `useListView`. Throws outside a provider on purpose.
- **Where used**: 5 files.

### TaskQuickList

- **Purpose**: the sidebar task list: Active/Archived tabs, then Pinned / Needs you / Working / Recent buckets.
- **Source**: `packages/web/src/components/task-quick-list.tsx`. Exports `TaskQuickList`, `QuickListBuckets`, `TaskQuickListContainer`.
- **Look**: bucket heading `px-3 pt-stack pb-1 text-[11px] font-semibold tracking-[0.04em] uppercase`, so sidebar groups sit `stack` apart.
- **States**: nothing until runs load (no skeleton, no false empty); empty `No tasks yet — describe one.` / `Nothing archived yet.`; active row `bg-muted` + `aria-current="page"`; unread row `font-semibold` with a trailing violet dot `aria-label="unread"`; read-done `font-medium text-muted-foreground`; group tile `aria-expanded`.
- **Rules**: the width-priority rule: the title is the only element allowed to grow; everything else must be droppable. The pin is hover-revealed with `group-hover`, `group-focus-within`, `no-hover:` and `data-[pinned=true]` reveals, zero-width when hidden. Dot, chip and pin are siblings of the link, never children.
- **Where used**: 2 files.

### PinToggle

- **Purpose**: the one pin button for every task list surface.
- **Source**: `packages/web/src/components/pin-toggle.tsx`. Props `pinned`, `onToggle`, `className`.
- **Look**: `size-5 rounded-sm text-soft-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50`; pinned `text-violet` with a filled icon.
- **Rules**: never disabled during the mutation; the caller decides visibility (hover reveal).
- **Accessibility**: `aria-pressed`, `aria-label="Pin task" / "Unpin task"`, `title="Pin to the top of the list"`.
- **Where used**: 2 files.

### DiffStatLabel

- **Purpose**: `+128 −14`, one rendering for the table, the quick list and the cards.
- **Source**: `packages/web/src/components/diff-stat.tsx`. Props `stat`, `className`.
- **Look**: `font-mono text-xs font-semibold tabular-nums`; `text-success` / `text-danger`; repointed stats add `cursor-help underline decoration-dotted`.
- **Rules**: the caller owns the absent state (`—`). The minus is U+2212.
- **Where used**: 8 files.

### DirectionalUsage

- **Purpose**: token usage as `IN 3.6k · OUT 812` (compact) or `3.6k / 812` (table); total-only fallback.
- **Source**: `packages/web/src/components/directional-usage.tsx`. Exports `DirectionalUsage`, `directionalUsageText`, `directionalUsageLabel`, `totalUsageText`, `totalUsageLabel`.
- **Accessibility**: `aria-label` spells the exact counts.
- **Where used**: 4 files.

### TaskAgent cells

- **Purpose**: the Tool Name and Model table cells.
- **Source**: `packages/web/src/components/task-agent.tsx`. Exports `ToolNameCell`, `ModelNameCell`.
- **Look**: `block truncate text-[12.5px]` (tool) / `font-mono text-[11.5px]` (model); `text-soft-foreground` when inherited or auto.
- **Rules**: text rules come from `lib/runner-label.ts`; a model id prints verbatim.
- **Where used**: 2 files.

### EditableTitle

- **Purpose**: the one inline-rename state machine (run header h1 and the table Task cell).
- **Source**: `packages/web/src/components/editable-title.tsx`. Exports `useTitleEditor`, `TitleEditInput`.
- **Look**: input `rounded-sm border border-border bg-card px-1.5 py-0.5 focus-visible:ring-[3px] focus-visible:ring-ring/50`.
- **Accessibility**: `aria-label="Task title"`, Enter commits, Escape cancels, blur commits once.
- **Where used**: 2 files.

### ReferenceChip

- **Purpose**: a task's PR or issue link with its state in colour, glyph and a hover card.
- **Source**: `packages/web/src/components/reference-chip.tsx`. Exports `ReferenceChip`, `useCloseReferenceCard`.
- **Look**: `inline-flex h-[22px] items-center gap-1 rounded-full border px-2 font-mono text-[11px] font-semibold`; tones `success` `border-success/40 text-success`, `danger`, `violet` (resting), `info`, `neutral` (`border-border text-muted-foreground`), `pending` (`border-pending-strong/45 text-pending-strong`), `conflict` (`border-conflict/45 text-conflict`); link chips add `hover:bg-{tone}/10`.
- **States**: inert (non-http URL), unknown status, loading (`Checking GitHub…`), unavailable, not found, conflicting (warning triangle + `Resolve conflicts` action), open card (150ms open, 120ms close; never on touch).
- **Accessibility**: `aria-label="Open the pull request for {task} — {label}"`; `role="dialog"` only when the card has an action, else `role="tooltip"`; Escape closes; Tab moves into the panel.
- **Where used**: 3 files.

### ReferenceConflictAction

- **Purpose**: the `Resolve conflicts` button inside a conflicting chip's card, plus `TaskReferenceChip` and `ResolveConflictsForRun` wrappers.
- **Source**: `packages/web/src/components/reference-conflict-action.tsx`.
- **Look**: default (`primary`) `Button size="sm" className="h-7 w-full text-xs"`, not `outline` (invisible on a card-coloured popover).
- **Copy**: `Resolve conflicts` / `Sending…`; toasts `Sent to the task — resolving conflicts in PR #n`.
- **Where used**: 4 files.

### ReferenceStatus registry

- **Purpose**: batches PR/issue status requests across the sidebar, tables and header.
- **Source**: `packages/web/src/components/reference-status.tsx`. Exports `ReferenceStatusRegistry`, `ReferenceStatusProvider`, `useReferenceStatus`. Renders nothing.
- **Where used**: 6 files.

### ProjectGroups

- **Purpose**: the multi-project sidebar: one collapsible group per project with its own nav and quick list.
- **Source**: `packages/web/src/components/project-groups.tsx`. Props `projects`, `bootProjectId`, `inboxAvailable`, `automationsAvailable`, `inboxCount`, `skillsUpdateAvailable`.
- **Look**: header `flex h-11 w-full items-center gap-[7px] rounded-lg px-2 text-[13px] font-semibold … hover:bg-muted md:h-[34px]`, active `bg-muted`; body `ml-[14px] border-l border-border pl-2`; nav rows `md:h-[30px]`; missing project `opacity-55` with a `bg-danger/15 text-danger` chip `folder not found`.
- **Accessibility**: `aria-expanded`, `aria-controls`, `<nav aria-label="{project} navigation">`.
- **Where used**: 1 file.

### NavItems

- **Purpose**: the nav model shared by the sidebar and the command palette.
- **Source**: `packages/web/src/components/nav-items.ts`. Exports `NAV_ITEMS`, `visibleNavItems`, `activeNavPath`, `activeNavItem`, types `NavItem`, `NavAvailability`.
- **Table**: Tasks (`/`, badge `tasks-unread`), Inbox (`/inbox`, badge `inbox-count`, gate `inbox`), Git (`/git`), GitHub (`/github`, gate `forge`), Automations (`/automations`, gates `forge` + `automations`), Skills (`/skills`, badge `skills-update`), Workflows (`/workflows`), Settings (`/settings`).
- **Rules**: gates are ANDed; matching is segment-aware (`/git` does not match `/github`).
- **Where used**: 3 files.

### CommandPalette

- **Purpose**: ⌘K: projects, tasks, views, actions, skills.
- **Source**: `packages/web/src/components/command-palette.tsx`. Exports `CommandPalette`, `openCommandPalette`, `OPEN_COMMAND_PALETTE_EVENT`, `paletteScore`, `mergeTasks`, `partitionTasks`, `orderRuns`, `orderProjects`.
- **Look**: dialog `top-[10vh] translate-y-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl`, list `max-h-[55vh] min-h-[14rem] sm:max-h-[60vh] lg:max-h-[68vh]`.
- **Shortcuts**: ⌘/Ctrl+K toggle, ⌘/Ctrl+N and `c` open `/new`.
- **Copy**: placeholder `Search projects, tasks, views, actions, skills…`; groups `Recently finished`, `Views`, `Projects`, `Tasks`, `Actions`, `Skills`; `Nothing matches.`; `Toggle theme`.
- **Where used**: 2 files.

### ToolsMenu

- **Purpose**: the sidebar footer's Tools dropdown listing every probed CLI.
- **Source**: `packages/web/src/components/tools-menu.tsx`. Exports `ToolsMenu`, `toolsBlocker`, `toolsTooltip`, `forgeNote`.
- **Look**: trigger `rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground`; aggregate dot `pending` when blocked, `success` otherwise; menu `side="top" align="start" w-[240px]`.
- **Copy**: `Installed tools`, `not found`, `Set up →`, `Tool settings`; hints come verbatim from the server.
- **Where used**: 1 file.

### OpenInMenu

- **Purpose**: "Open in…" menu for local paths (editors, terminals, agent CLIs).
- **Source**: `packages/web/src/components/open-in-menu.tsx`. Exports `OpenInMenu`, `openInIcon`, `cliTargetRunner`, type `OpenInChoice`. Props `choices`, `onPick`, `label` (default `Open in…`), `triggerVariant` `ghost | outline`, `leading`, `trailing`, `slot`, `disabled`.
- **Rules**: an unknown icon key falls back to `ExternalLinkIcon`; hidden entirely in hosted mode.
- **Where used**: 4 files.

### AddProjectDialog and CloneProjectDialog

- **Purpose**: "Add project → Open local folder" and "Clone from GitHub".
- **Source**: `packages/web/src/components/add-project-dialog.tsx`, `packages/web/src/components/clone-project-dialog.tsx`. Props `open`, `onOpenChange`.
- **States**: pending (`Adding…` / `Cloning…`, inputs disabled, close swallowed while cloning), error paragraph `text-[13px] text-danger` with the server's words, live clone progress line `font-mono text-[11.5px]`.
- **Copy**: `Open local folder`, `Pick the folder xezar should run in. Git repos are marked; any folder works.`, `Clone from GitHub`, `Repository`, `Folder name`, `Cancel`, `Add project`, `Clone`.
- **Where used**: 1 file each (`app-shell.tsx`).

### FolderBrowser

- **Purpose**: server-side folder picker shared by Add project and Add agent account.
- **Source**: `packages/web/src/components/folder-browser.tsx`. Exports `FolderBrowser`, `useBrowseTarget`. Props `path`, `selected`, `onSelect`, `onEnter`, `decorate`, `emptyHint` (required), `showHidden`.
- **Look**: list `max-h-64 divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-md border border-border`; row `px-3 py-2 text-[13px] hover:bg-muted`, selected `bg-muted` + `aria-pressed`.
- **States**: `Loading…`, error `could not list that folder`, empty (`emptyHint`), truncated note.
- **Where used**: 2 files.

### DefaultAgentPicker

- **Purpose**: "which agent, and which login" as one flat radio list, shared by repo and global settings.
- **Source**: `packages/web/src/components/default-agent-picker.tsx`. Exports `DefaultAgentPicker`, `agentPickerRows`, `hasAgentAccounts`.
- **Look**: `rounded-md border border-border bg-card p-0.5`; row `rounded-sm px-3 py-1.5 font-mono text-[13px] font-medium`, checked `bg-muted text-foreground`.
- **Accessibility**: `role="radiogroup" aria-label="Default runner"`, `role="radio" aria-checked`.
- **Where used**: 2 files.

### PromptTemplateMenu

- **Purpose**: "Insert a template" trigger for the three follow-up composers.
- **Source**: `packages/web/src/components/prompt-template-menu.tsx`. Props `templates`, `onInsert`, `triggerClassName`, `disabled`, `iconOnly`.
- **Rules**: renders nothing when the list is empty; prevents `onCloseAutoFocus` so the caret restore survives.
- **Copy**: `templates`, `search templates…`, `Insert a template`, `Edit templates…`.
- **Where used**: 3 files.

### Composer

- **Purpose**: the shared composer (`/new` and the task thread): auto-growing textarea, attachments, `/` skills and `@` file autocomplete, dictation, quick replies.
- **Source**: `packages/web/src/components/composer/composer.tsx` (`Composer`, `ComposerHandle`), `composer-attachments.ts` (`MAX_ATTACHMENTS = 4`, `MAX_ATTACHMENT_BYTES` 5 MB, `screenFiles`, `fileToPendingAttachment`), `composer-text.ts` (`detectTrigger`, `applyCompletion`), `dictation.ts` (`useDictation`, `formatElapsed`).
- **Props that matter**: `onSubmit` (required), `value`/`onValueChange`, `autoFocus`, `footerStart`, `footerEnd`, `sendAriaLabel` (default `Send`), `disabled`, `disabledReason` (default `Session closed — Continue to reopen.`), `allowEmptySubmit`, `placeholder` (default `Reply — / for skills, @ for files…`), `ariaLabel` (default `Reply to the agent`), `autocompleteSkills`, `quickReplies`, `getMentionCandidates`.
- **Look**: card `rounded-xl border border-border bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15`; textarea `min-h-11 … text-base md:min-h-[54px] md:text-sm`, max height 220px; footer paperclip · pills · spacer · `Dictation` · lime send (`ArrowUpIcon`).
- **States**: disabled (`opacity-80`, reason as placeholder), busy, attachments row (image thumbs `size-12`, file chips), autocomplete menu open (`PopoverContent side="top"`), dictation recording (a `role="status"` bar with a pulsing `bg-danger` dot, `mm:ss` timer, `aria-live="polite"` transcript, cancel / insert / insert-and-send).
- **Rules**: Enter sends, Shift+Enter newlines, ⌘↵ / Ctrl+↵ send; a failed send restores the draft ahead of anything typed since. Rejections toast verbatim (`{name} is too large (max 5 MB)`). The dock lives in the host (`task-thread.tsx`, `bottom-[var(--kb,0px)]`).
- **Accessibility**: `aria-label="Attach files"`, `"Start dictation"`, `"Cancel dictation"`, `"Insert transcription"`, `"Insert transcription and send"`, `"Remove {file}"`; the mic renders only when the browser supports speech recognition.
- **Where used**: 2 files (`routes/new-task.tsx`, `routes/task-thread/task-thread.tsx`).

### Diff (facade, engine and helpers)

- **Purpose**: the diff renderer used by every Changes, Commits and PR surface.
- **Source**: `packages/web/src/components/diff/index.ts` (public: `Diff`, types `DiffFileChange`, `DiffHandle`, `DiffMode`, `DiffProps`), `diff.tsx` (facade + `DiffFallback`), `diff-view.tsx` (the lazy engine), `image-preview.tsx` (`ImagePreview`, `shouldPreviewImage`), `parse-patch.ts`, `word-diff.ts`, `diff-scroll.ts`, `types.ts`.
- **Props that matter**: `files` (required), `mode` `unified | split` (default `unified`), `wrap` (default `false`), `loadFileText` (enables expandable context gaps), `imageSrc`, `onOpenInApp` (absent hides the action), `viewRef`, `className`.
- **Look**: file card `sticky top-[var(--diff-sticky-top,0px)] z-10 rounded-t-md border-b border-border/50 bg-card` header; gutters `w-10 text-right text-soft-foreground/70 tabular-nums`; lines `bg-diff-add` / `bg-diff-del`; word marks `bg-diff-add-strong` / `bg-diff-del-strong rounded-[2px]`; hunk header `bg-muted/40 text-soft-foreground`; status badges `rounded-sm bg-muted px-1.5 py-px text-[10px]`.
- **States**: `No changes.`, `Loading diff…`, `Binary file — no text diff.`, `No content changes (metadata only).`, `Patch truncated by the server.`, image preview, collapsed file, expandable gap (`⋯ 12 unchanged lines — expand`), virtualised above `DIFF_VIRTUALIZE_THRESHOLD = 1500` rows, plaintext above `HIGHLIGHT_MAX_LINES = 1500`, fallback renderer when the engine chunk fails.
- **Rules**: consumers import from `@/components/diff` only. Consumers set `--diff-sticky-top` so file headers park below the page header. Below `md` the view is forced to unified + wrap. `run-diff.tsx` is the older renderer still used by the review panel and compare view (G-09).
- **Where used**: 7 route files.

### RunDiff

- **Purpose**: the earlier collapsible per-file diff for the review gate and the compare view.
- **Source**: `packages/web/src/components/run-diff.tsx`. Props `runId`. `FILE_CAP = 20`, `DIFF_CLAMP_LINES = 300`.
- **States**: `Loading diff…`, error in `text-danger`, `(no changes)`, `Show N more files`, `Show all N lines` / `Show less`.
- **Rules**: do not extend; new diff surfaces use `Diff` (G-09).
- **Where used**: 2 files.

### RouteErrorBoundary

- **Purpose**: keeps the shell alive when a routed page throws; resets on navigation.
- **Source**: `packages/web/src/components/route-error-boundary.tsx`.
- **Copy**: `This page could not be displayed.` (`h1 text-lg font-semibold`), `Try again, or open another page from the sidebar.`, button `Try again`; container `role="alert"`.
- **Where used**: 1 file (`app.tsx`).

### RunNotifications

- **Purpose**: fires a browser `Notification` when a run enters a wants-attention status while the tab is hidden. Renders nothing.
- **Source**: `packages/web/src/components/run-notifications.tsx` with `lib/notifications.ts`.
- **Rules**: off by default; watches the query cache, not the stream; a notification must never throw.
- **Where used**: 1 file (`app.tsx`).

### ProviderBanner and ProviderBannerContainer

- **Purpose**: the shell's banner row for provider authentication failures and "no usable provider".
- **Source**: `packages/web/src/components/provider-banner.tsx`, `packages/web/src/components/provider-banner-container.tsx`.
- **Look**: alert `flex min-h-10 items-center gap-2 border-b border-border bg-destructive/10 px-section text-sm text-foreground` with `role="alert"` and a danger dot; status `bg-muted/50 text-muted-foreground` with `role="status"` and a pending dot.
- **Copy**: `Provider authentication failed during a task: {labels}.`, `Open agent settings`, `No agent provider is enabled.`, `No connected provider could be verified.`, `No agent provider credentials were found.`, `Configure providers`.
- **Where used**: 1 file each.

### SkillDetail, SkillEmptyHint, SkillsImportPanel

- **Purpose**: the one skill detail rendering (`SkillDetailBody`, `SkillPreviewDialog`, `SkillSourceTag`); the shared "no skills yet" copy; the team skills panel with its update card.
- **Source**: `packages/web/src/components/skill-detail.tsx`, `packages/web/src/components/skill-empty-hint.tsx`, `packages/web/src/components/skills-import-panel.tsx`.
- **Look**: source tag `rounded-full border border-border px-2 py-px font-mono text-[10.5px]`; eyebrows `text-[11px] font-semibold tracking-[.04em] uppercase text-soft-foreground`; preview dialog `max-h-[80dvh] overflow-y-auto sm:max-w-2xl`; checkbox rows `rounded-md border border-border px-2.5 py-2 hover:bg-muted`, checked `bg-muted`.
- **Accessibility**: the update card is `aria-live="polite"`; `aria-label="Filter skills"`.
- **Where used**: 3, 2 and 1 files.

### GhostCodeBackdrop and icons

- **Purpose**: the `/new` hero texture (typed pseudo-code panels, `max-xl:hidden`, `aria-hidden`); `GithubIcon`, the brand mark lucide dropped.
- **Source**: `packages/web/src/components/ghost-code-backdrop.tsx`, `packages/web/src/components/icons.tsx`.
- **Rules**: the backdrop schedules nothing under reduced motion.
- **Where used**: 1 and 3 files.

### CodeEditor

- **Purpose**: a transparent textarea over Shiki tokens for editing agent config files.
- **Source**: `packages/web/src/components/code-editor.tsx`. Props `value`, `onChange`, `language`, `readOnly`, `className`, `aria-label`.
- **Look**: `rounded-md border border-input bg-card`, `font-mono text-xs leading-[1.7] [tab-size:2]`, caret `caret-foreground`, ring suppressed.
- **Rules**: Tab is not trapped.
- **Where used**: 1 file.

### ZoomableImage

- **Purpose**: click-to-lightbox image.
- **Source**: `packages/web/src/components/zoomable-image.tsx`. Props `src`, `alt`, `className`.
- **Look**: overlay `fixed inset-0 z-[100] bg-black/80 p-4 backdrop-blur-sm` (the one allowed `bg-black` outside `ui/`).
- **Accessibility**: `role="dialog" aria-modal="true" aria-label="Image preview"`; Escape and backdrop click close.
- **Where used**: 2 files.

### LastLocationController

- **Purpose**: remembers the last project-scoped location for the next bare-root launch. Renders nothing.
- **Source**: `packages/web/src/components/last-location-controller.tsx`.
- **Where used**: 1 file.
