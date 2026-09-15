# README graphics for 0.15.0

Maintained SVG sources for the short product-page README. These are illustrations,
not screenshots. Root `README.md` wiring belongs to PR-2; the package README is a build copy.

## Inventory

Sizes are bytes (limit: 60,000 bytes per SVG).

| File | Bytes | Intended placement |
| --- | ---: | --- |
| [README.md](README.md) | 3,678 | Asset inventory and embedding guidance |
| [architecture-dark.svg](architecture-dark.svg) | 4,761 | How it works |
| [architecture-light.svg](architecture-light.svg) | 4,761 | How it works |
| [hero-dark.svg](hero-dark.svg) | 3,421 | README top |
| [hero-light.svg](hero-light.svg) | 3,421 | README top |
| [icons/agents.svg](icons/agents.svg) | 399 | Feature grid |
| [icons/automations.svg](icons/automations.svg) | 304 | Feature grid |
| [icons/density.svg](icons/density.svg) | 346 | Feature grid |
| [icons/github.svg](icons/github.svg) | 430 | Feature grid |
| [icons/inbox.svg](icons/inbox.svg) | 312 | Feature grid |
| [icons/mcp-leader.svg](icons/mcp-leader.svg) | 447 | Feature grid |
| [icons/settings.svg](icons/settings.svg) | 444 | Feature grid |
| [icons/skills.svg](icons/skills.svg) | 310 | Feature grid |
| [icons/tasks.svg](icons/tasks.svg) | 359 | Feature grid |
| [icons/workflows.svg](icons/workflows.svg) | 423 | Feature grid |
| [icons/worktrees.svg](icons/worktrees.svg) | 399 | Feature grid |
| [icons/zero-config.svg](icons/zero-config.svg) | 322 | Feature grid |
| [lifecycle-dark.svg](lifecycle-dark.svg) | 4,253 | A task’s life |
| [lifecycle-light.svg](lifecycle-light.svg) | 4,253 | A task’s life |

## Design and use

- Use the matching dark/light illustration in a `<picture>`; all six have explicit
  dimensions and a `viewBox`. Hero: 1280 × 400; architecture: 1200 × 640;
  lifecycle: 1200 × 360. Icons: 48 × 48.
- Colours are fixed values from [foundations](../../design-system/foundations.md)
  and [cockpit.css](../../design-system/cockpit.css): background, foreground, card,
  sidebar, muted, muted-foreground, border, primary lime, primary-foreground,
  violet, success, and danger. Red marks failure only.
- The hero reuses both X paths and the rounded tile geometry from
  [xezar.svg](../../../packages/web/public/xezar.svg), with the token lime fill.
- Icons use the fixed violet token `#8f86e8` with a 2px round stroke, round joins,
  and 4px rounded rectangles. Violet exceeds 3:1 against both white and GitHub’s
  dark `#0d1117`; they work through `<img>` without inherited `currentColor`.
- Text uses `ui-sans-serif, system-ui, sans-serif`, at least 22px before scaling.
  All SVGs have accessible titles; illustrations also include descriptions.
  Supply contextual alt text when embedding through `<img>`.
- Review is optional and off by default. Configured workflow gates, PR creation,
  and human merge are milestones, not additional task statuses. The lifecycle is
  a summary, not an exhaustive state-transition reference.
- Architecture describes local mode. Agent-provider and GitHub connections are
  separate from local orchestration; the diagram does not claim offline inference.

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
