# Behaviour

Keyboard, focus, announcements, responsive rules, motion and theming as the code does them.
Counts are from `packages/web/src` (non-test files) on 2026-09-13.

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

- The focus ring is `focus-visible:ring-[3px] focus-visible:ring-ring/50` with `outline-none` (58 route
  sites, all primitives). The dialog and sheet close buttons still use the older `focus:ring-2` (G-06).
- A hover-revealed control MUST also reveal on `focus-visible` (`focus-visible:opacity-100`) and on
  `no-hover:` devices. A zero-width hidden control stays focusable; never `hidden` it.
- Dialogs and sheets trap focus through Radix; the mobile drawer button is a real `SheetTrigger` so closing
  returns focus to it.
- A popover opened by hover or by typing prevents `onOpenAutoFocus`; a menu that closes over a textarea
  prevents `onCloseAutoFocus` so the caret restore survives.
- `autoFocus` is used only when the user just asked to edit that field (title rename, the new-task
  composer on mount).
- There is no skip link and no roving tabindex today.
- `<kbd>` hints are `aria-hidden` and show `⌘K` on Apple platforms, `Ctrl+K` elsewhere (`commandShortcutHint`).

## 2. Announcements

- `aria-live="polite"` regions: 10, all polite, none assertive. Examples: the composer dictation transcript,
  the thread history loader (`sr-only`), the MCP connection status and operations, the skills update card,
  the GitHub merge box.
- `role="status"`: 19 sites (toasts, the running spinner, monitoring schedule lines, the provider status
  banner, the dictation bar). `role="alert"`: 10 sites (inline errors, the provider auth banner, the route
  error boundary).
- `aria-busy`: the thread history boundary and the "Plan first" radio while planning.
- Status dots that stand alone get `role="img"` and `aria-label` from `attention.label`; the unread marker
  is `aria-label="unread"`.
- Counts that change are announced politely through the region that owns them; never through an alert.

Rule: a changed count or a background completion is announced politely. An error the user must act on
is `role="alert"`. A toast is `role="status"`.

## 3. Responsive rules

| Prefix | Count | What it does |
| --- | --- | --- |
| `sm:` | 53 | dialog widths, footer direction, plan-review full-screen below `sm` |
| `md:` | 193 | the one layout switch: sidebar vs drawer, desktop header vs mobile top bar, table vs cards, 16px vs 14px inputs, `h-11` vs `h-[34px]` rows, tree pane shown, diff forced to unified + wrap below |
| `lg:` | 11 | wider diff tree pane, one global-table column |
| `xl:` | 12 | global-table column degradation, the ghost-code backdrop (`max-xl:hidden`) |
| `max-md:` | 8 | phone-only borders and margins |
| `2xl:` | 0 | – |

- `useIsDesktop()` asks the same `(min-width: 768px)` as `md:`; jsdom counts as desktop.
- One container query: the sidebar is `@container/sidebar` and the quick-list diff pair shows at
  `@min-[23rem]/sidebar:inline`.
- Nothing scrolls sideways at 375px: tables become cards, the settings nav becomes a pill row, the global
  table hides columns, diffs wrap. The document itself is `overflow: hidden`.
- Safe areas: shell left/right, sidebar top/bottom, composer row bottom, page bodies
  `pb-[calc(90px+env(safe-area-inset-bottom))]`, the FAB, the toaster, the plan-review footer.
- Viewport: `h-dvh` on the shell, `100dvh` in `calc()` for bounded panes, `80dvh` / `85dvh` for tall dialogs.
  `100vh` and `h-screen` are banned.
- Keyboard: `--kb` from `lib/keyboard-inset.ts`; the thread dock sits at `bottom-[var(--kb,0px)]`.
- Touch: 44px targets on phone (`h-11`, `size-11`, `size-14` FAB); the touch pin is `size-7`.

## 4. Motion

- `transition-colors` (60) is the default hover transition. `transition-transform` (16) rotates chevrons.
  `transition-opacity` (6) reveals row actions.
- `animate-spin` (18): eleven are `motion-safe:animate-spin`; the step rail adds `motion-reduce:animate-none`;
  six are unguarded (G-08).
- `animate-pulse` (10): guarded in the docks, step rail, composer and twinkles; unguarded in `StatusDot`,
  `Skeleton` and two `/new` sites (G-08).
- `animate-in` / `animate-out` from `tw-animate-css` on Radix `data-[state]` and on toasts (toasts are
  `motion-safe:`).
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
