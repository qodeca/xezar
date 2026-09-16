## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem this solves. Link the issue: "Closes #123". -->

## How it was verified

<!-- The commands you ran and what they showed, e.g. `npm run typecheck` and `npm test`.
     For a cockpit change, say what you exercised by hand (an `XEZ_DRY_RUN=1` session needs no agent login). -->

## Design

<!-- UI in scope = any non-test .tsx under packages/web/src/routes or packages/web/src/components, index.css, cockpit.css, or anything under designs/. SDLC.md § The design gate. -->
- [ ] Not UI in scope
- [ ] UI in scope – `needs-design` applied (outside contributors: a maintainer applies it). Design: `designs/<feature>/` or "fix-sized"
- [ ] `skip-design`, because: <rendered output unchanged – say why>

Design review evidence: <link to the "## Design review" comment or the design README section>

## Risk

<!-- SDLC.md defines one risk flag, `risk-high`: the change touches the runner seam, worktree or
     branch handling, the `.local/xezar/` or `~/.xezar/config.json` formats, the HTTP API, or edits
     broadly across the tree. Say which, or "ordinary". A maintainer applies the label. -->

- [ ] This change is `risk-high`
