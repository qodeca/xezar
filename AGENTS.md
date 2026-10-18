# AGENTS.md — working in this repository

xezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo, with Claude Code, Codex or Qwen Code as the backend, or a mix per step. A git task runs in its own isolated worktree by default and never falls back to your checkout (details: `packages/xezar/src/AGENTS.md` § Git / worktree logic). xezar never auto-merges — a finished run can be pushed as a draft PR through `gh`, and merging stays with you. Everything is local: no accounts, no database, no cloud — runtime state is plain JSON, NDJSON and Markdown under `.local/xezar/`; maintained project workflows, skills and guidance live in `.xezar/`. The server stack stays deliberately small, with Zod at every boundary, and every module is meant to be read in one sitting.

## Zero config

xezar ships no config file the user must create and no setting they must set before it works. Every capability is discovered from what is already there — the repo, the environment, `gh`, the running processes — or it degrades quietly to a smaller xezar. `.xezar/config.json` is optional and every key has a working default; `.env` is never auto-loaded.

New runtime state may be **written**, never **required**: `.local/xezar/`, `~/.cache/xez/`, `~/.xezar/`. Deleting runtime state discards local history; xezar rebuilds the infrastructure it needs on the next run. The versioned `.xezar/` kit is project source and must not be treated as disposable runtime data. State that a user must author, migrate, or repair is not state — it is configuration, and it needs a reason. One deliberate exception inside that rule: the project registry keeps a `~/.xezar/config.json.bak` snapshot, so deleting `config.json` alone restores instead of resetting — delete the `~/.xezar` directory for a true reset.

Practical rules:

- When a feature seems to need configuration, the design is wrong. Discover it, or default it.
- Features that widen exposure or cost (network, other processes) are opt-in behind a `XEZ_*` flag, off by default — the zero-config default is also the safe default.
- Owner-approved exception: `qodeca/xezar-skills` updates are default-on. They start only after the server listens, run at most once per six-hour cache window, use explicit lock-authorized names and fixed bounded `npx` argument arrays under a cross-process lock, and never block boot. `XEZ_SKILLS_AUTO_UPDATE=0` or the global Settings override disables automatic application (background detection remains read-only).
- Owner-approved exception (#1030, 2026-10-16): on Windows, a confined read-only Codex step whose Git Bash dies with the exact `CreateFileMapping … Win32 error 5` sandbox crash runs the rest of that session with `dangerFullAccess`, once, only when its `bashAllowlist` hook is active (it still checks every shell command and refuses `apply_patch`), and with a run note. A crash without the hook, under `XEZ_CODEX_NETWORK=0`, or after the lift fails the step. `XEZ_CODEX_SANDBOX_FALLBACK=0` fails it instead.
- Owner-approved exception (#863 S2): a read-only Codex run with `bashAllowlist` may persist its content-addressed `PreToolUse` entry and exact trust hash in the active Codex profile; the cached handler is read-only and inert outside the marked xezar run.
- A missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit, never fail the boot.
- Owner-approved exception (#1046, decided in #1041): every command that saves settings or records (all but `mcp` and `lease`) refuses to start, and the cockpit refuses to open a project, while a saved setting or task record still names the removed `pi` or `opencode` backend (`packages/xezar/src/legacy-backends.ts`). Degrading there would lose data silently – one unknown id drops every run in `runs.json`, and one in `.xezar/config.json` resets every setting – and xezar must not rewrite stored data. The check is read-only and lists every file and field to fix.
- Prefer a proxy-free, daemon-free mechanism when one exists — and when it doesn't, keep the mechanism invisible: no process to manage, no port to remember, no file to edit.
- Never trade a working default for a knob.
- Adding, renaming, or removing a `XEZ_*` env var — or changing what its default does, or giving it a *stored* config key that supersedes it at runtime — updates `.env.example` in the same commit (and the README env table when the var is user-facing). That last case is the one people miss: `XEZ_FOLLOWUPS` and `XEZ_ENV_PASSTHROUGH` are now boot-time defaults behind a stored workspace key, so the var still exists and no longer decides. `.env.example` is the env contract's single documentation surface; an undocumented env var is a bug.

## Generic instructions

Released Xezar must never contain instructions specific to a particular project. Every
instruction we ship must suit any project — software, an advertising agency, scientific
research — while keeping enough detail for Xezar to work correctly. This covers text read
by people **and** agents: prompts, built-ins, init output, MCP descriptions and guidance,
cockpit copy, recovery pages, the npm README and bundled examples.

Practical rules:

- Start with the user's outcome, inputs, deliverable and constraints. Never prescribe this
  repository's names, paths, people or process.
- Discover capabilities before giving instructions: Git for versioning and isolation,
  GitHub when relevant for issues and PRs, existing checks for verification. Without them,
  deliver locally and name the evidence that is unavailable; never invent a check.
- Prefer plan, draft, review, verify, revise and deliver. Explain product terms in plain
  words, such as “isolated working copy (Git worktree)”.
- Keep the operational contract precise: current project and task identity, available tools,
  result locations, resume steps, questions, completion, failure and authority boundaries.
  Generic wording must preserve protocol markers, schemas, retries and refusal behavior.
- Separate supplied evidence from assumptions, and proposed criteria from acceptance.
  A finished tool call or a successful command is not approval of the result.
- Keep specialization conditional. A software workflow may describe software precisely;
  the default must remain useful without a software pipeline.
- Use three labeled examples: software — repair a calculation and run existing relevant
  tests; advertising agency — draft a campaign brief and check audience, budget and claims
  against supplied material; scientific research — revise a paper section and check citations,
  methods and stated limitations against provided sources. No example authorizes publication.

Exact capability references are allowed ([#466](https://github.com/qodeca/xezar/issues/466)): shipped help **may** name a client's own instruction file,
such as `AGENTS.md` or `CLAUDE.md`, to say what that client reads. It must **never** tell users
to adopt Xezar's own files or process – this repository's process documents, gates, `.xezar/`
files, checks or workflows, or our AGENTS.md and review conventions. Preserve user-authored guidance
and supported client filenames; neither is permission to distribute our project instructions.

The enforcement is the instruction-producer
guard `packages/xezar/src/release/generic-instructions.test.ts` and the `check:pack` scan of
actual packed-archive text. The producer guard and archive scan complement each other; a word
list alone cannot establish that instructions work across domains. Exceptions for capability
references, package/provider identity, product documentation/support links or legal attribution
must identify the exact field and fragment, carry a reason and review reference, and have a
negative test proving adjacent project instructions still fail. Never exempt a whole file or
instruction paragraph; never widen the shrinking allowance for outstanding repairs.

A string a user will read ships generic; a rule this repo follows stays in AGENTS.md.

## Changing a mechanism that already works

Replacing working behavior is the highest-risk change in this repo, and it fails in a
characteristic way: the new mechanism is correct, the tests are green, the spec is
thorough — and the *default* path quietly lost a guarantee nobody wrote down. The seven
rules below are what that keeps costing; the worked examples behind six of them (all but “Prove the regression test fails without the fix”) are in
[docs/lessons/changing-working-mechanisms.md](docs/lessons/changing-working-mechanisms.md).

**Name what the old mechanism was load-bearing *for*, not what it was for.** Those are
different questions, and the second one is the one specs answer. Before deleting a timer,
lock, cap or timeout, grep for everything that reaches a terminal state *because* of it.

**A replacement that ships off is not a replacement.** Diff the default path, not the
feature. The question is always: *with every new knob at its shipped default, what does
the old scenario do now?* If the answer is "nothing", the change removed a mechanism and
added a setting. See § Zero config: *never trade a working default for a knob*.

**Enumerate the transitions out of every state you add or keep.** "Who fires this?" is the
question that finds these bugs in one step. A state whose only on-by-default exit is "a
human types something" is a dead end, however well it renders.

**Find every construction site of a shared in-memory object — grep the type, not the
field.** When you add a field that a delivery path reads, add it everywhere in the same
commit, or route both sites through one helper. Half the sites is half a fix.

**A fail-open helper needs a populated-input guarantee, or it lies.** Pair every silent
pass-through with a test that pins the *empty or absent input* case: against empty input,
"we never loaded the list" and "no match" are the same branch and must not read the same.

**Prove the regression test fails without the fix.** `git stash push -- <source files>`,
run the new test, confirm red, `git stash pop`. A test written after the diagnosis passes
against the bug more often than anyone expects, and a green-either-way test is how the
same regression ships twice. Keep the guard tests that pass both ways — they pin the
behavior you did not want to change — but know which is which.

**Read the run-history evidence before theorizing, and cite it.** `git log -S` and
`git merge-base --is-ancestor <commit> <tag>` settle "was this in the release the user is
on", and a user's "it worked in 0.9.1" is a testable claim, not an opinion.

## The HTTP API

Four invariants. A feature that breaks any of them compiles on its own branch and stops working
when it lands — pre-rename issue 694 arrived with eleven unreachable routes for exactly this reason.

- **Every request and response shape is a zod schema in `packages/contract`, with its TypeScript
  type inferred (`z.infer`).** Never hand-write an API type, and never declare one in `server.ts`
  or in the api-client.
- **Register routes by chaining them into a family builder.** A loose `app.get(…)` drops out of
  `AppType`, so the typed client cannot see the route while the server still serves it.
- **Validate bodies, path params and the query string as route middleware**, through the trio in
  `src/server/validators.ts`. Parsing inside a handler is invisible to hono.
- **Everything answers under `/api/v1`** (project-scoped: `/api/v1/p/:projectId/…`).

The contract describes exactly what the route sends: when they disagree, fix the source, never
widen the schema. The reasons, the request-schema migration rules and the two recurring
mismatches are in `packages/contract/src/AGENTS.md` § The HTTP API in detail — read it before
you touch a route or a shape.

## Repository layout

Four npm workspaces under a `private` root that publishes nothing itself. Exactly one of them reaches npm — `@qodeca/xezar` — and only through the manually dispatched `Release` workflow (see [docs/publishing.md](docs/publishing.md)):

| Path | Package | What it is |
| --- | --- | --- |
| `packages/xezar` | `@qodeca/xezar` | The service + CLI, and everything behind them (runs, workflows, agent runners, workspace state). The published artifact: `bin`, plus the built cockpit in `web/dist`. |
| `packages/contract` | `@qodeca/xezar-contract` | The HTTP contract itself: every request and response as a zod schema with its TypeScript type inferred from it, so no shape is written twice. **Node-free on the same terms as the api-client** (`lib: ["ES2022"]`, `types: []` in its tsconfig make a `node:*` import a compile error). `private`, and that has a cost: the service imports a contract *value* (`workspaceUiStateSchema`, in `workspace/migrations.ts`), so a published tarball naming a package npm has never seen would fail on install. `packages/xezar/scripts/inline-contract.mjs` runs as `postbuild` to fold the contract into `dist/contract/` — bundle and declarations — and repoint the emitted references. Delete that script the day the contract is published, or the day nothing in the service imports a contract value. |
| `packages/api-client` | `@qodeca/xezar-api-client` | The contract between the two: the typed client over `AppType`, the SSE/protocol types, and the scope helpers. Re-exports `packages/contract` so a consumer needs one import. **Node-free by construction** — no `node:*`, no `@types/node` — because it is bundled into a browser and imported by the Node service. `private` for now: versioned with the release but not on npm. The service may therefore only import it in tests — a runtime import would make the published CLI depend on something npm cannot resolve. |
| `packages/web` | `@qodeca/xezar-web` | The cockpit SPA. Private; its output is an artifact of the service (`vite build` writes into `packages/xezar/web/dist`, which the CLI ships and serves). |

Rules that follow from that:

- **The CLI is not a separate package and should not become one.** It is the same program as the service — `packages/xezar/src/index.ts` boots `startServer`, but also `RunManager`, the workspace registry and the worktree machinery, and `xezar run` executes a workflow with no server at all.
- A dependency belongs to the workspace that imports it. The root carries only what spans all four (`typescript`, `vitest`, `@vitest/coverage-v8`, `tsx`). A build script counts as an importer: `packages/xezar/scripts/inline-contract.mjs` reaches for `esbuild`, so `esbuild` is a devDependency of `packages/xezar` rather than something inherited from whatever vite happens to hoist.
- Cross-package imports go through the package name, never a relative path — the exceptions are test-only reaches into `packages/xezar/src` — golden fixtures, the pure helper `runs/task-refs` a cockpit test re-checks, and the MCP `EventJournal`/`LeaderDelivery` classes `mcp-leader-control.owner-switch.test.tsx` drives — and they are ugly on purpose.
- The repo root keeps only what spans workspaces (see `scripts/`). One non-obvious entry: `scripts/test-local-state.mjs` is read by every vitest config, by `packages/xezar/vitest.setup.ts` and by both node:test gates, and on Node 22 for Windows it also makes `fs.rmSync` honour `maxRetries`. Everything else lives in the package that owns it.

## Task routing

| When the task involves… | Read first | Key rule |
| --- | --- | --- |
| CLI entry, `serve`/`run`/`init` subcommands, flags | `packages/xezar/src/index.ts` | Keep the CLI dependency-free and preserve its default and state-layout contracts; full rules: `packages/xezar/src/AGENTS.md`. |
| Agent runners / backends | `AGENT_PROTOCOL.md` (the contract), then `packages/xezar/src/core/agent-runner.ts`, `packages/xezar/src/core/runner-factory.ts`, `packages/xezar/src/core/read-only-lock.ts`, `packages/xezar/src/core/claude-cli-runner.ts`, `packages/xezar/src/core/codex-app-server-runner.ts`, `packages/xezar/src/core/qwen-runner.ts`, `packages/xezar/src/core/backend-detect.ts`, `packages/xezar/src/platform/process-launch.ts`, `packages/xezar/src/platform/process-tree.ts` | Implement every backend behind the shared runner protocol and preserve read-only and dry-run behavior; full rules: `packages/xezar/src/core/AGENTS.md`. |
| HTTP server & API routes | `packages/xezar/src/server/server.ts` | Keep the local-only default, middleware validation, chained route typing, and versioned API surface; full rules: `packages/xezar/src/server/AGENTS.md`. |
| API request/response shapes (any new field, route or payload) | `packages/contract/src/*.ts`, then `packages/xezar/src/server/validators.ts` | Define each boundary shape once in zod and infer its TypeScript type; full rules: `packages/contract/src/AGENTS.md`. |
| Real-time events (live UI signals, replacing polls) | `packages/xezar/src/server/ws.ts` + the `health` topic in `packages/xezar/src/server/server.ts`, and `packages/web/src/api/ws.ts` | Use the demand-driven shared subscription bus and preserve scoped lifetimes; full rules: `packages/xezar/src/server/AGENTS.md`. |
| Workspace registry / per-user state (`~/.xezar/`) | `packages/xezar/src/paths.ts`, then `packages/xezar/src/workspace/config.ts`, `packages/xezar/src/workspace/projects.ts`, `packages/xezar/src/workspace/migrations.ts`, `packages/xezar/src/workspace/semaphore.ts` | Resolve state paths centrally and preserve tolerant, atomic, backward-compatible storage; full rules: `packages/xezar/src/workspace/AGENTS.md`. |
| Project-scoped routes & contexts (`/api/v1/p/:projectId`, `/p/:projectId`) | `packages/xezar/src/server/project-context.ts`, then `packages/xezar/src/server/server.ts`, `packages/web/src/routes.tsx` | Keep project context identity and route scoping consistent across server and cockpit; full rules: `packages/xezar/src/server/AGENTS.md`. |
| Git / worktree logic | `packages/xezar/src/git-worktree.ts`, `packages/xezar/src/git-diff-base.ts`, `packages/xezar/src/server/git.ts` | Preserve isolation, explicit failure, and bounded Git behavior; full rules: `packages/xezar/src/AGENTS.md`. |
| GitHub integration (issues/PRs tab, draft PRs) | `packages/xezar/src/server/forge/github.ts` (the forge-driver seam; `server/github.ts` and `server/pr.ts` are thin re-export delegates) | Keep GitHub behind the forge-driver seam and degrade cleanly when unavailable; full rules: `packages/xezar/src/server/AGENTS.md`. |
| Workflows (YAML chains, steps, retries) | `packages/xezar/src/workflows/types.ts`, then `packages/xezar/src/workflows/load.ts`, `packages/xezar/src/workflows/run.ts` | Treat workflow YAML as validated user input and preserve step lifecycle semantics; full rules: `packages/xezar/src/workflows/AGENTS.md`. |
| Skills (Markdown playbooks, team repos) | `packages/xezar/src/skills.ts`, `packages/xezar/src/skills-remote.ts` | Keep skills discoverable, safely synchronized, and independent of required configuration; full rules: `packages/xezar/src/AGENTS.md`. |
| Runs store / state persistence | `packages/xezar/src/runs/store.ts`; for stopping what a run started, `packages/xezar/src/runs/run-process-sweeper.ts` | Preserve atomic persistence, append-only events, and old-record parsing; full rules: `packages/xezar/src/runs/AGENTS.md`; sweep rules: `packages/xezar/src/AGENTS.md` § Run process sweep. |
| Platform differences – paths, file replacement, program search, starting/stopping programs, `serve` shutdown | `packages/xezar/src/platform/` (`process-launch.ts`, `process-tree.ts`, `atomic-write.ts`, `path-identity.ts`, `shutdown-signals.ts`) | Never test `process.platform` at a call site or import `node:child_process` outside `platform/`; `process-spawn-scan.test.ts` fails on both (its `platform-test` rule: a comparison, `switch`, `.includes` or copy of `process.platform`; passing it as a helper's trailing default or argument is fine), `posix-literal-scan.test.ts` on a `.startsWith('/')` absolute test or a `/tmp` literal; full rules: `packages/xezar/src/AGENTS.md` § Platform layer. |
| Web UI (cockpit) | `packages/web/src/app.tsx`, then `packages/web/src/routes.tsx`, `packages/web/src/api/`, and the affected component/route | Keep one typed client boundary and the cockpit’s shared labels, routes, and recovery behavior; full rules: `packages/web/AGENTS.md`. |
| Design system and UI design (a new mockup in `designs/<feature>/`, any new or changed cockpit UI in `packages/web`, a UX/UI review) | `docs/design-system/README.md` (routes by task), then `foundations.md`, `components.md`, `patterns.md`, `writing.md`, `new-designs.md`, `known-gaps.md` | Follow the documented tokens, components, patterns, states, and design-review gate; full rules: `docs/design-system/AGENTS.md`. |
| Agent config files (Settings → Agent config; grouped by agent, MCP as a per-agent subsection — spec 2026-07-17-agent-config-by-agent, descriptor table in `packages/web/src/routes/settings/agent-descriptors.ts`) | `packages/xezar/src/agent-config/` (`catalog.ts`, `files.ts`, `validate.ts`, `service.ts`, `seed.ts`), then `packages/xezar/src/paths.ts` and the `/api/v1/agent-config` routes in `packages/xezar/src/server/server.ts` | Preserve byte-exact agent-owned files and keep writes local-only; full rules: `packages/xezar/src/agent-config/AGENTS.md`. |
| MCP server (`xezar mcp` bridge, the tools a project leader calls) | `docs/features/mcp-server/mcp-api.md` (generated tool reference), then `packages/xezar/src/mcp/tools/index.ts`, `packages/xezar/src/mcp/tool.ts` | Keep MCP tools registry-driven, documented from source, and leader-only in operation; full rules: `packages/xezar/src/mcp/AGENTS.md`. |
| Feature specs / design history | `docs/features/README.md` | Treat historical spec numbers as labels and current feature records according to their status; full rules: `docs/features/AGENTS.md`. |

## Validation

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way.

**The root `vitest.config.ts` caps worker fan-out at `min(4, availableParallelism() - 1)`, and that is a guarantee, not a tuning knob.** Without it, several concurrent gate runs starved each other (the full story is in the comment above `MAX_WORKERS` in `vitest.config.ts`); raising or deleting the cap re-creates that. It is a deliberate no-op on CI, so a green CI run is not evidence the cap works. Both runtime overrides still win for the unit gate when you genuinely need more: `npm test -- --maxWorkers=N`, and `VITEST_MAX_WORKERS`, which vitest applies at the very end of config resolution and therefore outranks every config file and `--no-file-parallelism` on the command line. **That last property makes `VITEST_MAX_WORKERS` unsafe to export globally**, and the browser suite defends itself from it: `packages/web/e2e/vitest.config.ts` deletes the variable before vitest reads it (#162). Those specs share one server, one machine and one set of on-disk fixtures — several rewrite state global to all of it — so running them concurrently is a correctness break, not a speed choice, and it produced four rounds of failures in files the change under test never touched. `packages/web/src/e2e-file-parallelism.test.ts` fails if that deletion stops working. Export the variable for `npm test` if you like; never assume it reaches `npm run test:e2e`. `npm run test:package` needs a completed `npm run build` (it packs the tarball).

Coverage and mutation detail lives in [docs/testing/coverage-gaps.md](docs/testing/coverage-gaps.md).

**Run vitest through npm, never `npx vitest`.** It is a devDependency of this repo, so `npm test`
uses the installed, version-pinned binary; `npx` will happily reach past it and fetch a different
version from the registry, which is a slow, networked, silently-different test run. To narrow a run,
pass vitest's own arguments after `--`:

```bash
npm test -- packages/web/src/routes/settings   # one directory
npm test -- --testTimeout=30000 path/to/one.test.ts
npm test -- -t "the name of one test"
```

Browser-suite execution and isolation detail lives in [docs/testing/agent-browser.md](docs/testing/agent-browser.md).

Bare `#n` means `qodeca/xezar`.

<!-- xezar-onboarding: start — added by the opinionated setup; edit freely, keep the markers -->
## Project leader and task pipeline

This repository is run by a project leader on the xezar engine. The process is in `SDLC.md`,
review rules in `CODE_REVIEW.md`, protected public surfaces in `BACKWARD_COMPATIBILITY.md`, and
the kit itself (workflows, checks, role skills, routing) in `.xezar/`.

- **Branches:** `develop` is the default and base branch – branch off it and open every feature PR
  against it. `main` holds released work and takes only `promote/*`, `release/v*` and `hotfix/*`
  PRs (`.github/workflows/pr-source-guard.yml` enforces it); the release path is in `SDLC.md` and
  `docs/publishing.md`.
- **The gate** is one command, run in the foreground: `bash .xezar/checks/repo-gates.sh`.
- **Changing a mechanism that already works** is the rule of that name above; it applies to the
  kit's own checks and workflows exactly as it applies to the product.
- **The leader** starts only through `scripts/xezar-leader.sh`, which sets `XEZAR_LEADER=1`. Any
  other session in this checkout is an ordinary session and gets no leader guide.
- **Get the skills.** The `xez-*` skills are installed per machine and never committed. From the
  repository root:

  ```bash
  DISABLE_TELEMETRY=1 npx -y skills add qodeca/xezar-skills --skill '*' --agent claude-code --agent codex --yes
  ```
<!-- xezar-onboarding: end -->
