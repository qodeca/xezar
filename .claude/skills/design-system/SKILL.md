---
name: design-system
description: >-
  Routes cockpit design work to this repository's design system in
  docs/design-system/ before any UI is written, so tokens, components and
  patterns come from the documentation instead of being invented. Applies when
  the work touches cockpit UI in packages/web, a mockup in designs/<feature>/,
  or a UX/UI review of either. Trigger phrases: "design system", "which token
  do I use", "add a screen to the cockpit", "change this component in
  packages/web", "new mockup in designs/", "UX review of this page", "does this
  match the cockpit look", "dark and light theme", "shadcn primitive",
  "Tailwind token", "design review before merge", "cockpit styling",
  "needs-design", "design gate", "design review evidence". Not for
  general colour or component talk outside this repository, and not for making
  the change or writing the review itself.
allowed-tools: Read, Glob, Grep, AskUserQuestion
---

# design-system

This skill finds the rule that governs a piece of cockpit design work – it does not make the change.

## Core principle

The cockpit already decided most of this. Start from `docs/design-system/README.md`, which routes by task, and invent nothing it already names – no new token, prop, variant or pattern.

## When this applies

- A mockup in `designs/<feature>/`.
- New or changed UI in `packages/web`.
- A UX/UI review of either.
- Theme, accent, density or width work.

If the surface or the task type is unclear, ask ONE question via AskUserQuestion and nothing else:

| Option | Pick when | Recommended |
| --- | --- | --- |
| Mockup | The deliverable is HTML in `designs/<feature>/` | ✓ when the request names a design folder |
| UI change | The deliverable is code in `packages/web` | ✓ when the request names a component, route or file |
| Review | The deliverable is findings on an existing design or PR | – |

## Out of scope

This skill does not make the UI change, choose the design or write the review. No code changes, no dependencies, no agents. It MUST NOT invoke another skill: it returns the reading route and the rules, then stops.

## Workflow

1. Read `docs/design-system/README.md`. – [ ] Precondition: the file exists (if not, STOP and say the design system is missing).
2. Pick the route (ask the one question only when unclear). – [ ] The route is one of mockup, UI change, review, theming.
3. Read the files in the route's order. – [ ] Every file in the row was opened.
4. Return the route, the reading order and the rules that bite for this task, with the owning file for each. – [ ] Every cited rule names its owner.
5. Stop – hand back to the caller (see Terminal state).

## Route by task

Filenames are repo-relative under `docs/design-system/`.

| Task | Read, in order | Then |
| --- | --- | --- |
| New mockup in `designs/<feature>/` | `new-designs.md` → `patterns.md` → `components.md` → `writing.md` | Link `../../docs/design-system/cockpit.css` first and keep only feature rules in the local `styles.css`; open `specimens/index.html` beside the page. |
| New or changed UI in `packages/web` | `components.md` (reuse before building) → `patterns.md` → `foundations.md` → `behaviour.md` → `writing.md` | Run the drift test and update `coverage.md` and `cockpit.css` in the same commit. |
| Review of a design or a UI change | `known-gaps.md` (so a gap is not repeated) → `patterns.md` → `components.md` → `behaviour.md` | Check the rules below, then the states and the copy; a departure needs a reason in the PR or in the design's open decisions. The checklist and the verdict words live in `.xezar/skills/xezar-ux-design.md` § Review mode; post the verdict as a `## Design review` PR comment. |
| Theme, accent, density or width | `theming.md` → `foundations.md` | Keep `packages/web/index.html` pre-paint and `lib/theme.ts` + `lib/appearance.ts` in step. |

## The rules

1. Tokens only – no raw hex, rgb or named colour outside `packages/web/src/styles/index.css`. Owner `design-guardian.test.ts`.
2. No `dark:` variants – dark is the default, `.light` overrides. Owner `design-guardian.test.ts`.
3. Amber text is `text-pending-strong`, never `text-pending` or `text-amber-*`. Owner `design-guardian.test.ts`.
4. No `bg-white`/`text-white`/`bg-black`/`text-black` outside `src/components/ui/` and `zoomable-image.tsx`. Owner `design-guardian.test.ts`.
5. Heights use `dvh`, never `h-screen`, `min-h-screen`, `max-h-screen` or `100vh`. Owner `design-guardian.test.ts`.
6. No `window.confirm`, `alert` or `prompt` – destructive confirms are an AlertDialog (`lib/bookmarklet.ts` is the one exemption). Owner `design-guardian.test.ts`.
7. Status → bucket, tone, pulse, label comes from `lib/attention.ts`. Owner `patterns.md §5`.
8. Backend names come from `lib/runner-label.ts`. Owner `components.md`.
9. The per-project task table is `lib/task-columns.ts`. Owner `patterns.md §4`.
10. Words carry the meaning; colour and icon reinforce it. Owner `writing.md`.
11. Every action works from the keyboard and shows the `:focus-visible` ring. Owner `behaviour.md`.
12. Nothing scrolls sideways at 375 px. Owner `behaviour.md`.
13. An inconsistency is recorded in `known-gaps.md`, never fixed silently. Owner `known-gaps.md`.
14. A UI change updates `coverage.md` and `cockpit.css` in the same commit. Owner `design-system-drift.test.ts`.
15. A mockup links `../../docs/design-system/cockpit.css` and keeps only feature rules locally. Owner `new-designs.md`.
16. A UI-in-scope PR carries `needs-design` and merges only with `design-approved`. Owner `SDLC.md § The design gate`.

## Verify

For `packages/web`: `npm test -- packages/web/src/design-system-drift.test.ts`. It fails on an undocumented `index.css` token, a component without a `coverage.md` row, or a `cockpit.css` value that differs from `index.css`. The full gate list is in AGENTS.md § Validation.

For a mockup: open `docs/design-system/specimens/index.html` beside the page, in both themes and at 375 px.

Self-check: remove one row from `docs/design-system/coverage.md`, run the drift test and see it fail; restore the row and see it pass.

## Precedence

When this file and `docs/design-system/` disagree, the docs win – fix this file. The drift test guards tokens and components, not prose.

A user may override a prose-owned rule (7–15) for one task only with a written reason; the override goes into the PR description or the design's open decisions, and the rule itself is changed only in `docs/design-system/`. A rule owned by a test (1–6, 14) is never waived in prose – an exception changes the test in its own commit, with the reason.

## Examples

- **User:** "Add a Checks page to the cockpit sidebar" → **Skill:** UI change route – read `components.md` first; rule 9 (the per-project task table goes through `lib/task-columns.ts`) and rule 14 (`coverage.md` and `cockpit.css` in the same commit).
- **User:** "Make a mockup for the inbox redesign in designs/inbox/" → **Skill:** mockup route – read `new-designs.md` first; rule 15 (link `../../docs/design-system/cockpit.css`, keep only feature rules in the local stylesheet).
- **User:** "Review this PR that changes the task page header" → **Skill:** review route – read `known-gaps.md` first (G-01, page headers), then `patterns.md §3`; rule 10 (words carry the meaning before colour does).

## Anti-patterns

- Copying token values into this file instead of pointing at `foundations.md`.
- Inventing a variant `components.md` does not name.
- Fixing an inconsistency silently instead of recording it in `known-gaps.md`.
- Changing UI without the `coverage.md` and `cockpit.css` update.
- Adding a `dark:` variant.
- Calling another skill from here.

## Terminal state

After returning the route and the rules, hand back to the caller. Deeper design work is `.xezar/skills/xezar-ux-design.md`, run by the kit workflows `design` (mockup plus draft PR) and `design-review` (read-only verdict); this skill launches neither.
