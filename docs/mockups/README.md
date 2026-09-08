# UI redesign mockups

High-fidelity static HTML mockups for the cockpit UI redesign.

Built on real xezar data (run `2d012907`'s actual NDJSON events, real skill names, real `packages/xezar/src/server/git.ts` content) and a shared token sheet ([`tokens.css`](tokens.css)) implementing the Mercato design system (neutral ramp, lime/violet accents, Inter + JetBrains Mono, shadcn-style primitives). No JavaScript, no external assets besides the fonts import — open any file directly in a browser. Dark is default; add `class="light"` to `<html>` for the light theme.

| Page | Shows | Issues |
|---|---|---|
| [`thread.html`](thread.html) | Task thread: tool cards, context groups, reasoning, plan dock, step rail, composer with Dictation | #381 #382 #380 |
| [`new-task.html`](new-task.html) | Full-screen composer: skill picker dropdown, plan-mode toggle, variants | #386 #383 #377 |
| [`git-changes.html`](git-changes.html) | Session Changes tab: file tree, word-level diff, commit/push/Create PR action bar | #390 |
| [`tasks-home.html`](tasks-home.html) | Task table with editable titles, ± stats, live CPU/Mem; sidebar quick-list with variant groups | #389 |
| [`settings-skills.html`](settings-skills.html) | Settings tab with registry sub-nav; skills project-first/bold | #377 |

Open any file directly in a browser to see it — there are no rendered PNGs to keep in sync. Each mockup is responsive; narrow the window to 390px to see the phone layout, and add `class="light"` to `<html>` for the light theme.

These are design targets for visual approval — the implementation is React + shadcn/ui, not these static files.
