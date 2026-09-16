# Foundations

Every visual value the cockpit uses comes from one file: `packages/web/src/styles/index.css`. This page
lists all of it. Dark is the default theme; `.light` on `<html>` flips the token values. Nothing here is
invented: the initial values were read on 2026-09-13; rhythm tokens and Roomy density were added on 2026-09-15. The drift test
(`packages/web/src/design-system-drift.test.ts`) fails when a token exists in the file but not here.

Rules that follow from this page:

- MUST use a token for every colour. Raw hex is allowed only inside `index.css` (design guardian rule `no-raw-hex-colors`).
- MUST use `--pending-strong` for amber text. `--pending` is a fill for dots and spinners only (guardian rule `no-amber-text`).
- MUST NOT use `bg-white`, `bg-black`, `text-white` or `text-black` outside `src/components/ui/` and `zoomable-image.tsx` (guardian rule `no-raw-black-white`).
- MUST NOT write a `dark:` variant. The tokens already flip (guardian rule `no-dark-variant`).
- MUST NOT write `var(--token, fallback)` for a design token. A missing token is a bug to fix, not to hide. The one exception is a runtime-injected variable that may be absent: `var(--kb, 0px)` (`lib/keyboard-inset.ts`) and `var(--diff-sticky-top, 0px)` (`components/diff/diff-view.tsx`) carry a fallback on purpose.

## 1. Colour tokens

Column "Utility" is the Tailwind class family that the `@theme inline` block wires to the token. `bg-card`
means `bg-card`, `text-card`, `border-card`, `ring-card` and every other colour utility work. "–" means the
token has no utility and is read with `var(--name)`.

### 1.1 Neutral surfaces and ink

| Token | Dark | Light | Meaning | Utility |
| --- | --- | --- | --- | --- |
| `--background` | `#0d0d0d` | `#ffffff` | Page ground. The body, the shell, the sheet drawer. | `bg-background` |
| `--foreground` | `#ffffff` | `#171717` | Primary ink. | `text-foreground` |
| `--card` | `#171717` | `#ffffff` | First raised surface: cards, dialogs, inputs, popovers, the active tab. Elevation comes from surface steps, not shadows. | `bg-card` |
| `--card-2` | `#1c1c1c` | `#fbfbfb` | Second surface step, used inside a card (hints, sub-panels). | `bg-card-2` |
| `--sidebar` | `var(--card)` | `#fafafa` | The sidebar rail. Its own token because light wants a tint below the white card so the rail reads as chrome. | `bg-sidebar` |
| `--muted` | `#262626` | `#f7f7f7` | Hover fill, chips, the segmented control track, menu item focus. | `bg-muted` |
| `--muted-foreground` | `#a3a3a3` | `#5c5c5c` | Secondary ink: descriptions, inactive nav, chip text. | `text-muted-foreground` |
| `--soft-foreground` | `#909090` | `#6f6f6f` | Tertiary ink: placeholders, table headers, timestamps, the neutral status dot. It colours 10–12.5px text, so it clears AA's 4.5:1 on every surface it prints on, `--muted` included. | `text-soft-foreground` |
| `--border` | `#262626` | `#ebebeb` | Every border. The base layer sets `border-color: var(--border)` on `*`. | `border-border` |
| `--input` | `#262626` | `#ebebeb` | Input and textarea borders, the unchecked switch track. | `border-input`, `bg-input` |
| `--contrast` | `#ebebeb` | `#262626` | Inverse surface: the `contrast` button, tooltips, default toasts. | `bg-contrast` |
| `--contrast-foreground` | `#171717` | `#ffffff` | Ink on `--contrast`. | `text-contrast-foreground` |

### 1.2 Accent and brand

| Token | Dark | Light | Meaning | Utility |
| --- | --- | --- | --- | --- |
| `--accent-lime` | `#a8f372` | same | The stable name of the brand lime. Never used directly; `--primary` points at it. | – |
| `--primary` | `var(--accent-lime)` | same | The active accent: primary button, checked switch, text selection, the ghost-code caret. Settings → Appearance can repoint it (see [theming.md](theming.md)). | `bg-primary`, `text-primary` |
| `--primary-foreground` | `#0d0d0d` | same | Ink on `--primary`. | `text-primary-foreground` |
| `--violet` | `#8f86e8` | same | "Needs a person" and "running": the Inbox badge, the running dot, the review dot, pins, the reference chip's resting look. | `bg-violet`, `text-violet` |
| `--violet-foreground` | `#0d0d0d` | same | Ink on `--violet` (the Inbox count badge, 10.5px). Near-black in both themes: white on this violet is 3.1:1, the near-black 6.2:1. | `text-violet-foreground` |
| `--ring` | `#a8f372` | `#171717` | Focus ring colour. Used as `ring-ring/50`. | `ring-ring` |
| `--grad` | `linear-gradient(135deg, #b4f372 12%, #eefb63 58%, #bc9aff 100%)` | same | Brand gradient (lime → yellow → violet). Read with `var(--grad)`. | – |

### 1.3 Status

| Token | Dark | Light | Meaning | Utility |
| --- | --- | --- | --- | --- |
| `--danger` | `#ef4444` | same | Failed, destructive, deletions. | `bg-danger`, `text-danger` |
| `--danger-foreground` | `var(--danger-ink)` | same | Ink on `--danger` (the destructive button, the danger toast). Points at `--danger-ink` because white on this red is 3.8:1. | `text-danger-foreground` |
| `--danger-ink` | `#0d0d0d` | same | Near-black ink on `--danger` (about 5.1:1; white is 3.8:1). Does not follow the accent, unlike `--primary-foreground`. `--danger-foreground` now points at it, so every label printed on the red reads; the development-build badge keeps naming it directly (decisions.md D-08). | `text-danger-ink` |
| `--success` | `#10b981` | same | Done, passed, additions. | `bg-success`, `text-success` |
| `--pending` | `#fbbf24` | same | Waiting, scheduled, in progress. Fill only: dots and spinners. Never text. | `bg-pending` |
| `--pending-strong` | `#fbbf24` | `#b45309` | The ink version of pending. Amber-700 on light so it stays readable. | `text-pending-strong` |
| `--info` | `#93c5fd` | `#1d4ed8` | Waiting on a person (a PR that needs review). Ink only. The only blue in the cockpit. | `text-info`, `border-info` |
| `--conflict` | `#fb923c` | `#c2410c` | A pull request that will not merge, and the cockpit's warning colour (there is no `--warning`). Ink, and a faint wash (`bg-conflict/5`, `bg-conflict/10`) behind a warning callout. Blocked, not broken. | `text-conflict`, `border-conflict`, `bg-conflict/5` |

### 1.4 Diff tints

| Token | Dark | Light | Meaning | Utility |
| --- | --- | --- | --- | --- |
| `--diff-add-bg` | `rgba(16, 185, 129, 0.1)` | `rgba(16, 185, 129, 0.08)` | Added line background. | `bg-diff-add` |
| `--diff-add-strong` | `rgba(16, 185, 129, 0.28)` | same | Added word mark inside a line. | `bg-diff-add-strong` |
| `--diff-del-bg` | `rgba(239, 68, 68, 0.1)` | `rgba(239, 68, 68, 0.07)` | Deleted line background. | `bg-diff-del` |
| `--diff-del-strong` | `rgba(239, 68, 68, 0.3)` | same | Deleted word mark inside a line. | `bg-diff-del-strong` |

### 1.5 Syntax highlighting

Read by the Shiki theme in `lib/highlighter.ts` and by the ghost-code backdrop. No utilities.

| Token | Dark | Light | Meaning |
| --- | --- | --- | --- |
| `--syn-key` | `#c4b5fd` | `#7c3aed` | Keywords |
| `--syn-str` | `#86efac` | `#15803d` | Strings |
| `--syn-fn` | `#93c5fd` | `#1d4ed8` | Functions |
| `--syn-com` | `#6b7280` | `#9ca3af` | Comments |
| `--syn-num` | `#fca5a5` | `#b91c1c` | Numbers |
| `--syn-punc` | `#9ca3af` | `#6b7280` | Punctuation |
| `--syn-var` | `#e5e7eb` | `#111827` | Variables |

### 1.6 shadcn aliases

The shadcn primitives expect these names. Each is mapped onto a token above and never carries its own value.

| Token | Value (both themes) | Utility |
| --- | --- | --- |
| `--popover` | `var(--card)` | `bg-popover` |
| `--popover-foreground` | `var(--foreground)` | `text-popover-foreground` |
| `--card-foreground` | `var(--foreground)` | `text-card-foreground` |
| `--accent` | `var(--muted)` | `bg-accent` |
| `--accent-foreground` | `var(--foreground)` | `text-accent-foreground` |
| `--secondary` | `var(--muted)` | `bg-secondary` |
| `--secondary-foreground` | `var(--foreground)` | `text-secondary-foreground` |
| `--destructive` | `var(--danger)` | `bg-destructive`, `text-destructive` |
| `--destructive-foreground` | `var(--danger-foreground)` | `text-destructive-foreground` |

Rule: in app code write `text-danger`, not `text-destructive`. The alias exists for the primitives in
`src/components/ui/` only (see [known-gaps.md](known-gaps.md) G-04).

### 1.7 The Tailwind mapping (`@theme inline`)

The `@theme inline` block turns each token into a Tailwind colour. `inline` means the utility emits
`var(--card)`, so one class follows the active theme with no `dark:` variant. The full list, for the drift test:
`--color-background`, `--color-foreground`, `--color-card`, `--color-card-foreground`, `--color-card-2`,
`--color-sidebar`, `--color-muted`, `--color-muted-foreground`, `--color-soft-foreground`, `--color-border`,
`--color-input`, `--color-contrast`, `--color-contrast-foreground`, `--color-primary`,
`--color-primary-foreground`, `--color-violet`, `--color-violet-foreground`, `--color-ring`, `--color-danger`,
`--color-danger-foreground`, `--color-danger-ink`, `--color-success`, `--color-pending`, `--color-pending-strong`, `--color-info`,
`--color-conflict`, `--color-diff-add`, `--color-diff-add-strong`, `--color-diff-del`,
`--color-diff-del-strong`, `--color-popover`, `--color-popover-foreground`, `--color-accent`,
`--color-accent-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-destructive`,
`--color-destructive-foreground`, plus `--font-sans`, `--font-mono` and `--radius-md`.

## 2. Colour roles

How the tokens are meant to be read. This is the grammar every surface follows.

| Role | Token | Where you see it |
| --- | --- | --- |
| Status lives in the dot, never in the fill | `--success`, `--pending`, `--danger`, `--violet`, `--soft-foreground` | `StatusDot`; rows, pills and nav items stay neutral |
| Violet means "a person is involved" | `--violet` | Inbox count badge, needs-review dot, running dot, unread marker, pin |
| Red means broken | `--danger` | failed status, destructive actions, failing checks, deletions; one recorded exception: the development-build badge on the brand tile (decisions.md D-08) |
| Green means finished well | `--success` | done status, passing checks, additions |
| Amber means waiting | `--pending` (fill), `--pending-strong` (ink) | waiting dot, scheduled retry, version-update dot |
| Blue means waiting on a reviewer | `--info` | reference chip `review-required` |
| Orange means blocked by a conflict | `--conflict` | reference chip merge conflict |
| Lime is the one call to action | `--primary` | send button, primary button, checked switch |
| Elevation is a surface step, not a shadow | `--background` → `--card` → `--card-2` | page → card → hint inside the card |

Source: `lib/attention.ts` (status), `lib/reference-status.ts` (references), `index.css` comments.

## 3. Typography

| Token | Value | Notes |
| --- | --- | --- |
| `--sans` | `'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif` | Body. Utility `font-sans`. |
| `--mono` | `'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', 'Menlo', monospace` | Code, ids, numbers, model names. Utility `font-mono`. Also applied to `code`, `pre`, `kbd`, `samp` by the base layer. |

Fonts are self-hosted variable woff2 files under `packages/web/src/assets/fonts/` (Inter weight 100–900,
JetBrains Mono 100–800, latin and latin-ext subsets, `font-display: swap`). The cockpit works offline; there
is no CDN.

Sizes the cockpit actually uses (from the components and routes):

| Size | Where |
| --- | --- |
| `text-2xl` (24px) `font-semibold` | `CenteredState` title |
| `text-lg` (18px) `font-semibold` | dialog titles, the route error boundary heading |
| `text-[15px] font-semibold` | the brand word "xezar" in the sidebar |
| `text-base` (16px) → `md:text-sm` | inputs, textareas and the composer on touch widths (iOS zooms below 16px) |
| `text-sm` (14px) | body copy, descriptions, menu items |
| `text-[13.5px] font-medium` | nav rows, the default button |
| `text-[13px]` | table cells, tab links, folder rows, toasts (`font-medium`) |
| `text-[12.5px]` | small button, tab triggers, the picker menu rows, tool-name cell |
| `text-xs` (12px) | pills, chips, tooltips, badges, `font-mono` gutters |
| `text-[11.5px]` | model cell, breadcrumbs, secondary chip text |
| `text-[11px] font-semibold tracking-[.04em] uppercase` | section eyebrows ("Used by", "Content") |
| `text-[10.5px] font-semibold` | nav count badges, the skill source tag |
| `text-[10px]` | the version chip, diff status badges |
| `text-[9px] font-semibold` | the development-build "D" on the brand tile (decisions.md D-08); the smallest size, one letter only |

Weights: 400 body, 500 labels and rows, 600 active or emphasised (active nav, active tab, unread row,
headings). Nothing heavier than 600 except the brand tile.

Numbers use `tabular-nums`. The minus sign in diff counts is U+2212 (`−`), never a hyphen (`diff-stat.tsx`).

Chat markdown (`.thread-markdown`) is `em`-scaled: headings 1.05–1.25em at 600, paragraphs `margin: 0.45em 0`,
inline code `bg-muted` with 5px radius, code blocks 12px at 1.55 line height. Streamdown's own document-scale
classes are overridden by these unlayered rules.

## 4. Spacing and density

Tailwind v4 keys its whole numeric scale off one token, `--spacing` (default `0.25rem` = 4px per unit).
Density changes only that token:

| `data-density` | `--spacing` | Effect |
| --- | --- | --- |
| `roomy` | `0.3125rem` (5px) | ~25% looser paddings, gaps and control heights |
| absent (comfortable) | `0.25rem` (declared in `@theme static`, Tailwind's default value) | shipped look |
| `compact` | `0.21875rem` (3.5px) | ~12% tighter paddings, gaps and control heights |
| `ultra` | `0.1875rem` (3px) | ~25% tighter |

Type sizes do not change with density. A spacing or control-size pixel written by hand (`h-[34px]`,
`px-[7px]`) is outside the density lever, and the `no-arbitrary-spacing` guardian rule fails a new
occurrence (`decisions.md` D-06); use scale units (`h-9`, `px-2`).
Two tokens are deliberately OUTSIDE the density lever, because a target size is a hand size, not a taste:
`--spacing-tap` (44 px) is the phone hit-area floor and `--spacing-chip` (24 px) is the separate chip minimum
(WCAG 2.2 SC 2.5.8). They are flat pixels, not `calc(var(--spacing) * n)` — `h-11` is 44 / 55 / 38.5 / 33 px at
comfortable / roomy / compact / ultra, so a density-scaled height misses the floor at two of the four settings.
Spell them `min-h-tap` / `min-w-tap` / `size-tap` on phone and release them at `md:`, where the pointer is a
mouse; `min-h-chip` is the chip floor and is never a phone pass on its own.
The older hand-typed spelling of that chip floor, `min-h-[24px]` on the composer picker pill (`chipClass`)
and the reference chip, is the same 24 px and converts to the token in its own batch (#453 B4).
One more size is fixed on purpose, without a pixel: the development-build badge is `size-[54%]` with
`-top-[15%] -right-[15%]` of the fixed `size-[26px]` brand tile it sits on (about 14 px and 4 px). A scale unit
would grow and shrink the badge with density while the tile stays put (decisions.md D-08).

Common rhythm: `gap-1.5`/`gap-2` inside controls, `gap-2.5` in nav rows, `px-2.5` chips, `px-3.5` buttons,
`p-6` dialogs, `p-4` page gutters on phone and `md:p-section` on desktop, `py-12` centered states. Between blocks, §4.1.

### 4.1 Rhythm

Between blocks, a rhythm token. Inside a control, the numeric scale. Never a hand-typed pixel.

Six named spacing steps name the distance *between* things. They are declared in `@theme static` as
`calc(var(--spacing) * n)`, so the density lever scales them with everything else, and Tailwind mints a
utility for each in every spacing namespace (`gap-stack`, `p-inset`, `md:px-section`, `mt-row`, `space-y-list`).
Controls keep their own sizes on the numeric scale (`h-9`, `px-3.5`); a rhythm token never sets a control's height.

| Token | Value | Units | Comfortable | Use |
| --- | --- | --- | --- | --- |
| `--spacing-row` | `calc(var(--spacing) * 2)` | 2 | 8px | rows of one thing: icon and label, a turn's own rows, chips in a line |
| `--spacing-stack` | `calc(var(--spacing) * 3)` | 3 | 12px | lines inside one block: title → control → hint (the settings field) |
| `--spacing-list` | `calc(var(--spacing) * 4)` | 4 | 16px | blocks in a list: cards, thread groups |
| `--spacing-inset` | `calc(var(--spacing) * 5)` | 5 | 20px | inside a card (not `card`: that name is a colour token) |
| `--spacing-group` | `calc(var(--spacing) * 6)` | 6 | 24px | a speaker change in the thread; the run header's top |
| `--spacing-section` | `calc(var(--spacing) * 8)` | 8 | 32px | sections and settings fields; desktop page gutters, on both axes; under a page header |
| `--spacing-tap` | `44px` | – | 44px | the absolute phone hit-area floor, at every density (`min-h-tap`, `min-w-tap`, `size-tap`) |
| `--spacing-chip` | `24px` | – | 24px | the separate chip minimum, at every density (`min-h-chip`) |

The same steps at each density:

| Density | row | stack | list | inset | group | section |
| --- | --- | --- | --- | --- | --- | --- |
| Roomy | 10 | 15 | 20 | 25 | 30 | 40 |
| Comfortable | 8 | 12 | 16 | 20 | 24 | 32 |
| Compact | 7 | 10.5 | 14 | 17.5 | 21 | 28 |
| Compact for real (`ultra`) | 6 | 9 | 12 | 15 | 18 | 24 |

Compact and ultra give half-pixel values for some steps; that is already true of the numeric scale today.

Where the cockpit uses them:

| Surface | Spelling |
| --- | --- |
| Page header | `h-14 … md:px-section` |
| Page body | `p-4 … md:p-section md:pb-section` |
| Settings section container | `p-list … md:p-group`; section list `gap-section`; field `gap-stack` |
| Settings sidebar | `p-stack` |
| Card and card list | `p-inset` inside; `gap-list` between |
| Thread row | `pb-row` inside a turn; `pb-group` on the last row before the other speaker |
| Thread column and composer dock | `md:px-section md:py-section`; dock `md:pt-stack md:pb-list` |
| Run header | `md:px-section md:pt-group`; tab row `mt-stack` |
| Task table cell | `px-3` (rows stay `h-11`); footer strip `mt-list` |
| Banner row | `min-h-10 px-section` |

The Settings panes that are not a list of fields say so in their own spelling: Agent config is one editor
pane (`gap-list` between its tab bar and its files), the Agent accounts refusal is one block (`gap-4`), and
Bookmarklets has no list container. Step 3b of #424 put six hand-typed pixels on the scale: nav rows and
project-group headers `md:h-9`, table header `h-10`, tool row `min-h-8 py-1`, quick-list rows `py-2`, brand row
`gap-row` and group body `ml-3.5`. The `no-arbitrary-spacing` allowlist in `design-guardian-spacing-allowlist.json`
lists the ones still to convert.
A seventh step is a design decision (`decisions.md` D-02), not a new token in one file.

## 5. Radius

Declared in `@theme static`, so both the CSS variable and the utility exist. Stock Tailwind steps are wiped
(`--radius-*: initial`), so `rounded-3xl` and friends do not exist.

| Token | Value | Utility | Used for |
| --- | --- | --- | --- |
| `--radius-sm` | `8px` | `rounded-sm` | small buttons, tab triggers, title inputs, close buttons |
| `--radius` | `10px` | `rounded-md` (via `--radius-md: var(--radius)`) | the default control radius: buttons, inputs, menus, nav rows, tooltips, toasts |
| `--radius-lg` | `12px` | `rounded-lg` | dialogs, cards, project group headers |
| `--radius-xl` | `16px` | `rounded-xl` | the composer card |
| – | `rounded-full` | – | pills, dots, badges, switches |
| – | `rounded-[18px]` | – | the `CenteredState` icon tile (hand-set) |

## 6. Shadow

Restrained by design; borders carry most separation. Stock steps are wiped; only these four exist.

| Token | Dark | Light | Utility | Used for |
| --- | --- | --- | --- | --- |
| `--shadow-xs` | `0 1px 2px 0 rgba(10, 13, 20, 0.03)` | same | `shadow-xs` | cards, inputs, switches, the active tab, the composer |
| `--shadow-sm` | `0 2px 4px 0 rgba(27, 28, 29, 0.04)` | same | `shadow-sm` | the active agent tab in Settings → Agent config (`routes/settings/agent-config-section.tsx:101`) |
| `--shadow-md` | `0 16px 32px -12px rgba(14, 18, 27, 0.1)` | same | `shadow-md` | dropdown menus, popovers, select content |
| `--shadow-modal` | `0 16px 48px 0 rgba(0, 0, 0, 0.45)` | `0 16px 48px 0 rgba(0, 0, 0, 0.12)` | `shadow-modal` | dialogs, alert dialogs, sheets, toasts |

`lib/utils.ts` teaches tailwind-merge that `shadow-modal` is a shadow step, so `cn('shadow-md', 'shadow-modal')`
resolves to the modal shadow, and that the six rhythm names (§4.1) are spacing steps, so `cn('p-4', 'p-inset')`
resolves to `p-inset`.

## 7. Motion

Quiet motion. The cockpit uses Tailwind's stock utilities and the `tw-animate-css` vocabulary the shadcn
primitives need. There is no motion token scale.

| Motion | Where | Reduced motion |
| --- | --- | --- |
| `animate-pulse` | status dots (`pulse`), twinkle backdrop, skeleton | twinkles use `motion-safe:animate-pulse`; `StatusDot`, `Skeleton` and the composer dictation dot add `motion-reduce:animate-none`. Route-level pulses outside the primitives are still being converted (G-08) |
| `animate-spin` | refresh and loading icons | `motion-safe:animate-spin` in the skills update card |
| `.shimmer` | running tool-card titles (muted → foreground sweep, 1.8s) | falls back to a plain muted title |
| ghost code typewriter | the `/new` hero backdrop (`.ghost-code-line`, `steps(n)`) | renders every line fully typed and static |
| `motion-safe:…animate-in` / `…animate-out` (+ `fade-*`, `zoom-*`, `slide-in-from-*`) | dialogs and alert dialogs (`duration-200`), menus, popovers, tooltips | the surface appears and disappears with no movement |
| `slide-in-from-left` / `slide-out-to-left` | the sheet drawer (in 500ms, out 300ms) | `motion-safe:` on the animation plus `motion-reduce:transition-none`; the drawer appears in place |
| `motion-safe:animate-in … slide-in-from-right-4 duration-200` | toasts | instant appear and disappear |
| `transition-colors` | hover on nav rows, chips, buttons | – |
| `transition-[color,box-shadow]` | focus ring on inputs, badges | – |
| `transition-transform` | switch thumb, chevrons (`rotate-90`) | – |

Rule: new animation MUST be `motion-safe:` or carry a `prefers-reduced-motion` fallback that still conveys
the state (a static dot, a plain title).

## 8. Iconography

`lucide-react` (`components.json` → `"iconLibrary": "lucide"`). Brand marks lucide dropped live in
`src/components/icons.tsx` (`GithubIcon`, 24×24, `fill="currentColor"`, `aria-hidden` baked in).

| Size class | Count in `src/**/*.tsx` | Use |
| --- | --- | --- |
| `size-3.5` (14px) | 96 | the house size for inline icons in rows, chips and menus |
| `size-4` (16px) | 49 | buttons, dialog close, and the primitives' auto size for unsized svg children |
| `size-3` (12px) | 46 | badges, the pin icon, tiny markers |
| `size-2.5` (10px) | 17 | compact chip glyphs (reference chip) |
| `size-5` / `size-6` | 6 / 2 | command palette rows, drawer icons |

Rules:

- Size with `size-*`, never `h-4 w-4` (zero occurrences in the codebase).
- Decorative icons carry `aria-hidden="true"`. An icon-only control gets `aria-label`.
- Do not override `strokeWidth`. Lucide's default is the look.
- Inside `Button`, `CommandItem`, `DropdownMenuItem` and `TabsTrigger` an unsized svg becomes `size-4`
  automatically (`[&_svg:not([class*='size-'])]:size-4`).

## 9. Layout and reading width

- The shell is `h-dvh` with `overflow-hidden` on `html`, `body` and the shell root. The `<main>` region is
  the only scroller (`overflow-y-auto overscroll-contain`). A route never adds a second page scroller.
- Sidebar: `264px` minimum, `420px` maximum, resizable in `16px` steps, stored per browser
  (`lib/sidebar-width.ts`). The mobile drawer keeps a fixed `264px`.
- `--measure` caps the task view's column: `820px` shipped, `1180px` when `data-width="wide"`. Consume it as
  `max-w-[var(--measure)]` so one token moves every column together.
- Dialog widths: `max-w-[calc(100%-2rem)]` on phone, `sm:max-w-lg` (dialog), `sm:max-w-md` (alert dialog),
  `sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl` (command palette).
- Popover content is `w-72` by default; menus `min-w-[8rem]`.

## 10. Breakpoints

Tailwind defaults. Counts are prefix occurrences in `packages/web/src/**/*.{ts,tsx}` (see
[behaviour.md](behaviour.md) for the exact figures the patterns inventory measured).

| Prefix | Width | Role |
| --- | --- | --- |
| `sm:` | 640px | dialog max-widths, footer row direction |
| `md:` | 768px | THE desktop line: the sidebar appears (`md:flex`), the mobile top bar and drawer disappear (`md:hidden`), nav rows shrink from `h-11` to `h-9`, text drops from 16px to 14px. `useIsDesktop()` in `lib/use-desktop.ts` asks the same `(min-width: 768px)`. |
| `lg:` / `xl:` | 1024px / 1280px | command palette width, the ghost-code backdrop (`max-xl:hidden`) |
| `@min-[23rem]/sidebar` | container query | the quick-list diff pair appears only when the sidebar is wide enough |

## 11. The `no-hover:` variant

`@custom-variant no-hover (@media (hover: none))`. A control that is hidden until hover is unreachable on a
device with no hover. `no-hover:` reveals it there; pair it with `focus-visible:` for the keyboard. The pointer,
not the viewport, is the honest axis (a landscape tablet is `md` wide and still cannot hover). Worked example:
the pin button in `task-quick-list.tsx` (`no-hover:mr-1 no-hover:size-7 no-hover:opacity-100`).

## 12. Safe areas and the keyboard

- The shell pads `env(safe-area-inset-left/right)`; the sidebar content pads top and bottom; the composer
  row pads `env(safe-area-inset-bottom)`; the toaster offsets `env(safe-area-inset-top/right)`.
- `viewport-fit=cover` and `interactive-widget=resizes-content` are set in `index.html`.
- iOS does not shrink the layout viewport for the keyboard, so `lib/keyboard-inset.ts` keeps `--kb` on
  `:root` and the thread dock sits at `bottom-[var(--kb,0px)]`. Popovers add the inset to their collision
  padding.
- Touch targets are 44 px on phone AT EVERY DENSITY. Pin the floor with `min-h-tap` / `min-w-tap` (or `size-tap`
  for an overlay on a control whose visible size is the design, like the switch track) and release it at `md:`.
  `size-11` / `h-11` alone is not the floor: the density lever takes it to 38.5 px at compact and 33 px at ultra.
- Never `h-screen` or `100vh` (guardian rule `no-100vh`).

## 13. Base layer

From `@layer base` in `index.css`: `* { border-color: var(--border) }`; `html, body, #root { height: 100% }`;
`html, body { overflow: hidden }`; body gets `bg-background`, `text-foreground`, `font-family: var(--sans)`,
antialiasing; `::placeholder` is `--soft-foreground`; scrollbars are 8px with a `--muted` thumb.
