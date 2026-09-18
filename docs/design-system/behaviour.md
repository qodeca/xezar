# Behaviour

Keyboard, focus, announcements, responsive rules, motion and theming as the code does them.
Inventory counts read on 2026-09-18 from non-test `.ts`/`.tsx` in `packages/web/src`: literal occurrences outside comments, with a breakpoint prefix counted only where no word character, `:` or `-` precedes it (so `max-md:` is not an `md:`). The `md:` figure is higher than the 2026-09-16 one partly because of that stated method and partly because the Git, GitHub, Compare and Automations pages moved to `md:` rhythm spellings in #453 B6 and B7.

## 1. Keyboard and focus

| Key | Where | Source |
| --- | --- | --- |
| ⌘K / Ctrl+K | toggle the command palette, anywhere (also from inside the palette input) | `lib/use-command-shortcut.ts`, `components/command-palette.tsx` |
| ⌘N / Ctrl+N, `c` | open `/new` (⌘N reaches only the desktop shell) | same |
| Enter | send in the composer; ⌘↵ / Ctrl+↵ also send; Shift+Enter and Alt+Enter insert a newline; never during IME composition or key repeat | `lib/use-submit-shortcut.ts`, `components/composer/composer.tsx` |
| ⌘↵ / Ctrl+↵ | submit a dialog textarea (commit message, review notes, hand-to-agent); plain Enter stays a newline there | `routes/task-git/commit-dialog.tsx`, `routes/task-thread/review-panel.tsx`, `routes/github/hand-to-agent.tsx` |
| Escape | close the reference card, the lightbox, the composer menu; cancel a title edit or a message edit; close any Radix dialog, sheet, menu or popover | six local handlers + Radix |
| Alt+A, Alt+C | quick replies "Yes, approved." / "Continue." on a waiting thread, only when no editable element has focus | `components/composer/composer.tsx` |
| ↑ ↓ Enter Tab | move and accept in the composer autocomplete and in every cmdk list | cmdk, `composer.tsx` |
| ← → Home End | resize the sidebar on the ARIA separator | `components/app-shell.tsx` |

Focus rules:

- The focus ring is `focus-visible:ring-[3px] focus-visible:ring-ring/50` with `outline-none`, everywhere: eight `components/ui`
  primitives and 78 sites outside `components/ui`. The dialog and sheet close buttons were the last two on the older
  focus-on-anything ring and now carry this one (counts read on 2026-09-18).
- A hover-revealed control MUST also reveal on `focus-visible` (`focus-visible:opacity-100`) and on
  `no-hover:` devices. A zero-width hidden control stays focusable; never `hidden` it.
- Dialogs and sheets trap focus through Radix; the mobile drawer button is a real `SheetTrigger` so closing
  returns focus to it.
- A popover opened by hover or by typing prevents `onOpenAutoFocus`; a menu that closes over a textarea
  prevents `onCloseAutoFocus` so the caret restore survives.
- `autoFocus` is used only when the user just asked to edit that field (title rename, the new-task
  composer on mount).
- There is no skip link and no roving tabindex today.
- `<kbd>` hints are `aria-hidden`: the New task button's `C`, and the submit hints, which show `⌘↵` on Apple
  platforms and `Ctrl+↵` elsewhere (`submitShortcutHint` in `lib/use-submit-shortcut.ts`). ⌘K / Ctrl+K has no
  visible hint since #546; it opens the command palette from the keyboard on every route, and closing the
  palette returns focus to the element that held it, else the phone top bar's menu button.

## 2. Announcements

- Polite live regions: 12 – 11 literal `aria-live="polite"` attributes plus the conditional
  `aria-live` in `mcp-connection-section.tsx`; none assertive. Examples: the composer dictation transcript,
  the thread history loader (`sr-only`), the MCP connection status and operations, the skills update card,
  the GitHub merge box.
- `role="status"`: 27 sites (toasts, the running spinner, monitoring schedule lines, the provider status
  banner, the dictation bar). `role="alert"`: 22 sites (inline errors, the provider auth banner, the route
  error boundary and the MCP leader refusal line).
- `aria-busy`: the thread history boundary and the "Plan first" radio while planning.
- Status dots that stand alone get `role="img"` and `aria-label` from `attention.label`; the unread marker
  is `aria-label="unread"`.
- Counts that change are announced politely through the region that owns them; never through an alert.

Rule: a changed count or a background completion is announced politely. An error the user must act on
is `role="alert"`. A toast is `role="status"`.

## 3. Responsive rules

| Prefix | Count | What it does |
| --- | --- | --- |
| `sm:` | 54 | dialog widths, footer direction, plan-review full-screen below `sm` |
| `md:` | 416 | the one layout switch: sidebar vs drawer, desktop header vs mobile top bar, table vs cards, 16px vs 14px inputs, `h-11` vs `md:h-9` rows, tree pane shown, diff forced to unified + wrap below |
| `lg:` | 11 | wider diff tree pane, one global-table column |
| `xl:` | 13 | global-table column degradation, the ghost-code backdrop (`max-xl:hidden`) |
| `max-md:` | 33 | phone-only borders and margins |
| `2xl:` | 0 | – |

- `useIsDesktop()` asks the same `(min-width: 768px)` as `md:`; jsdom counts as desktop.
- Nothing scrolls sideways at 375 px: tables become cards, the settings nav becomes a pill row, the global
  table hides columns, diffs wrap. The document itself is `overflow: hidden`.
- Safe areas: shell left/right, sidebar top/bottom, composer row bottom, page bodies
  `pb-[calc(90px+env(safe-area-inset-bottom))]`, the FAB, the toaster, the plan-review footer.
- Viewport: `h-dvh` on the shell, `100dvh` in `calc()` for bounded panes, `80dvh` / `85dvh` for tall dialogs.
  `100vh` and `h-screen` are banned.
- Keyboard: `--kb` from `lib/keyboard-inset.ts`; the thread dock sits at `bottom-[var(--kb,0px)]`.
- Touch: 44 px targets on phone AT EVERY DENSITY. The primitives pin the floor with `min-h-tap` / `min-w-tap`
  (or a centred `before:size-tap` overlay where the control's visible size is the design — the switch track,
  the dialog and sheet close glyphs) and release it at `md:`. A density-scaled `h-11` / `size-11` is 38.5 px at
  compact and 33 px at ultra, so it is a shape, not a floor; route-level controls still spelling it that way
  convert in their own batches. The touch pin is `size-7` (#453 B4).

## 4. Motion

- `transition-colors` (52) is the default hover transition. `transition-transform` (14) rotates chevrons.
  `transition-opacity` (6) reveals row actions.
- `animate-spin` (18): seventeen are `motion-safe:animate-spin` and the step rail's one adds `motion-reduce:animate-none`
  (`routes/task-thread/step-rail.tsx:93`); none is unguarded, so G-08 is retired.
- `animate-pulse` (8, plus one in a comment): guarded in the docks, step rail, twinkles and – since #453 B1 – in `StatusDot`
  and `Skeleton`; the two `/new` sites are `motion-safe:` too (`routes/new-task.tsx:545,1406`).
- `animate-in` / `animate-out` from `tw-animate-css` on Radix `data-[state]` and on toasts. Every occurrence in
  `components/ui` is `motion-safe:`, so no overlay, menu, popover or tooltip moves for a reader who asked the OS
  for no animation; the sheet adds `motion-reduce:transition-none` for the transition its slide rides on.
- `.shimmer` and the ghost-code typewriter are CSS-guarded; the accept celebration and the animated diff
  totals are JS-guarded (`prefersReducedMotion()` renders nothing / jumps to the value).

Rule: every new animation is `motion-safe:` or has a `prefers-reduced-motion` fallback that still shows the
state. Durations are the primitives' (`duration-200` dialogs, 500/300 sheet, 1.8 s shimmer); do not add a
new duration without a reason in a comment.

## 5. Theming in behaviour

- The class and attributes on `<html>` are the only theme mechanism; components never read the theme to
  choose a class. The switch thumb is `bg-background`, which equals `--primary-foreground` in dark, so no
  `dark:` variant is needed anywhere.
- Overlay scrims (`bg-black/50`, `bg-black/80`) are theme-agnostic by design and allowed only in `ui/` and
  `zoomable-image.tsx`.
- `color-scheme` follows the theme so native controls and scrollbars match.
- A component that must know the resolved theme (Shiki, the theme toggle icon) reads `useTheme()`.
