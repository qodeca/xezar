# xezar design system

The cockpit (`packages/web`) as it is today: every token, primitive, shared component, pattern and copy rule, written from the code with a source path beside each claim. It changes no UI. It exists so that a new design, a new screen or a review starts from what the cockpit already does instead of inventing a variant.

Two readers: a coding agent that must find the right rule fast, and a person who wants the reasons. Read this file first; it routes you to one or two more.

## Route by task

| You are… | Read, in order | Then |
| --- | --- | --- |
| Composing a task table, thread/composer, settings page, overlay or state display | [recipes.md](recipes.md) → [patterns.md](patterns.md) → [components.md](components.md) | Follow the recipe’s source links, copy rules, density and phone checks; use [verification.md](verification.md) to record evidence. |
| Making a new mockup in `designs/<feature>/` | [new-designs.md](new-designs.md) → [patterns.md](patterns.md) → [components.md](components.md) → [writing.md](writing.md) | Link `cockpit.css`, keep only feature rules in the local `styles.css`, open [specimens/](specimens/index.html) beside your page and compare. |
| Adding or changing UI in `packages/web` | [components.md](components.md) (reuse before you build) → [patterns.md](patterns.md) → [foundations.md](foundations.md) → [behaviour.md](behaviour.md) → [writing.md](writing.md) | Run `npm test -- packages/web/src/design-system-drift.test.ts`. A new token, primitive or shared component needs its entry and a row in [coverage.md](coverage.md) in the same commit. |
| Reviewing a design or a UI change | [known-gaps.md](known-gaps.md) (so you do not repeat one) → [patterns.md](patterns.md) → [components.md](components.md) → [behaviour.md](behaviour.md) | Check the ten rules below, then the states and the copy. A departure from a documented pattern needs a reason in the PR or the design's open decisions. Post the verdict as a `## Design review` PR comment (SDLC.md § The design gate); the `design-review` workflow does this. |
| Changing the theme, accent, density or width behaviour | [theming.md](theming.md) → [foundations.md](foundations.md) | Keep the pre-paint script in `packages/web/index.html` and the two libs it mirrors in step. |

## The rules that never bend

Each holds today and `packages/web/src/design-guardian.test.ts` or the drift test enforces most of them. Written once, here; the other files refer back.

1. **Tokens only.** No raw hex, rgb or named colour outside `packages/web/src/styles/index.css`. Use the Tailwind utility a token maps to (`bg-card`, `text-muted-foreground`, `border-border`).
2. **No `dark:` variants.** Dark is the default; `.light` overrides 26 tokens. A component that needs a theme-specific value gets a token, not a variant.
3. **Amber text is `text-pending-strong`**, never `text-pending` or `text-amber-*`. The soft amber is for dots and backgrounds only; it fails contrast as text in light.
4. **No `bg-white`, `text-white`, `bg-black`, `text-black`** outside `src/components/ui/` and `zoomable-image.tsx`. Use `--contrast` and `--contrast-foreground`.
5. **Heights use `dvh`, never `h-screen`, `min-h-screen`, `max-h-screen` or `100vh`.** The phone keyboard must not hide the composer.
6. **No `window.confirm`, `alert` or `prompt`.** Destructive confirms are an AlertDialog with the danger button. The one exemption is `lib/bookmarklet.ts`, which emits a `javascript:` program.
7. **Status comes from `lib/attention.ts`.** `deriveAttention(status)` gives the bucket, tone, pulse and label. Nowhere else maps a run status to a colour or a word.
8. **Backend names come from `lib/runner-label.ts`.** `claude` is "Claude Code", `codex` is "Codex", `opencode` is "OpenCode", `pi` is "pi". A fifth backend is a compile error there, on purpose.
9. **The per-project task table is `lib/task-columns.ts`.** Header, colgroup and rows read `TASK_COLUMNS`; a column is added there, never as a loose `<td>`.
10. **Words carry meaning; colour and icon reinforce.** Every state has its own sentence. Every control has a label. Every action works from the keyboard and shows the `:focus-visible` ring. Nothing scrolls sideways at 375 px.

## What is in this folder

| File | What it holds |
| --- | --- |
| [foundations.md](foundations.md) | Every token with its dark and light value, meaning and Tailwind utility; colour roles; type; spacing and the density lever; radius; shadow; motion and reduced motion; icons; layout and reading width; breakpoints; `no-hover:`; safe areas. |
| [theming.md](theming.md) | Theme, accent, density and width: where each is stored, how the pre-paint script applies it before React, and how a design must behave under each. |
| [components.md](components.md) | Every `src/components/ui` primitive and every shared component: purpose, source, variants and props, states, do and don't, accessibility, where used. |
| [recipes.md](recipes.md) | Source-linked compositions for task tables/pins, threads/composers, settings, overlays and states, with copy, density, phone checks and historical-design limits. |
| [patterns.md](patterns.md) | Shell, sidebar and badges, page headers, lists/cards/tables, status, empty/loading/error, dialogs/sheets/palette/toasts/notifications, settings and forms, the mobile drawer, live updates. |
| [behaviour.md](behaviour.md) | Keyboard and focus, announcements, responsive breakpoints with counts, motion, theming behaviour. |
| [writing.md](writing.md) | UX writing conventions with the real copy quoted and its source. |
| [new-designs.md](new-designs.md) | The rules for a new mockup: the stylesheet link, what a local stylesheet may contain, states, appearance, mobile, accessibility, handoff. |
| [coverage.md](coverage.md) | One row per token, primitive, shared component and pattern with its status. The drift test reads it. |
| [known-gaps.md](known-gaps.md) | Every place the code disagrees with itself: paths, the chosen rule, why, the proposed fix. Also comment-vs-code mismatches and where the mockup stylesheet departs from the cockpit. |
| [decisions.md](decisions.md) | Design decisions made in reviews, one `D-nn` each: date, context, decision, consequences, source. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How the system changes: the criteria for a new token, component or pattern, the triage buckets, fix-by-PR versus design-first, deprecation, decisions versus gaps, and the debt loop. |
| [cockpit.css](cockpit.css) | The shared stylesheet: the tokens of both themes verbatim from `index.css`, the appearance overrides, and base classes for every component. Specimens and every mockup link it by relative path. |
| [specimens/](specimens/index.html) | Static HTML that opens from disk: `foundations.html`, `components.html`, `patterns.html`, `mobile.html`. Light/dark switch, accent, density and width in the bar. No build, no server, no network, no app code. |

## How it stays true

- **The drift test.** `packages/web/src/design-system-drift.test.ts` runs in `npm test`, fast, offline. It fails when a custom property in `index.css` (the theme blocks, the appearance blocks, `@theme static` or the `@theme inline` mapping) is not named as `` `--name` `` in these documents; when a primitive (`src/components/ui/*.tsx`) or a shared component (a non-test `.ts`/`.tsx` directly in `src/components/`, `src/components/composer/` or `src/components/diff/`) has no row in `coverage.md`; or when a token value in `cockpit.css` differs from `index.css` for either theme, or `cockpit.css` declares a token `index.css` does not. The definitions of "primitive" and "shared component" are stated once in `components.md` and in the test; change both together.
- **Why there is no tokens JSON.** A separate DTCG file would be a third copy of the values. `cockpit.css` already is the machine-readable token sheet, it is what the drift test compares, and a mockup can link it directly. If a tool ever needs JSON, generate it from `index.css` in a test the same way; do not hand-maintain it.
- **Inconsistencies are recorded, not fixed here.** When the code has two ways to do one thing, the rule is the most common one (the newest when split), the entry says so, and the gap sits in `known-gaps.md` with paths and a proposed fix. Where a comment and the code disagree, the code wins and the mismatch is listed there too.

## Maintenance

When you change the cockpit:

1. **A token.** Edit `index.css`, then the matching row in `foundations.md` (both themes) and the verbatim block in `cockpit.css`. The drift test tells you which one you forgot.
2. **A primitive or shared component.** Add or update its entry in `components.md` and its row in `coverage.md`. New file, new row.
3. **A pattern.** Update `patterns.md` and, if the look changed, the specimen that shows it.
4. **Copy.** Quote the new string in `writing.md` with its source path.
5. **A fixed gap.** Delete its entry in `known-gaps.md` and remove the `(G-nn)` references that pointed at it.
6. **The mockup stylesheet.** `cockpit.css` base classes are hand-written to match the components; when a component's look changes, change the class and re-open `specimens/components.html` beside the app.
7. **A design decision.** Record it in `decisions.md` as the next `D-nn` and link it from the review comment.

The Claude Code skill in `.claude/skills/design-system/SKILL.md` points an agent here; `AGENTS.md` routes design work to this file; `.xezar/skills/xezar-ux-design.md` reads it before a design, and the kit workflows `design` (mockup plus draft PR) and `design-review` (read-only verdict) run that skill. How the system itself changes is in [CONTRIBUTING.md](CONTRIBUTING.md).
