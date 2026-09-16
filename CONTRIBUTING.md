# Contributing to xezar

Thank you for helping. This page is the whole path from an idea to a merged change.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the shape.
- Found a security problem? Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## The loop

1. Fork the repository (or branch, if you have write access) and branch off `main`.
2. Install and build: `npm install`, then `npm run build`. You need Node 20+ and `git`.
3. Make your change, with a test for any change in behaviour.
4. Run the fast checks locally:

   ```bash
   npm run typecheck
   npm test
   ```

   CI runs the full gate on your pull request (`npm run test:unit`, `npm run build`,
   `npm run test:package` and the browser suite), so you do not have to.
   `XEZ_DRY_RUN=1` replaces the agent CLIs with a mock, so you can exercise the cockpit without any agent login.
5. Open a pull request against `main`.

## Local development

End-to-end, from a fresh clone to a global `xezar` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 20+ and `git` (plus at least one logged-in agent CLI,
as in the README's [Quick start](README.md#quick-start)).

**2. Clone & install**

```bash
git clone https://github.com/qodeca/xezar.git
cd xezar
npm install
```

**3. Build** — compiles the server (`tsc → packages/xezar/dist/`), folds the
contract into `dist/contract/` so the published tarball resolves it, and builds
the cockpit (`vite build → packages/xezar/web/dist/`), then runs the pack gate:

```bash
npm run build
```

**4. Install as a global command** — build + put `xezar` / `xez` on
your PATH pointing at *this checkout*:

```bash
npm run install-as-command            # live link (default) — see the change loop below
#   or: npm run install-as-command:global   # self-contained snapshot copy
```

Now `cd` into any other repo and run it:

```bash
cd ~/some-other-project
xezar            # cockpit for that repo, straight off your checkout
xez --help       # same binary under its short name
```

**5. The change loop**

- **Link mode** (default): edit source → `npm run build` → the global command
  reflects it immediately. No relink needed. (It is a live symlink into this
  checkout — don't move or delete the checkout while it's linked.)
- **Snapshot mode** (`:global`): re-run `npm run install-as-command:global` to
  refresh the installed copy. It survives moving/deleting the checkout.

**6. Uninstall**

```bash
npm run uninstall-as-command    # removes xezar / xez (either flavor)
```

**7. Troubleshooting**

- **`xezar: command not found`** after install → your npm global bin dir isn't on
  PATH. The script prints the exact dir; add it to your shell profile
  (`export PATH="$(npm prefix -g)/bin:$PATH"`).
- **`EACCES` / permission denied** → your global prefix is root-owned. Point npm
  at a user-writable one and retry — **never** sudo:
  `npm config set prefix ~/.npm-global`.
- **Already installed the published `@qodeca/xezar` globally?** The
  link/snapshot install replaces it; `uninstall-as-command` removes ours, and
  `npm i -g @qodeca/xezar` brings the published one back.

### In-checkout scripts

```bash
npm run dev          # server (API :4321) + Vite dev server, opens the cockpit in the browser
npm run dev:server   # tsx packages/xezar/src/index.ts — the API server alone
npm run dev:web      # Vite dev server alone (proxies /api to :4321)
npm run build        # tsc → packages/xezar/dist/, vite build → packages/xezar/web/dist/, then the pack gate
npm run typecheck    # contract + api-client + server + web (tsc --noEmit)
npm test             # vitest — server + cockpit unit suites
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
```

The full canonical gate list, its order and the rules behind it are in
[AGENTS.md § Validation](AGENTS.md#validation).

Coverage is measured separately, and is not part of the validation gate:
`npm run test:coverage` runs the vitest suites under the v8 provider and writes line and branch
numbers to `.local/coverage/`. The behaviour-led gap analysis built from it lives in
[docs/testing/coverage-gaps.md](docs/testing/coverage-gaps.md).
The MCP server is the one scope held to a floor: `npm run test:coverage:mcp` measures it alone
and fails any file under 80 % lines or branches – see
[SDLC.md § The MCP test floor](SDLC.md#the-mcp-test-floor).

### Stack and layout

The stack is deliberately small: **TypeScript** (strict, ESM), **Hono** + SSE for
the server, **Zod** at every boundary, **YAML** for workflows, and a **React 19 +
Vite + Tailwind v4 + shadcn/ui** cockpit shipped pre-built in `packages/xezar/web/dist/` — the
published package carries the built app, so `npx` users never run a bundler.
Every module is meant to be read in one sitting.

Agent backends share one seam: a backend is one class implementing the `AgentRunner` interface
(`packages/xezar/src/core/agent-runner.ts`) that turns a prompt into a stream of normalized events.
`pi` was added exactly that way; other CLIs can slot into the same seam.
[AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) is the contract a new runner must satisfy.

The README is the npm page too: `packages/xezar/scripts/sync-readme.mjs` copies it into the package
on every build and makes its relative links, images and `srcset` candidates absolute.

What lives where under `docs/`, and who each part is for, is mapped in
[docs/README.md](docs/README.md). `docs/features/` is the internal engineering and decision
record, not a user guide.

### Shipped text is generic

Follow [AGENTS.md § Generic instructions](AGENTS.md#generic-instructions) for every string
Xezar ships to a person or agent. To add an allowed exception to the guard introduced in
[PR #481](https://github.com/qodeca/xezar/pull/481), name the exact field (producer location
and text fragment), the matching rule, the reason and the review reference. Add a negative
test showing that a project-specific instruction beside it still fails. Never exempt a whole
file or paragraph, or widen the shrinking allowance for outstanding repairs. Naming a client's
own instruction file as a capability is allowed; asking users to adopt Xezar's kit or process is not.

## Commits and pull requests

Commit messages and pull-request titles follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. Pull requests are squash-merged, so the title becomes the commit on `main`.

A good pull-request body says what changed, why, how you verified it, and whether it is risky. The template asks for exactly that. Put `Closes #<n>` in the body when it fixes an issue. For a user-visible change you may add a line under `# Unreleased` in [CHANGELOG.md](CHANGELOG.md); a maintainer will write it otherwise.

## You do not need the kit workflows

[SDLC.md](SDLC.md) names the kit workflows in `.xezar/workflows/` and their `xezar-*` roles (`bug-fix`, `code-review`, `integration`, …) as the actor at each stage. They are this project's internal automation, run through xezar itself, and an outside contributor does not need them. The human path through the same stages is:

| SDLC stage | What you do |
|---|---|
| Intake, triage | Open an issue, or comment on an existing one. |
| Claim | Comment on the issue that you are working on it. |
| Implement, PR | Follow the loop above and open a pull request. |
| Review loop | A maintainer reviews; you push fixes to the same branch. |
| QA, merge | A maintainer applies the labels, runs any manual QA and squash-merges. |

You never apply labels yourself.

## Deeper reading

- [AGENTS.md](AGENTS.md) – how the code is organised and the rules each area keeps.
- [SDLC.md](SDLC.md) – the full delivery process, labels and the two merge gates: QA and design.
- [CODE_REVIEW.md](CODE_REVIEW.md) – what reviewers check.
- [BACKWARD_COMPATIBILITY.md](BACKWARD_COMPATIBILITY.md) – the public surfaces a change must not break silently.
- [docs/design-system/](docs/design-system/README.md) – the cockpit's tokens, components and patterns; read it before you design or change any UI.
