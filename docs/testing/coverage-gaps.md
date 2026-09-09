# Test-coverage gap analysis

Date: 2026-09-09. Branch: `feature/coverage-gap-audit`. Commit audited: `e437c24`.

This document ranks xezar's regression risk by **behaviour**, not by file. Measured coverage
appears in section 4 as supporting evidence only – it never drives the ranking. A behaviour that
no gate protects outranks a behaviour that a suite covers but CI never runs, and both outrank a
file with a low percentage that nothing depends on.

**How to read the evidence.** Claims marked *measured* come from a command that was run or a test
file that was opened and read. Claims marked *inferred* are judgements about likelihood and blast
radius – second-guess those freely. Absence is scoped: "no test found for X in the suites
examined" means the five suites listed in section 3 were searched, not that X is untested in some
absolute sense.

---

## 1. Executive summary – the three biggest regression risks

### Risk 1 – the cockpit has 35 browser tests and CI runs none of them

*Measured.* `packages/web/e2e/` holds 35 `*.e2e.ts` specs covering the composer, the task thread,
the diff and files tabs, GitHub, settings, automations and the review gate.
`.github/workflows/ci.yml` runs `typecheck`, `test`, `test:unit`, `build`, `test:package` and a
`npm pack --dry-run` – `npm run test:e2e` appears nowhere in it. The job is even named "Unit,
build, E2E, and package", which reads as if it ran them.

Worse, adding the step naively would be green while testing nothing. `scripts/e2e.sh:32-33` prints
`TEST_E2E_STATUS=skipped` and **exits 0** when the agent-browser provider cannot be provisioned.
On a fresh `ubuntu-latest` runner with no browser cached, that is the likely path.

*Inferred.* The only thing standing between a cockpit rendering regression and `main` today is the
manual `needs-qa` / `qa-approved` gate in `SDLC.md:67-75`, plus the self-QA exception. That is a
human promise, not a gate.

### Risk 2 – `packages/contract` is not a vitest project, so a test written there would never run

*Measured.* `vitest.config.ts` lists exactly three projects: `packages/xezar`,
`packages/api-client`, `packages/web`. `packages/contract` is absent, has no `vitest.config.ts`,
has no `test` script in its manifest, and contains zero `*.test.ts` files.

This is the schema package every HTTP route, the typed client and the cockpit depend on. Its 97.6 %
line coverage in section 4 is *incidental* – the schemas are imported and executed by tests living
in other packages. Nothing there asserts a contract schema's behaviour on purpose, and the guard
that would normally catch that (a co-located test) cannot exist, because the runner would not pick
it up.

*Inferred.* This is the most invisible failure shape in the repository: a future contributor adds
`packages/contract/src/runs.test.ts`, sees no failure, and believes the surface is pinned.

### Risk 3 – the CLI's first-run and boot paths have no test at any level

*Measured.* `packages/xezar/src/index.ts` is **absent from the coverage report entirely** – no
vitest test loads it. The node:test suites reach it only by spawning the binary:
`test/unit/cli-version.test.ts` covers `--version` and `--help`; `test/e2e/package-cli.test.ts`
spawns `run`, `projects`, `server-install` and `server-uninstall` against the installed tarball.
No test found for `xezar init`, for the default `serve` command, for `server-deploy`, or for the
unknown-command exit path, in the suites examined.

`BACKWARD_COMPATIBILITY.md:9-19` names all of these as protected surfaces, including the default
port, the default workflow, and `run`'s exit-code semantics. `init` is what a new user types first,
and `serve` is what every other user types every day.

---

## 2. What "the suites" means

| Suite | Command | Runner | Runs in CI? | Size (measured) |
|---|---|---|---|---|
| Server unit | `npm test` (project `server`) | vitest, node env | yes | 184 `*.test.ts` under `packages/xezar/src` |
| Cockpit unit | `npm test` (project `web`) | vitest, jsdom | yes | 151 `*.test.ts(x)` under `packages/web/src` |
| Api-client unit | `npm test` (project `api-client`) | vitest, node env | yes | 2 files |
| Contract unit | – | – | **no project exists** | 0 files |
| node:test core | `npm run test:unit` | node:test | yes | 10 files, `packages/xezar/test/unit/` |
| Packaged CLI e2e | `npm run test:package` | node:test | yes | 4 files, `packages/xezar/test/e2e/` |
| Browser e2e | `npm run test:e2e` | vitest + agent-browser + real Chrome | **no** | 35 files, `packages/web/e2e/` |
| Manual QA | `needs-qa` label | human | n/a | `SDLC.md:67-75` |

One structural note that changes how the tables below read: the six `contract-parity*.test.ts`
files and `typed-bodies.test.ts` are **compile-time checks**, not runtime tests. Each contains a
single `it()` whose only job is to keep the file visible; the real assertion is a conditional type
resolved by `npm run typecheck`. They prove a declared response *shape* matches the contract
package. They never call a handler, so they are not evidence that a route behaves correctly.

---

## 3. Behaviour inventory

Derived from the `AGENTS.md` task-routing table, the 30 chained route families in
`packages/xezar/src/server/server.ts`, the cockpit routes in `packages/web/src/routes.tsx`, the CLI
dispatch in `packages/xezar/src/index.ts:129-178`, and the run lifecycle in
`packages/xezar/src/workflows/run.ts`.

Status key: **C** covered, **P** partially covered, **N** no test found in the suites examined,
**X** not testable here (with reason).

### 3.1 CLI journeys (`packages/xezar/src/index.ts`)

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| `--version` / `-v` prints bare version, works outside a git repo | node:test | `test/unit/cli-version.test.ts:36,45,62` | C |
| `--help` lists commands and flags | node:test | `test/unit/cli-version.test.ts:68` | C |
| `run "<task>"` executes a workflow headless, exits 0 on `done` and `review` | packaged e2e | `test/e2e/package-cli.test.ts:82` | C |
| `run` refuses a disabled or unauthenticated provider | packaged e2e | `test/e2e/package-cli.test.ts:108,148` | C |
| `projects list/add/remove/tag` | packaged e2e + server unit | `test/e2e/package-cli.test.ts:180`; `src/workspace/projects-cli.test.ts:16,234` | C |
| `server-install` (platforms, flags, unknown platform) | packaged e2e | `test/e2e/package-cli.test.ts:199,225,230,242` | C |
| `server-uninstall` | packaged e2e | `test/e2e/package-cli.test.ts:213` | C |
| **`init` scaffolds `.xezar/` and never overwrites** | none | no test found in the suites examined; `initCommand` is referenced only at `src/index.ts:616` | **N** |
| **`serve` boots: port auto-pick, `--repo`, `--bind-host`, `--no-open`, orphan-worktree prune, `.local/.gitignore` upkeep** | none | no CLI-level test found; server internals are tested separately | **N** |
| **`server-deploy`** | none | no invocation found in `package-cli.test.ts` or elsewhere | **N** |
| **unknown command → exit 1 + help** | none | `src/index.ts:174-178` not exercised by any spawn found | **N** |
| npm package surface: bins, `exports`, tarball contents | packaged e2e + build | `test/e2e/package-exports.test.ts`; `scripts/check-pack.mjs` via `npm run build` | C |

### 3.2 HTTP API – 30 route families (`packages/xezar/src/server/server.ts`)

| Family (line) | Suite | Strongest evidence | Status |
|---|---|---|---|
| health (1570) | server unit | `health-forge.test.ts:96`, `health-topic.test.ts:212` | C |
| models (1639) | server unit | `models-api.test.ts:67,102` | C |
| providers (1712) | server unit | `providers-api.test.ts:192,306` | C |
| agent-profiles (1958) | server unit | `agent-profiles-api.test.ts:130,243` | C |
| projects (2336) | server unit | `projects-api.test.ts:250`, `checkout.test.ts:294` | C |
| workspace skills-update (2738) | server unit | `skills-update-api.test.ts:62,125` | C |
| workspace config / ui-state (2828) | server unit | `workspace-api.test.ts:128` | C |
| fs/browse (2983) | server unit | `fs-browse.test.ts:145` (symlink escape) | C |
| **launch-key (3004)** | server unit (structural only) | only the generic GET loop in `route-parity.test.ts:206`; no assertion on the returned key found | **P** |
| **skills catalog (3008): `GET /skills`, `/skills/importable`, `POST /skills/refresh`** | server unit (structural only) | the two GETs are hit by `route-parity.test.ts:206`; no test found invoking `POST /skills/refresh` | **P** |
| ui-state (3051) | server unit | `ui-state.test.ts:48`, `ui-state-api.test.ts:69` | C |
| workflows (3077) | server unit | `project-kit-api.test.ts:19`, `request-validation.test.ts:114` | C |
| **plan (3164)** | server unit (rejection paths only) | `provider-action-gating.test.ts:167`, `request-validation.test.ts:85`; no test found for a successful response body | **P** |
| automations (3220) + automation-checks (3437) | server unit | `automations-api.test.ts:87`, `automations-gate.test.ts:91` | C |
| runs (3475) – ~28 sub-routes | server unit | `start-run.test.ts`, `patch-run.test.ts`, `continue-run.test.ts`, `queued-messages.test.ts`, `git-changes.test.ts:902`, `open-in-file.test.ts:73`, `start-run-todo.test.ts:126` | C |
| groups (4281) | server unit | `group-pick.test.ts:92` | C |
| **open-targets (4366)** | server unit (`POST /open-in` only) | `open-in-project.test.ts:59,69`; `GET /open-targets` only structurally hit | **P** |
| worktrees (4445) | server unit | `worktrees-api.test.ts:121` | C |
| todos (4503) | server unit | `todos-start.test.ts:97,124` | C |
| SSE (4583) | server unit | `sse-headers.test.ts:42`, `route-parity.test.ts:281` | C |
| workspace events (4717) | server unit | `workspace-events.test.ts:125,401` | C |
| github (4845) | server unit | six `github-*-api.test.ts` files, one describe each | C |
| repo (5014) | server unit | `git-changes.test.ts:924,993` | C |
| config (5135) | server unit | `config-api.test.ts:167,223` | C |
| agent-config (5259) | server unit | `agent-config-api.test.ts:73,92` | C |
| workspace runs-index (5425) | server unit | `runs-index-api.test.ts:85,101` | C |
| origin/host guard (middleware, 1261-1329) | server unit | `origin-guard.test.ts:67,74,88,95`, `host-guard.test.ts:61,79` | C |
| WebSocket bus `/api/v1/ws` | server unit | `ws.test.ts:108-266` (hub), `:312,354` (upgrade guard) | C |
| Route registration and alias parity | server unit | `route-parity.test.ts:158,206,215`; `versioned-surface.test.ts:93,108`; `bc-route-inventory.test.ts:119` | C |
| Contract ↔ route shape agreement | typecheck | `contract-parity*.test.ts`, `typed-bodies.test.ts` – compile-time only | C (types), N (behaviour) |

### 3.3 Cockpit journeys (`packages/web/src/routes.tsx`)

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| Tasks overview, sidebar order | cockpit unit + browser e2e | `routes/tasks-overview.test.tsx:126` | C |
| New task: compose, pick skill/workflow, submit | cockpit unit + browser e2e | `routes/new-task.test.tsx:402`; `e2e/new-task.e2e.ts:236` | C |
| Task thread rendering, markdown, scroll | cockpit unit + browser e2e | `routes/task-thread/task-thread.test.tsx:138`; `e2e/task-thread.e2e.ts:128` | C |
| Changes tab (tree, per-file ±) | cockpit unit + browser e2e | `routes/task-git/task-changes.test.tsx:154` | C |
| Files tab | cockpit unit + browser e2e | `routes/task-git/task-files.test.tsx:119` | C |
| **Commits tab (`/tasks/:id/commits[/:sha]`)** | browser e2e only | `e2e/commit-list.e2e.ts:166,174` exercises `CommitList` virtualization; `task-commits.tsx` is **absent from the coverage report** | **P** |
| Variant compare and pick | cockpit unit + browser e2e | `routes/compare-variants.test.tsx:121`; `e2e/variants-compare.e2e.ts:193` | C |
| Repo git tabs (diff, commits, branches) | cockpit unit + browser e2e | `routes/repo-git/repo-git.test.tsx:150`; `e2e/repo-git.e2e.ts:54` | C |
| GitHub issues and PRs | cockpit unit + browser e2e | `routes/github/github.test.tsx:302`; `e2e/github.e2e.ts:78` | C |
| **Automations (create, preview, enable, log)** | disabled state only in unit; enabled state only in a browser e2e gated on `XEZ_AUTOMATIONS=1` | `routes.test.tsx:355-374`; `e2e/automations.e2e.ts:54-58` | **P** |
| Skills catalog page | cockpit unit + browser e2e | `routes/skills.test.tsx:151`; `e2e/settings-skills.e2e.ts:66` | C |
| Inbox | cockpit unit + browser e2e | `routes/inbox.test.tsx:224`; `e2e/inbox.e2e.ts:96` | C |
| Workflows builder | cockpit unit + browser e2e | `routes/workflows/workflows.test.tsx:118`; `e2e/workflows.e2e.ts:89` | C |
| Settings, project and global scopes | cockpit unit + browser e2e | `routes/settings/settings.test.tsx:164,271` | C |
| Project scope, `/p/default` alias, legacy redirects, 404 | cockpit unit | `routes.test.tsx:271,636-731` | C |
| Bookmarklet grammar, launch key never in the DOM | cockpit unit | `routes.test.tsx:763-767` | C |
| SSE cache patching, multi-project scoping, reconnect | cockpit unit | `api/global-events.test.tsx:252,373,652,724,746` | C |
| WebSocket topic bus, ref-counting, watchdog | cockpit unit | `api/ws.test.ts:92,106,188,236` | C |
| Design-system rules (no raw hex, no `dark:`, no `100vh`) | cockpit unit | `design-guardian.test.ts` | C |
| Bundle chunking config | cockpit unit | `vite-config.test.ts` | C |
| **App shell boot (`app.tsx`, `main.tsx`)** | none | both files **absent from the coverage report** – no unit test loads them | **N** |

### 3.4 Run and workflow lifecycle

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| queued → running under the workspace cap | server unit | `workflows/run-lease.test.ts:180`, `workspace-semaphore.test.ts:134` | C |
| running → review (gate on, non-autonomous, changes) | server unit | `workflows/run.test.ts:710` | C |
| running → done (gate off, or no changes) | server unit | `workflows/run.test.ts:704,724` | C |
| worktree creation fails → run marked `failed` before any step | server unit | `workflows/run-isolation.test.ts:55-69` | C |
| `XEZ:MONITORING` parks the run; wake timer and operator wake | server unit | `workflows/run.test.ts:909-955,1005`; `runs/store.test.ts:179,195` | C |
| `runContinuation` keeps step tools (the second `ActiveRun` site) | server unit | `workflows/continuation-tools.test.ts:50` | C |
| `maxParallel` across projects, and `refresh()` raising it | server unit | `workspace-semaphore.test.ts:134,264,475` | C |
| Message delivery into a live run | server unit (indirect) | `workflows/run.test.ts:1052,1978`; no direct unit test of `deliverMessage` by name | C |
| **Autonomous nudge actually delivered at turn end** | none | `recover-autonomous.test.ts:26-84` covers the recovered flag; no test found asserting `AUTONOMOUS_NUDGE` delivery, unlike its twin `MONITORING_WAKE_NUDGE` at `run.test.ts:1005-1021` | **N** |
| Legacy `runs.json` shapes still parse (`claude-cli`, absent optional fields) | server unit | `runs/store.test.ts:1754-1821` | C |
| NDJSON history paging and live cursor replay | server unit | `runs/event-history.test.ts:69,200` | C |
| Task-diff anchoring (`resolveTaskDiffBase`) | server unit | `src/git-diff-base.test.ts` | C |

### 3.5 Agent runners and the protocol

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| Every backend emits every parity capability | server unit | `core/ui-parity.test.ts`, `BACKENDS = ['claude','codex','opencode','pi']` | C |
| Golden-fixture mapping per backend | server unit | `core/__fixtures__/{claude,codex,opencode,pi}/*.expected.json` replayed by the four `*-ui-mapper.test.ts` | C |
| api-client protocol mirror stays type-exact | server unit | `server/api-types.test.ts` | C |
| Claude runner teardown | server unit | `claude-cli-runner.test.ts:92` (stub script that ignores EOF) | C |
| Codex runner against a mock app-server | server unit | `codex-app-server-runner.test.ts:31` + `mock-codex-app-server.mjs` | C |
| **OpenCode runner teardown** | server unit, but through `vi.mock('node:child_process')` rather than the `mock-opencode-serve.mjs` its sibling backend uses | `opencode-server-runner.test.ts:9`; measured 85.6 % lines / 63.5 % branches | **P** |
| **`createRunner` dispatch for claude / codex / opencode** | server unit (pi branch only) | `pi-runner.test.ts:20-27`; measured 80 % lines / 83 % branches | **P** |
| **`detectEnvironment` probes for claude / codex / opencode / gh / git** | server unit (pi entry only) | `pi-runner.test.ts:28-46`; measured 73.8 % lines / 72.2 % branches | **P** |

### 3.6 Directory sweep – nothing silently absent

Every top-level source directory in both large workspaces, with its measured coverage and where it
appears above.

| Directory | Lines | Branches | Covered in inventory |
|---|---|---|---|
| `packages/xezar/src/` (loose files) | 80.3 % | 67.9 % | 3.1, 3.4, and gaps R8, R19 |
| `packages/xezar/src/agent-config/` | 97.2 % | 88.2 % | 3.2 (agent-config family) |
| `packages/xezar/src/automations/` | 93.1 % | 75.1 % | 3.2 (automations family) |
| `packages/xezar/src/core/` | 93.1 % | 81.8 % | 3.5 |
| `packages/xezar/src/release/` | 95.5 % | 90.9 % | 3.1 (npm package surface) + `test/e2e/release.test.ts` |
| `packages/xezar/src/runs/` | 96.1 % | 88.6 % | 3.4 |
| `packages/xezar/src/server/` | 85.3 % | 74.4 % | 3.2 |
| `packages/xezar/src/server-install/` | 72.5 % | 57.8 % | 3.1, gap R17 |
| `packages/xezar/src/workflows/` | 90.6 % | 81.1 % | 3.4, gap R7 |
| `packages/xezar/src/workspace/` | 97.9 % | 95.3 % | 3.2 (projects, workspace config) |
| `packages/web/src/api/` | 94.2 % | 82.0 % | 3.3 (live updates) |
| `packages/web/src/components/` | 95.7 % | 87.2 % | 3.3 |
| `packages/web/src/lib/` | 97.7 % | 96.0 % | 3.3 |
| `packages/web/src/routes/` | 89.5 % | 83.2 % | 3.3 |
| `packages/web/src/assets/` | – | – | **Excluded**: static image assets, no executable code |
| `packages/web/src/styles/` | – | – | **Excluded**: one CSS file, no executable code |
| `packages/contract/src/` | 97.6 % | 75.0 % | Risk 2, gap R2 |
| `packages/api-client/src/` | 100 % | 95.8 % | 3.2, 3.5 (protocol mirror) |

---

## 4. Measured coverage – evidence, not ranking

Command: `npm run test:coverage` (added by this change). Provider `v8`, reporters `text` and
`json-summary`, output under `.local/coverage/` per `docs/testing/local-data.md:75`. Exit code 0.

**Scope limit, and it matters.** The run measures only what `npm test` executes – the three vitest
projects. It does **not** measure `npm run test:unit` (node:test), `npm run test:package`
(packaged CLI) or `npm run test:e2e` (browser). A file the packaged-CLI suite exercises still reads
as 0 % here, and a file no suite touches also reads as 0 %. The report cannot tell those two apart,
which is exactly why the ranking in section 5 is behaviour-led.

| Workspace | Files in report | Line coverage | Branch coverage | Source files never loaded |
|---|---|---|---|---|
| `packages/contract` | 13 | **97.6 %** | 75.0 % | 0 of 13 |
| `packages/api-client` | 5 | **100 %** | 95.8 % | 0 of 5 |
| `packages/xezar` | 129 | **88.3 %** | 77.6 % | 6 of 127 |
| `packages/web` | 206 | **92.7 %** | 85.8 % | 8 of 214 |
| **All** | 353 | **90.3 %** | **81.3 %** | 14 |

### Where high line coverage coexists with an untested behaviour

- `packages/contract` measures 97.6 % lines and has **zero tests of its own** and no vitest project
  at all. Every executed line was executed by a test in another package.
- `packages/xezar/src/agent-config/model-settings/{claude,codex,opencode,pi}.ts` each measure
  **100 % lines and 100 % branches** with **zero co-located test files**. Their coverage is a side
  effect of the agent-config API tests.
- `packages/xezar/src/ui-state.ts` measures 100 % / 100 % with no co-located test.
- `packages/xezar/src/core/agent-runner.ts` measures 100 % – it is the type seam, so this number
  says nothing about runner correctness.
- `packages/xezar/src/server/launch-key.ts` measures 100 % lines while the `GET /launch-key` route
  it backs has no behavioural assertion found.

### Where the opposite is true – low coverage, well-guarded behaviour

- `packages/xezar/src/index.ts` is **absent from the report entirely**, yet `run`, `projects`,
  `server-install`, `server-uninstall`, `--help` and `--version` are all exercised by the node:test
  suites that CI does run. Its 0 % is a measurement artefact for those paths – but `init`, `serve`
  and `server-deploy` really are unguarded.
- `packages/xezar/src/planner.ts` measures 37.5 % lines here while
  `test/unit/planner.test.ts` covers two of its functions in a suite this run does not see.
- `packages/xezar/src/server-install/*` measure 55-72 % here; parts of the install path are
  exercised by `test/e2e/package-cli.test.ts` instead.

### Lowest-covered files (measured, for orientation only)

| File | Lines | Branches |
|---|---|---|
| `packages/web/src/routes/automations/automations.tsx` | 23.9 % | 9.9 % |
| `packages/web/src/routes/task-git/git-tab-loading.tsx` | 33.3 % | 16.7 % |
| `packages/xezar/src/planner.ts` | 37.5 % | 20.0 % |
| `packages/xezar/src/server/git.ts` | 47.7 % | 27.6 % |
| `packages/xezar/src/server/open-in-terminal.ts` | 47.9 % | 40.9 % |
| `packages/xezar/src/server-install/steps.ts` | 55.9 % | 50.0 % |
| `packages/xezar/src/server-install/ui.ts` | 58.7 % | 63.6 % |
| `packages/xezar/src/server/checkout.ts` | 63.0 % | 74.2 % |
| `packages/xezar/src/skills-remote.ts` | 63.1 % | 41.8 % |
| `packages/xezar/src/handoff.ts` | 65.8 % | 36.4 % |
| `packages/xezar/src/workflows/load.ts` | 83.3 % | **40.0 %** |

Files absent from the report entirely: `packages/xezar/src/index.ts`,
`packages/xezar/src/update-check.ts`, `packages/xezar/src/core/ui-events.ts`,
`packages/xezar/src/server/app-type.ts`, `packages/xezar/src/server/forge/types.ts`,
`packages/xezar/src/agent-config/model-settings/types.ts`, `packages/web/src/app.tsx`,
`packages/web/src/main.tsx`, `packages/web/src/routes/task-git/task-commits.tsx`,
`packages/web/src/components/diff/types.ts`, and four `components/ui/*` primitives. The `types.ts`
and `app-type.ts` entries are type-only modules and are **excluded** as not testable.

---

## 5. Ranked gap list

Ranked by regression risk – likelihood a change breaks it, how bad that is for a user, and how
invisible the breakage would be to the current gates. Each row maps to exactly one child issue of
epic #42, and every child issue maps back to exactly one row.

| # | Gap | Why it ranks here | Evidence | Issue |
|---|---|---|---|---|
| R1 | Browser e2e suite never runs in CI, and its skip path exits 0 | 35 specs, zero gate coverage; a naive CI addition is green while testing nothing | `ci.yml` has no `test:e2e`; `scripts/e2e.sh:32-33` | #60 |
| R2 | `packages/contract` has no vitest project and no tests | A test written there silently never runs; the package every route depends on | `vitest.config.ts` lists three projects | #61 |
| R3 | `xezar init` has no test at any level | First command a new user runs; BC §1 protected; must never overwrite | no test found; `src/index.ts:616` | #62 |
| R4 | `xezar serve` boot path has no CLI-level test | Default command; port auto-pick, orphan prune and `.local/.gitignore` upkeep all unguarded | `src/index.ts` absent from coverage | #43 |
| R5 | `server/git.ts` at 27.6 % branches | Repo detection feeds worktrees, diffs and project registration; failures are silent and wrong, not loud | measured | #44 |
| R6 | `backend-detect.ts` probes only asserted for `pi` | Graceful degradation when a CLI is absent is a zero-config promise | `pi-runner.test.ts:28-46`; 72.2 % branches | #45 |
| R7 | `workflows/load.ts` at 40 % branches | Users commit workflow YAML; per-file degradation ("skipped") is a BC §4 break when it misfires | measured | #46 |
| R8 | `handoff.ts` at 36.4 % branches | Parses `XEZ:DONE` / `XEZ:MONITORING`; a miss leaves a run parked with no exit | measured; BC §8 | #47 |
| R9 | Automations cockpit route at 9.9 % branches, enabled path only in a gated e2e | Double-blind: the covering spec needs `XEZ_AUTOMATIONS=1` **and** CI never runs e2e | `e2e/automations.e2e.ts:54-58` | #48 |
| R10 | Commits tab route has no cockpit unit test | `task-commits.tsx` absent from coverage; only its child component is e2e-tested | measured | #49 |
| R11 | `app.tsx` and `main.tsx` never loaded by a unit test | The cockpit boot shell – providers, router, error boundary | measured | #50 |
| R12 | `POST /skills/refresh` and the skills catalog GETs | Team-skill refresh is network-facing; only the generic parity loop touches the GETs | no test found | #51 |
| R13 | `POST /plan` success path | Only rejection paths asserted; the planner response shape is type-checked, not exercised | no test found | #52 |
| R14 | `GET /launch-key` has no behavioural assertion | Bookmarklet secret; a wrong value breaks every saved bookmarklet quietly | no test found | #53 |
| R15 | `createRunner` dispatch only asserted for `pi` | A mis-wired backend id would surface as "the wrong agent ran" | `pi-runner.test.ts:20-27` | #54 |
| R16 | OpenCode runner teardown bypasses its golden mock server | Backend asymmetry: codex uses the mock server, opencode uses `vi.mock` | `opencode-server-runner.test.ts:9` | #55 |
| R17 | `server-install` steps/ui/platforms at 50-63 % branches, `server-deploy` untested | Remote-host install and redeploy; failures land on someone else's VPS | measured; no `server-deploy` test found | #56 |
| R18 | `skills-remote.ts` at 41.8 % branches | Network-facing team-skill fetch and cache; must never block boot | measured | #57 |
| R19 | `planner.ts` at 20 % branches, `update-check.ts` absent from coverage | Two loose top-level modules with weak or no guards | measured | #58 |
| R20 | Autonomous nudge delivery has no direct test | The mirrored monitoring wake is asserted; this half is not – exactly the asymmetry `AGENTS.md` warns about | `run.test.ts:1005-1021` vs no equivalent | #59 |

---

## 6. Gate structure, not just missing tests

**Covered by a suite CI never executes.** The whole browser e2e layer – 35 specs. Every cockpit
journey in section 3.3 whose only evidence is an `e2e/*.e2e.ts` file is, from CI's point of view,
unguarded. The two clearest cases are the commits tab (R10) and the enabled automations flow (R9).

**Covered only by manual QA.** `SDLC.md:93` states plainly that user-facing changes need the
separate real-browser QA, and `CODE_REVIEW.md:3` repeats that `test:e2e` is "the QA layer", not part
of the review gate. `SDLC.md:75` allows a self-QA exception with attached evidence. So the last line
of defence for cockpit rendering is a human running a browser and writing down what they saw.

**Covered by typecheck, not by `npm test`.** The six `contract-parity*.test.ts` files and
`typed-bodies.test.ts`. These are real gates – `npm run typecheck` runs first in CI – but they are
type gates. Reading them as behavioural coverage overstates the runtime picture for every route
they annotate.

**Declared protected, no enforcing test named.** `BACKWARD_COMPATIBILITY.md` has nine numbered
surfaces. Three name an enforcing test (§2 HTTP API, §6 npm package, §7 agent protocol) and those
tests all exist on disk. Six do not: §1 CLI, §3 state files, §4 workflow YAML, §5 skills Markdown,
§8 marker vocabulary, §9 per-user workspace files. Two of those turn out to be well covered anyway
once you look – `runs/store.test.ts:1754-1821` pins the legacy `claude-cli` fold for §3, and
`runs/task-markers.test.ts` plus `handoff.test.ts` cover §8, though the latter only to 36.4 %
branches. §1 is genuinely thin, and that is gaps R3, R4 and R17.

**A blind spot the drift guard itself declares.** `bc-route-inventory.test.ts:37-41` records that it
cannot see `/api/v1/ws`, because the WebSocket upgrade is not a Hono route. That entry is maintained
by hand in `BACKWARD_COMPATIBILITY.md` §2 and nothing can catch it drifting.

---

## 7. Findings outside the epic

These were uncovered by the audit and are deliberately **not** child issues.

1. **CI job name is misleading.** `.github/workflows/ci.yml` names the job "Unit, build, E2E, and
   package"; it runs no E2E. Cosmetic, but it is why the gap survives – the name reads as coverage.
   Fixing it means editing `.github/workflows/`, which is out of scope here. Folded into issue 1.
2. **`docs/testing/local-data.md:75` is now stale.** It says "No coverage or Playwright report
   producer is currently configured". This change adds one. The line also sets the rule this change
   follows: reporters write beneath `.local`, not a root report directory. Editing the doc was out
   of the PR's declared scope, so it is recorded here instead.
3. **`.gitignore` already carries a root `coverage/` rule** that predates this change and now
   points at nothing, because the script writes to `.local/coverage/`. Harmless; noted so nobody
   re-adds a root reporter on the strength of it.
4. **No repository document contained an instruction addressed to the agent reading it.** The audit
   looked. Every "must"/"never" found in `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`,
   `BACKWARD_COMPATIBILITY.md` and `AGENT_PROTOCOL.md` is engineering policy about the codebase, not
   a directive aimed at an agent.
5. **No bug was found that warranted a separate bug issue.** Every gap above is a missing test, not
   broken behaviour.

## 8. Labels created for this work

Three labels were created because no existing label fitted: `epic` (a tracking issue with
sub-issues), `testing` (test-coverage work) and `priority-high`, which `SDLC.md:47-52` defines but
the repository did not have. Child issues also carry the existing `enhancement` label.

The epic is #42. Its twenty children are attached as native GitHub sub-issues through
`POST /repos/qodeca/xezar/issues/42/sub_issues`, so `gh issue view 42` shows them with a `0/20`
progress indicator. No fallback was needed.

## 9. Method and limits

- Coverage: one `npm run test:coverage` run, exit 0, on `feature/coverage-gap-audit` at `e437c24`.
- Test claims: every test cited was opened and read, or located by grep and then opened. Filenames
  alone were never treated as evidence of coverage.
- **Git history is not usable as regression evidence in this checkout.** `git log` holds 39 commits,
  all dated 2026-09-07 to 2026-09-09, beginning with `1f729a7 chore: import cezar upstream
  baseline`. `git log --grep=fix -i` returns 13 commits; `--grep=regress -i` returns none. The
  incident numbers cited throughout `AGENTS.md` (#810, #811, #661, #591, #751, #694, #426, #430,
  #472) do not resolve against `qodeca/xezar`; they resolve against the predecessor repository
  `open-mercato/cezar`. The incidents are real and closed there – they were used as prose evidence
  for the ranking, not as commits in this repository.
- The thirteen `fix` commits that do exist cluster into three themes: test-gate and worktree
  isolation (3), release and CI mechanics (3), and cockpit behaviour (3). Two of those three themes
  are about the test infrastructure itself, which is consistent with the gaps ranked above.
