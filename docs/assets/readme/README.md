# README graphics for 0.15.0

Maintained SVG sources for the short product-page README. These are illustrations,
not screenshots. Root `README.md` wiring belongs to PR-2; the package README is a build copy.

## Inventory

Sizes are bytes (limit: 60,000 bytes per SVG).

| File | Bytes | Intended placement |
| --- | ---: | --- |
| [README.md](README.md) | 5,523 | Asset inventory and editing guidance |
| [architecture-dark.svg](architecture-dark.svg) | 5,023 | README “How it works” |
| [architecture-light.svg](architecture-light.svg) | 5,023 | README “How it works” |
| [hero-dark.svg](hero-dark.svg) | 3,734 | README top |
| [hero-light.svg](hero-light.svg) | 3,734 | README top |
| [icons/agents.svg](icons/agents.svg) | 406 | Feature grid: Four backends |
| [icons/density.svg](icons/density.svg) | 357 | Feature grid: Themes/density |
| [icons/github.svg](icons/github.svg) | 617 | Feature grid: GitHub |
| [icons/local-only.svg](icons/local-only.svg) | 425 | Feature grid: Local-only |
| [icons/mcp-leader.svg](icons/mcp-leader.svg) | 447 | Feature grid: MCP leader |
| [icons/parallel-runs.svg](icons/parallel-runs.svg) | 403 | Feature grid: Parallel runs |
| [icons/phone-friendly.svg](icons/phone-friendly.svg) | 361 | Feature grid: Phone-friendly |
| [icons/queue-memory.svg](icons/queue-memory.svg) | 444 | Feature grid: Queue + memory ceiling |
| [icons/review-pr.svg](icons/review-pr.svg) | 462 | Feature grid: Review gate + draft PR |
| [icons/skills.svg](icons/skills.svg) | 310 | Feature grid: Skills |
| [icons/workflows.svg](icons/workflows.svg) | 423 | Feature grid: Workflows |
| [icons/worktrees.svg](icons/worktrees.svg) | 399 | Feature grid: Worktrees |
| [lifecycle-dark.svg](lifecycle-dark.svg) | 4,324 | Guide 02 “A task’s life”; guide 05 workflows |
| [lifecycle-light.svg](lifecycle-light.svg) | 4,324 | Guide 02 “A task’s life”; guide 05 workflows |

## Design and use

- Use the matching dark/light illustration in a `<picture>`; all six have explicit
  dimensions and a `viewBox`. Hero: 1280 × 400; architecture: 1200 × 640;
  lifecycle: 1200 × 360. Icons: 48 × 48.
- Colours are fixed values from [foundations](../../design-system/foundations.md)
  and [cockpit.css](../../design-system/cockpit.css): background, foreground, card,
  sidebar, muted, muted-foreground, soft-foreground, border, violet, success,
  pending amber, and danger. Red marks failure only.
- The hero reuses both X paths and the rounded tile geometry from
  [xezar.svg](../../../packages/web/public/xezar.svg), including its violet → sky → teal gradient and `#14121F` strokes.
  These brand colours come directly from the product mark; surrounding UI uses tokens.
- Icons use the fixed violet token `#8f86e8` with a 2px round stroke, round joins,
  and 4px rounded rectangles. The GitHub brand icon uses the canonical filled
  `GithubIcon` path from `packages/web/src/components/icons.tsx`. Violet exceeds 3:1 against both white and GitHub’s
  dark `#0d1117`; they work through `<img>` without inherited `currentColor`.
- Text uses `ui-sans-serif, system-ui, sans-serif`, at least 22px before scaling.
  All SVGs have accessible titles; illustrations also include descriptions.
  Supply contextual alt text when embedding through `<img>`.
- Review is optional and off by default. Configured workflow gates, PR creation,
  and human merge are milestones, not additional task statuses. The lifecycle is
  a summary, not an exhaustive state-transition reference.
- Architecture describes local mode. Agent-provider and GitHub connections are
  separate from local orchestration; the diagram does not claim offline inference.

## Changing a graphic

These SVGs are hand-edited vector sources; there is no generator. Edit both theme
variants together, keeping geometry and wording identical. Use these seven token
pairs (dark → light) for the corresponding shapes and text; do not perform a global
hex replacement because several dark tokens share a value.

| Token | Dark | Light |
| --- | --- | --- |
| Background | `#0d0d0d` | `#ffffff` |
| Foreground | `#ffffff` | `#171717` |
| Card / sidebar | `#171717` | `#ffffff` / `#fafafa` |
| Muted | `#262626` | `#f7f7f7` |
| Muted foreground | `#a3a3a3` | `#5c5c5c` |
| Soft foreground | `#7b7b7b` | `#a3a3a3` |
| Border | `#262626` | `#ebebeb` |

The product gradient, icon violet, pending amber, success and danger stay fixed
across themes. Preserve the canonical logo and GitHub paths. After editing, inspect
both themes at 50% scale, run the asset check below, and update the byte table by
hand using file sizes in bytes (including this README).

Placement follows the plan: the hero and architecture belong in the short README;
“A task’s life” belongs in guide 02 (tasks and runs) and guide 05 (workflows).
Those guide pages and embedding links are delivered by subsequent PRs. PR-2 must
link each picture to its full-size SVG for phone readers (design review NB-6).

## Verification

From the repository root:

```sh
node --import tsx --test packages/xezar/test/unit/readme-assets.test.ts
```

The existing `npm run test:unit` also discovers the check. It recursively checks
SVG size, script/active content, external references, vector-only content,
dimensions and accessible titles. A temporary script in `hero-dark.svg` was
rejected with `scripts are forbidden`, then removed. The illustrations were
visually inspected at 50% scale; independent design approval remains a PR gate.

Preview: open the SVGs from the PR's Files tab.
