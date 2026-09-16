# Theming and appearance

Four user preferences change how the cockpit paints. All four are attributes or a class on `<html>`,
stamped before first paint, and every one is expressed as a token swap, never as a second set of
component styles.

| Preference | Values | Where it lands on `<html>` | Default is the absence of |
| --- | --- | --- | --- |
| Theme | `light`, `dark`, `system` | class `light` (or not) + inline `color-scheme` | `.light` |
| Accent | `lime`, `violet` | `data-accent="violet"` | the attribute |
| Density | `roomy`, `comfortable`, `compact`, `ultra` | `data-density="roomy"`, `"compact"` or `"ultra"` | the attribute |
| Reading width | `narrow`, `wide` | `data-width="wide"` | the attribute |

Sources: `packages/web/src/lib/theme.ts`, `packages/web/src/lib/appearance.ts`,
`packages/web/src/routes/settings/appearance.tsx`, `packages/web/index.html`.

## Theme

- Dark is the default; `.light` on `<html>` flips every token in `index.css`.
- `system` follows `(prefers-color-scheme: light)`. Light is the query because dark is the default.
- The preference is stored per browser under the localStorage key `xez-theme`. Anything but the three
  values falls back to dark. Storing `system` (not the resolved value) is what keeps the user's choice.
- `ThemeProvider` (`components/theme-provider.tsx`) tracks the OS preference live and applies the class in
  a layout effect so the class lands before paint. `useTheme()` returns `theme`, `resolvedTheme`, `setTheme`.
- The `ThemeToggle` button cycles `light → dark → system → light` (`NEXT_THEME` in
  `components/theme-toggle.tsx`). The command palette's "Toggle theme" action uses the same map.
- `color-scheme` is set alongside the class so native scrollbars and form controls match.

## Accent

- An accent is exactly a `--primary` family swap. `:root[data-accent='violet']` repoints `--primary`,
  `--primary-foreground` and `--ring` at the violet tokens. Lime is the shipped look and needs no attribute.
- Adding an accent means one new block in `index.css` and one entry in `ACCENT_OPTIONS`
  (`routes/settings/appearance.tsx`). Nothing else changes.
- Stored in the workspace-wide `~/.xezar/ui-state.json` (`appearance.accent`, through
  `PUT /api/v1/workspace/ui-state`), so it follows the person across every project, and mirrored to localStorage `xez-accent` for the pre-paint script.

## Density

- `data-density` changes only `--spacing` (Tailwind's one spacing token). See
  [foundations.md § 4](foundations.md#4-spacing-and-density) for the values.
- Type sizes never change with density. A hand-typed spacing or height pixel (`h-[34px]`) opts out
  of the lever, and a new occurrence fails the `no-arbitrary-spacing` guardian rule; use scale units.
  The chip floors are intentional fixed pixels; existing allowlisted debt is tracked in #445.
- Stored like the accent (`appearance.density`, mirror `xez-density`).

## Reading width

- `data-width="wide"` moves `--measure` from `820px` to `1180px`. The task view's header, thread, commits
  and composer column all read `max-w-[var(--measure)]`. The Changes tab is always full width.
- Stored like the accent (`appearance.width`, mirror `xez-width`).

## Pre-paint behaviour (no flash)

`packages/web/index.html` runs an inline script before the bundle exists. It:

1. reads `xez-theme`; toggles `.light` and sets `documentElement.style.colorScheme`;
2. reads `xez-accent`, `xez-density`, `xez-width` and stamps the non-default attributes only.

It duplicates `resolveTheme` + `applyResolvedTheme` (`lib/theme.ts`) and `applyAppearance`
(`lib/appearance.ts`) in vanilla JS on purpose. Change one, change the other. When the server answers,
`ui-state.json` wins for accent, density and width and the mirror is rewritten.

Failure handling: storage or `matchMedia` unavailable → the default dark, lime, comfortable, narrow tokens
already apply. A failed appearance write toasts the server's message and refetches rather than keep an
unsaved choice painting.

## How a design must behave

A mockup or a new surface is accepted only when all of these hold:

| Under | Requirement | How to check |
| --- | --- | --- |
| Light and dark | Every colour comes from a token, so both themes render without a `dark:` variant. Contrast: body ink on `--background`, `--muted-foreground` on `--card`, status ink (`--info`, `--conflict`, `--pending-strong`) on both grounds. | Toggle `.light` on the specimen page; run the guardian test. |
| Violet accent | Nothing breaks when `--primary` is violet. Do not use `--primary` where "brand lime" is meant; use `--accent-lime` (the brand tile does). Do not rely on lime and violet being different colours to carry meaning (the running dot is `--violet`, a CTA is `--primary`; under the violet accent they match by design). | Set `data-accent="violet"` on the specimen page. |
| Roomy density | Paddings, gaps and control heights grow with `--spacing`; nothing wraps into an unreadable column or pushes a control out of reach at 375 px. | Set `data-density="roomy"`. |
| Compact and ultra density | Rows, chips and buttons shrink with `--spacing`; nothing overflows or overlaps. Fixed-pixel controls stay legible. | Set `data-density="ultra"`. |
| Wide reading width | Columns that read `--measure` open up; full-width surfaces are unaffected. | Set `data-width="wide"`. |
| System theme | The page follows an OS change without a reload. | `ThemeProvider` handles it; a mockup only needs `.light` to work. |

The index, foundations, components and patterns specimen pages have controls for theme, accent,
density and width. The mobile page has only a theme toggle when opened on its own; inside the
patterns iframe it inherits the parent appearance settings.
