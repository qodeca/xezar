# Test-coverage gap analysis

Date: 2026-09-09, measurements refreshed 2026-09-10. Branch: `feature/coverage-gap-audit`, then
`feature/coverage-16-files`. Commit originally audited: `e437c24`.

This document ranks xezar's regression risk by **behaviour**, not by file. Measured coverage
appears in section 4 as supporting evidence only – it never drives the ranking. A behaviour that
no gate protects outranks a behaviour that a suite covers but CI never runs, and both outrank a
file with a low percentage that nothing depends on.

**How to read the evidence.** Claims marked *measured* come from a command that was run or a test
file that was opened and read. Claims marked *inferred* are judgements about likelihood and blast
radius – second-guess those freely. Absence is scoped: "no test found for X in the suites
examined" means the seven suites listed in section 2 were searched, not that X is untested in some
absolute sense.

---

## 1. Executive summary – the three biggest regression risks

### Risk 1 – ~~the cockpit has 35 browser tests and CI runs none of them~~ — **CLOSED (#60)**

*Was:* `packages/web/e2e/` held 35 `*.e2e.ts` specs covering the composer, the task thread, the
diff and files tabs, GitHub, settings, automations and the review gate, and `npm run test:e2e`
appeared nowhere in `.github/workflows/ci.yml`. Worse, adding the step naively would have been
green while testing nothing: `scripts/e2e.sh` prints `TEST_E2E_STATUS=skipped` and **exits 0** when
the agent-browser provider cannot be provisioned, which is the likely path on a fresh
`ubuntu-latest` runner with no browser cached.

*Now:* #128 added a separate `ui-e2e` job to `ci.yml` — its own runner, its own browser cache and a
30-minute ceiling, running beside `verify` so CI's added wall clock is the slower of the two rather
than the sum. The step asserts on the marker instead of the exit code: it passes only on a literal
`TEST_E2E_STATUS=passed` line, and **both** `skipped` and `failed` fail the job, each with an
annotation naming which. The app and build logs upload as an artifact, so a spec failure stays
distinguishable from an environment failure after the runner is gone.

Kept here rather than deleted so the failure shape stays findable: **a suite whose skip path exits
0 must be gated on its own success marker, never on its exit code.**

### Risk 2 – ~~`packages/contract` is not a vitest project~~ — **CLOSED (#120)**

*Was:* `vitest.config.ts` listed three projects and `packages/contract` was absent, so a test
written there would silently never run — the most invisible failure shape in the repository, because
a contributor adds `packages/contract/src/runs.test.ts`, sees no failure, and believes the surface is
pinned.

*Now:* the root config lists **four** projects including `./packages/contract/vitest.config.ts`, and
the package carries `src/events.test.ts` and `src/runs.test.ts`. The config also gained the
counter-comment that keeps it closed: "A package missing from this list is a package whose
`*.test.ts` files never run, however right they look (#61 — `contract` was in exactly that state)."

Kept here rather than deleted so the failure shape stays findable: **a new workspace package needs a
line in the root `projects` list, or its tests are decoration.**

### Risk 3 – ~~the CLI's first-run and boot paths have no test at any level~~ — **CLOSED (#43, #62)**

*Was measured, and is still true as a measurement:* `packages/xezar/src/index.ts` is **absent from
the coverage report entirely** – no vitest test loads it. The node:test suites reach it only by
spawning the binary, which the coverage report cannot see. That much has not changed.

*What changed:* the two commands the risk was really about now have tests.
`test/e2e/package-cli.test.ts:433-495` boots the default `serve` command against the installed
tarball and asserts the three behaviours this section named — port fallback when the requested one
is taken, orphan-worktree prune, and `.local/.gitignore` upkeep (#43). `project-kit-cli.test.ts`
spawns `init` and covers both the scaffold and the never-overwrite half (#62). Alongside them,
`test/unit/cli-version.test.ts` covers `--version` and `--help`, and `package-cli.test.ts` spawns
`run`, `projects`, `server-install`, `server-uninstall` and `server-deploy`.

Still no test found in the suites examined for the **unknown-command exit path**.

Kept here rather than deleted because the measurement lesson survives the fix: a file at 0 % that
CI exercises through a subprocess looks identical, in this report, to a file nothing tests at all.

`BACKWARD_COMPATIBILITY.md:9-19` names all of these as protected surfaces, including the default
port, the default workflow, and `run`'s exit-code semantics. `init` is what a new user types first,
and `serve` is what every other user types every day.

---

## 2. What "the suites" means

| Suite | Command | Runner | Runs in CI? | Size (measured) |
|---|---|---|---|---|
| Server unit | `npm test` (project `server`) | vitest, node env | yes | 200 `*.test.ts` under `packages/xezar/src` |
| Cockpit unit | `npm test` (project `web`) | vitest, jsdom | yes | 162 `*.test.ts(x)` under `packages/web/src` |
| Api-client unit | `npm test` (project `api-client`) | vitest, node env | yes | 2 files |
| Contract unit | `npm test` (project `contract`) | vitest, node env | yes | 2 files |
| node:test core | `npm run test:unit` | node:test | yes | 10 files, `packages/xezar/test/unit/` |
| Packaged CLI e2e | `npm run test:package` | node:test | yes | 4 files, `packages/xezar/test/e2e/` |
| Browser e2e | `npm run test:e2e` | vitest + agent-browser + real Chrome | yes – its own `ui-e2e` job (#128) | 35 files, `packages/web/e2e/` |
| Manual QA | `needs-qa` label | human | n/a | `SDLC.md:67-75` |

One structural note that changes how the tables below read: the six `contract-parity*.test.ts`
files and `typed-bodies.test.ts` are **compile-time checks**, not runtime tests. Each contains a
single `it()` whose only job is to keep the file visible; the real assertion is a conditional type
resolved by `npm run typecheck`. They prove a declared response *shape* matches the contract
package. They never call a handler, so they are not evidence that a route behaves correctly.

---

## 3. Behaviour inventory

Derived from the `AGENTS.md` task-routing table, the 27 chained route families in
`packages/xezar/src/server/server.ts`, the cockpit routes in `packages/web/src/routes.tsx`, the CLI
dispatch in `packages/xezar/src/index.ts:130-179`, and the run lifecycle in
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
| `init` scaffolds `.xezar/` and never overwrites | server unit | `project-kit-cli.test.ts:20,29` — spawns the real CLI and asserts both halves | C |
| `serve` boots: port auto-pick, orphan-worktree prune, `.local/.gitignore` upkeep | packaged CLI e2e | `test/e2e/package-cli.test.ts:442,484,490,454,459` boots the default command against the installed tarball (#43). No test found for `--repo`, `--bind-host` or `--no-open` | C |
| `server-deploy` | packaged e2e | `test/e2e/package-cli.test.ts:271,284,291` — help text, a real `--platform ubuntu --yes` invocation, and the unknown-platform exit 1 (#56) | C |
| **unknown command → exit 1 + help** | none | `src/index.ts:175-178` not exercised by any spawn found | **N** |
| npm package surface: bins, `exports`, tarball contents | packaged e2e + build | `test/e2e/package-exports.test.ts`; `scripts/check-pack.mjs` via `npm run build` | C |

### 3.2 HTTP API – 27 route families, plus four cross-cutting concerns (`packages/xezar/src/server/server.ts`)

Families are named by their **chained builder** (`const <name>Routes = new Hono()…`), not by line
number. The line numbers this table used to carry had rotted in both directions and sent readers to
the wrong place; a builder name is greppable and survives the next edit. Chaining is also the only
shape hono can infer route types from, so the builder is the real unit here — see AGENTS.md § The
HTTP API.

| Family (builder) | Suite | Strongest evidence | Status |
|---|---|---|---|
| health (`healthRoutes`) | server unit | `health-forge.test.ts:96`, `health-topic.test.ts:212` | C |
| models (`modelsRoutes`) | server unit | `models-api.test.ts:67,102` | C |
| providers (`providersRoutes`) | server unit | `providers-api.test.ts:192,306` | C |
| agent-profiles (`agentProfilesRoutes`) | server unit | `agent-profiles-api.test.ts:130,243` | C |
| projects (`projectsRoutes`) | server unit | `projects-api.test.ts:250`, `checkout.test.ts:294` | C |
| workspace skills-update (`skillsUpdateRoutes`) | server unit | `skills-update-api.test.ts:62,125` | C |
| workspace config / ui-state (`workspaceConfigRoutes`) | server unit | `workspace-api.test.ts:128` | C |
| fs/browse (`fsBrowseRoutes`) | server unit | `fs-browse.test.ts:145` (symlink escape) | C |
| launch-key (`launchKeyRoutes`) | server unit | `launch-key-api.test.ts:112-190` — the served key equals the persisted one, repeats rather than regenerates, is created when absent, differs per project, and stays behind the Host/Origin guard (#53) | C |
| skills catalog (`skillsRoutes`): `GET /skills`, `/skills/importable`, `POST /skills/refresh` | server unit | `skills-api.test.ts:151,178` (the GETs by content, not only by parity), `:195,220,277` (refresh, its CSRF guard, and the unreachable-repo degradation) (#51) | C |
| ui-state (`uiStateRoutes`) | server unit | `ui-state.test.ts:48`, `ui-state-api.test.ts:69` | C |
| workflows (`workflowsRoutes`) | server unit | `project-kit-api.test.ts:19`, `request-validation.test.ts:114` | C |
| plan (`planRoutes`) | server unit | `plan-api.test.ts:80,93,114,123` parses the 200 body with the contract schema at RUNTIME (#52); rejection paths at `provider-action-gating.test.ts:167`, `request-validation.test.ts:85` | C |
| automations (`automationsRoutes`) + automation-checks (`automationChecksRoutes`) | server unit | `automations-api.test.ts:87`, `automations-gate.test.ts:91` | C |
| runs (`runsRoutes`) – ~28 sub-routes | server unit | `start-run.test.ts`, `patch-run.test.ts`, `continue-run.test.ts`, `queued-messages.test.ts`, `git-changes.test.ts:902`, `open-in-file.test.ts:73`, `start-run-todo.test.ts:126` | C |
| groups (`groupsRoutes`) | server unit | `group-pick.test.ts:92` | C |
| **open-targets (`openTargetsRoutes`)** | server unit (`POST /open-in` only) | `open-in-project.test.ts:59,69`; `GET /open-targets` only structurally hit | **P** |
| worktrees (`worktreesRoutes`) | server unit | `worktrees-api.test.ts:121` | C |
| todos (`todosRoutes`) | server unit | `todos-start.test.ts:97,124` | C |
| SSE (`sseRoutes`) | server unit | `sse-headers.test.ts:42`, `route-parity.test.ts:281` | C |
| workspace events (`workspaceEventsRoutes`) | server unit | `workspace-events.test.ts:125,401` | C |
| github (`githubRoutes`) | server unit | six `github-*-api.test.ts` files, one describe each | C |
| repo (`repoRoutes`) | server unit | `git-changes.test.ts:924,993` | C |
| config (`configRoutes`) | server unit | `config-api.test.ts:167,223` | C |
| agent-config (`agentConfigRoutes`) | server unit | `agent-config-api.test.ts:73,92` | C |
| workspace runs-index (`runsIndexRoutes`) | server unit | `runs-index-api.test.ts:85,101` | C |
| origin/host guard (middleware, before every `/api/*` route bar health) | server unit | `origin-guard.test.ts:67,74,88,95`, `host-guard.test.ts:61,79` | C |
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
| Commits tab (`/tasks/:id/commits[/:sha]`) | cockpit unit + browser e2e | `routes/task-git/task-commits.test.tsx:142-296` mounts the route (list, deep link, 409 reason, empty, loading) since #49; `e2e/commit-list.e2e.ts:166,174` exercises `CommitList` virtualization | C |
| Variant compare and pick | cockpit unit + browser e2e | `routes/compare-variants.test.tsx:121`; `e2e/variants-compare.e2e.ts:193` | C |
| Repo git tabs (diff, commits, branches) | cockpit unit + browser e2e | `routes/repo-git/repo-git.test.tsx:150`; `e2e/repo-git.e2e.ts:54` | C |
| GitHub issues and PRs | cockpit unit + browser e2e | `routes/github/github.test.tsx:302`; `e2e/github.e2e.ts:78` | C |
| **Automations (create, preview, enable, log)** | cockpit unit, both states; the BROWSER-level enabled flow still gated on `XEZ_AUTOMATIONS=1` | `routes/automations/automations.test.tsx:227-421` runs the enabled flow ungated (#48); `routes.test.tsx:355-374` the disabled one; `e2e/automations.e2e.ts:54-58` still self-skips | **P** |
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
| The e2e suite's one-worker pin, and its deletion of `VITEST_MAX_WORKERS` | cockpit unit | `e2e-file-parallelism.test.ts` — one case per half: the env var is neutralized, and `fileParallelism: false` still states the intent declaratively | C |
| Task-table Tool Name / Model columns (recorded vs inherited, verbatim model, mixed-chain `+N`, the phone card) | cockpit unit | `lib/runner-label.test.ts`; `routes/tasks-overview.test.tsx` (the "Tool Name and Model columns" describe); `routes/global-tasks.test.tsx` (same describe) | C |
| Per-project table reads the PROJECT config, not health's boot-project answer | cockpit unit | `routes/tasks-overview.test.tsx` — "takes the Tool column's default runner from the PROJECT config, not from health" | C |
| **Root vitest worker cap (`maxWorkers`)** | none | `vite-config.test.ts` guards the cockpit's chunking config; nothing guards the root `vitest.config.ts` cap, and the cap is a deliberate no-op on CI, so removing it is green everywhere. Its SIBLING config guard now exists — `e2e-file-parallelism.test.ts` pins that the e2e config deletes `VITEST_MAX_WORKERS` (#162) — which is the shape this row is asking for, applied to the other file | **N** |
| **App shell boot (`main.tsx`)** | cockpit unit for `app.tsx` only | `app.test.tsx:175-270` pins the provider stack, the routed outlet, one SSE stream, one health subscription and the error boundary (#50); `main.tsx` is still **absent from the coverage report** | **P** |

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
| Autonomous nudge actually delivered at turn end | server unit | `run-autonomous-nudge.test.ts:180,246` asserts delivery from BOTH `ActiveRun` sites (`execute` and `runContinuation`) since #59, closing the asymmetry with its twin `MONITORING_WAKE_NUDGE` at `run.test.ts:1005-1021`; `recover-autonomous.test.ts:26-84` covers the recovered flag | C |
| Legacy `runs.json` shapes still parse (`claude-cli`, absent optional fields) | server unit | `runs/store.test.ts:1754-1821` | C |
| NDJSON history paging and live cursor replay | server unit | `runs/event-history.test.ts:69,200` | C |
| Task-diff anchoring (`resolveTaskDiffBase`) | server unit | `src/git-diff-base.test.ts` | C |
| `resources.idleTimeoutMinutes` — default 15, explicit `null` never closes, live through `refresh()` | server unit | `workspace/semaphore.test.ts:46,51,56,61`; `workflows/run.test.ts` | C |
| `memoryLimitMb` — host-derived absent default, explicit `null` preserved, per-repo value overrides the workspace ceiling | server unit | `workspace/semaphore.test.ts:82,92,99,110` (incl. the production loader reading `.xezar/config.json`) | C |
| Stored `followups` / `agentEnvPassthrough` beat the env, and `[]` is a real "forward nothing" | server unit | `workspace/semaphore.test.ts:144,151,158,164,169`; `server/workspace-api.test.ts` | C |
| `resources.worktreeRetentionDefault` end to end | server + cockpit unit | `server/config-api.test.ts`; `server/workspace-api.test.ts`; `routes/settings/resources-section.test.tsx:271-395` | C |
| Runs-index row resolves `runner` per project, and derives `stepBackends` | server unit | `server/runs-index-api.test.ts` — "resolves each row's runner against ITS OWN project's default", "prefers a legacy record's own step backend", "derives the mixed-chain signal as a COUNT" | C |

> Two same-named files are easy to confuse here: `packages/xezar/src/workspace/semaphore.test.ts` (the rows above) and `workspace-semaphore.test.ts` (cited elsewhere in this section) are different suites.

### 3.5 Agent runners and the protocol

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| Every backend emits every parity capability | server unit | `core/ui-parity.test.ts`, `BACKENDS = ['claude','codex','opencode','pi']` | C |
| Golden-fixture mapping per backend | server unit | `core/__fixtures__/{claude,codex,opencode,pi}/*.expected.json` replayed by the four `*-ui-mapper.test.ts` | C |
| api-client protocol mirror stays type-exact | server unit | `server/api-types.test.ts` | C |
| Claude runner teardown | server unit | `claude-cli-runner.test.ts:92` (stub script that ignores EOF) | C |
| Codex runner against a mock app-server | server unit | `codex-app-server-runner.test.ts:31` + `mock-codex-app-server.mjs` | C |
| OpenCode runner teardown | server unit | `opencode-server-runner.test.ts` — driven against the real `__fixtures__/opencode/mock-opencode-serve.mjs`, the same binary the mapper fixtures use, rather than a mocked `node:child_process` (#55) | C |
| `createRunner` dispatch for claude / codex / opencode | server unit | `core/runner-factory.test.ts:52,60,85` — one case per `RUNNER_IDS` entry, none served by the default arm — plus the unknown id and legacy `claude-cli` at `:98,104,123,154` (#54) | C |
| `detectEnvironment` probes for claude / codex / opencode / gh / git | server unit | `core/backend-detect.test.ts:115-131` (each CLI by name and version), `:141-155` (each with a timeout), `:176-207` (missing / non-zero, parameterised over all five) (#45) | C |
| pi wall-clock deadline escalates SIGTERM→SIGKILL | server unit | `pi-runner.test.ts` — four cases, including the `timeoutMs: 0` guard that must pass both ways | C |
| A `128 + signal` exit the runner did NOT cause names its signal | server unit | `claude-cli-runner.test.ts` and `pi-runner.test.ts` (#156) — the other half of `terminatedByXezar`, contract in AGENT_PROTOCOL.md | C |
| pi records an output-cap stop and an empty turn | server unit | `core/pi-empty-turn.test.ts`, plus the `pi/empty-turn-output-cap` golden fixture replayed by `pi-ui-mapper.test.ts` (#164) | C |

### 3.6 Directory sweep – nothing silently absent

Every top-level source directory in both large workspaces, with its measured coverage and where it
appears above.

| Directory | Lines | Branches | Covered in inventory |
|---|---|---|---|
| `packages/xezar/src/` (loose files) | 91.9 % | 80.8 % | 3.1, 3.4, and gaps R8, R19 |
| `packages/xezar/src/agent-config/` | 97.2 % | 88.2 % | 3.2 (agent-config family) |
| `packages/xezar/src/automations/` | 92.7 % | 74.6 % | 3.2 (automations family) |
| `packages/xezar/src/core/` | 95.2 % | 84.2 % | 3.5 |
| `packages/xezar/src/release/` | 95.5 % | 90.9 % | 3.1 (npm package surface) + `test/e2e/release.test.ts` |
| `packages/xezar/src/runs/` | 96.8 % | 89.3 % | 3.4 |
| `packages/xezar/src/server/` | 89.2 % | 77.8 % | 3.2 |
| `packages/xezar/src/server-install/` | 89.6 % | 79.4 % | 3.1, gap R17 |
| `packages/xezar/src/workflows/` | 92.3 % | 84.0 % | 3.4, gap R7 |
| `packages/xezar/src/workspace/` | 98.0 % | 95.4 % | 3.2 (projects, workspace config) |
| `packages/web/src/api/` | 95.9 % | 83.7 % | 3.3 (live updates) |
| `packages/web/src/components/` | 96.5 % | 87.5 % | 3.3 |
| `packages/web/src/lib/` | 99.2 % | 96.4 % | 3.3 |
| `packages/web/src/routes/` | 93.3 % | 86.3 % | 3.3 |
| `packages/web/src/` (loose files) | 100 % | 98.2 % | 3.3 (`app.tsx`, `routes.tsx`; `main.tsx` is absent from the report — see R11) |
| `packages/web/src/assets/` | – | – | **Excluded**: static image assets, no executable code |
| `packages/web/src/styles/` | – | – | **Excluded**: one CSS file, no executable code |
| `packages/contract/src/` | 98.1 % | 81.3 % | Risk 2, gap R2 |
| `packages/api-client/src/` | 100 % | 95.8 % | 3.2, 3.5 (protocol mirror) |

---

## 4. Measured coverage – evidence, not ranking

Command: `npm run test:coverage`. Provider `v8`, reporters `text` and `json-summary`, output under
`.local/coverage/` per `docs/testing/local-data.md:75`. Exit code 0. **Re-measured 2026-09-10** on
`feature/coverage-16-files`, after the sixteen-file pass described below. The workspace table and
the file table carry today's numbers ONLY — two snapshots in one table get quoted interchangeably —
while section 5 keeps the `e437c24` value beside each row, because there the movement is the
point.

**Scope limit, and it matters.** The run measures only what `npm test` executes – the three vitest
projects. It does **not** measure `npm run test:unit` (node:test), `npm run test:package`
(packaged CLI) or `npm run test:e2e` (browser). A file the packaged-CLI suite exercises still reads
as 0 % here, and a file no suite touches also reads as 0 %. The report cannot tell those two apart,
which is exactly why the ranking in section 5 is behaviour-led.

| Workspace | Files in report | Line coverage | Branch coverage | Source files never loaded |
|---|---|---|---|---|
| `packages/contract` | 13 | **98.1 %** | 81.3 % | 1 of 13 |
| `packages/api-client` | 5 | **100 %** | 95.8 % | 2 of 5 |
| `packages/xezar` | 133 | **92.6 %** | 82.3 % | 10 of 133 |
| `packages/web` | 211 | **95.2 %** | 87.7 % | 1 of 211 |
| **All** | 363 | **93.7 %** | **84.7 %** | 14 |

The 363rd entry is `scripts/test-local-state.mjs` (84.2 % lines), which belongs to no workspace and
so appears in none of the four rows above.

"Never loaded" counts files with **zero covered lines**, which is not the same as "no test reaches
it": all fourteen have no executable line at all, and eight are
`packages/xezar/src/core/__fixtures__/**/*.expected.json` — golden data, not source. The rest are
re-export barrels. The total staying at 14 is a coincidence, not a consequence: per workspace it
moved 0→1, 0→2, 6→10 and 8→1.

> **These percentages are a snapshot, not current status.** Re-run `npm run test:coverage` before
> quoting a number: the tree grows, and this report is a measurement, not a gate — CI never runs it,
> so nothing stops it drifting.

### Where high line coverage coexists with an untested behaviour

- ~~`packages/contract` measures 97.6 % lines and has zero tests of its own and no vitest project at
  all.~~ **Closed (#120)** — it is now a vitest project with two co-located test files. The line
  coverage was incidental at the time of measurement; the shape is kept here because it is the
  general warning: a high number can be entirely other packages' doing.
- `packages/web/src/components/task-agent.tsx` has **no co-located test**. Its coverage is incidental,
  via `routes/tasks-overview.test.tsx` and `routes/global-tasks.test.tsx`. The pure rules it renders
  do have their own tests (`lib/runner-label.test.ts`); the components themselves do not.
- `dropdown-menu.tsx` and `popover.tsx` are the sharpest case of the general warning above, in
  reverse. Both read **100 %** in the table at the top of this section, and both read 56-67 % on
  `main` before this branch — while being rendered on nearly every screen the whole time, because a
  wrapper's coverage comes entirely from whoever happens to render it. What their new co-located
  tests pin is the part the incidental coverage never touched: the `data-slot` contract the browser
  specs select on, and the visual-viewport merge that is the only reason `PopoverContent` is not a
  bare re-export.
- `packages/xezar/src/agent-config/model-settings/{claude,codex,opencode,pi}.ts` each measure
  **100 % lines and 100 % branches** with **zero co-located test files**. Their coverage is a side
  effect of the agent-config API tests.
- `packages/xezar/src/ui-state.ts` measures 100 % / 100 % with no co-located test.
- `packages/xezar/src/core/agent-runner.ts` measures 100 % – it is the type seam, so this number
  says nothing about runner correctness.
- ~~`packages/xezar/src/server/launch-key.ts` measures 100 % lines while the `GET /launch-key`
  route it backs has no behavioural assertion found.~~ **No longer true (#53)** —
  `launch-key-api.test.ts:112-190` asserts the served value, its idempotence and its per-project
  scoping. Kept as the shape of the warning: a 100 % on a module whose ROUTE is untested says
  nothing, and this one was the example until someone wrote the test.

### Where the opposite is true – low coverage, well-guarded behaviour

- `packages/xezar/src/index.ts` is **absent from the report entirely**, yet `run`, `projects`,
  `server-install`, `server-uninstall`, `server-deploy`, `--help` and `--version` are all exercised
  by the node:test suites that CI does run, and `init` by `project-kit-cli.test.ts`. Its 0 % is a
  measurement artefact for every one of those paths, `serve` included since #43:
  `test/e2e/package-cli.test.ts:433-495` boots the packaged CLI's default command and asserts port
  fallback, orphan prune and `.local/.gitignore` upkeep, in a suite CI runs.
- `packages/xezar/src/planner.ts` measures 85.4 % lines here (37.5 % at `e437c24`) while
  `test/unit/planner.test.ts` covers two of its functions in a suite this run does not see. The
  number moved without anyone testing the planner: this is a measurement, and measurements drift.
- `packages/xezar/src/server-install/*` still measures unevenly (`ubuntu-vps.ts` 82.3 %,
  `engine.ts` 85.5 %); parts of the install path are exercised by `test/e2e/package-cli.test.ts`
  instead, and the branches those two platforms reach — `apt`, `launchctl`, `certbot`, a real
  `nginx` — cannot be reached from a unit suite at all. What the vitest side can hold is the argv
  each of them WOULD pass, which is what the platform tests assert.

### Lowest-covered files (measured, for orientation only)

**No measured source file with an executable line is under 80 % lines any more.** The floor is
`commit-dialog.tsx` and `use-finish-run.ts` at exactly 80.0 %; every file the `e437c24` snapshot
listed here has moved above it. That is a fact about this report, not a promise about the code:
read the branch column beside it, and remember the scope limit at the top of this section.

Every file below 86 % lines, in order. The branch column is bolded below 75 % — that is where the
interesting gaps are now, since the line column no longer has any.

| File | Lines | Branches |
|---|---|---|
| `packages/web/src/routes/task-git/commit-dialog.tsx` | 80.0 % | **58.8 %** |
| `packages/web/src/routes/task-thread/use-finish-run.ts` | 80.0 % | 100.0 % |
| `packages/xezar/src/git-worktree.ts` | 82.1 % | **66.1 %** |
| `packages/xezar/src/server-install/platforms/ubuntu-vps.ts` | 82.3 % | **69.8 %** |
| `packages/web/src/routes/settings/add-account-dialog.tsx` | 82.3 % | **73.9 %** |
| `packages/xezar/src/server/forge/github.ts` | 83.3 % | **74.0 %** |
| `packages/web/src/components/skill-detail.tsx` | 83.3 % | 80.0 % |
| `packages/web/src/routes/workflows/workflows.tsx` | 83.6 % | **67.6 %** |
| `packages/web/src/routes/task-git/task-changes.tsx` | 84.1 % | **71.7 %** |
| `scripts/test-local-state.mjs` | 84.2 % | **50.0 %** |
| `packages/web/src/routes/task-thread/session-transcript.tsx` | 84.4 % | 77.8 % |
| `packages/web/src/components/diff/diff.tsx` | 85.2 % | 76.9 % |
| `packages/web/src/routes/settings/skills-section.tsx` | 85.2 % | **73.3 %** |
| `packages/xezar/src/planner.ts` | 85.4 % | **57.6 %** |
| `packages/xezar/src/server-install/engine.ts` | 85.5 % | 76.3 % |
| `packages/web/src/components/facet-filter.tsx` | 85.7 % | 94.4 % |
| `packages/xezar/src/server/open-in-app.ts` | 85.7 % | **70.1 %** |
| `packages/xezar/src/core/usage-limit.ts` | 85.9 % | **66.2 %** |
| `packages/web/src/routes/automations/automations.tsx` | 85.9 % | **68.1 %** |

The bolded branch numbers are where to look next. One has been counted rather than guessed:
`workflows.tsx` sits at 83.6 % lines against 67.6 % branches, and of its 70 uncovered branches
**18 (26 %) are the three dnd-kit drag handlers**, rising to about 44 % if the drag-state rendering
they drive is counted with them. The majority — error toasts, `??` defaults, the Cmd+Enter
shortcut, the palette filter, the debounce timers — is not drag-related at all.

For the drag handlers specifically: `moveStep` has exactly one call site in that file
(`workflows.tsx:293`, inside `handleDragEnd`), so there is no keyboard or click path into it and
the unit suite cannot reach it — the component does wire a `KeyboardSensor` (`workflows.tsx:237`),
so "jsdom cannot drive it" is an *inferred* claim about dnd-kit's pointer geometry, not a measured
one. What the unit suite holds instead is `moveStep` as a pure function
(`lib/workflow-builder.test.ts:91-102`). The other bolded rows have not been diagnosed.

Files absent from the report entirely: `packages/xezar/src/index.ts`,
`packages/xezar/src/core/ui-events.ts`, `packages/xezar/src/server/app-type.ts`,
`packages/xezar/src/server/forge/types.ts`,
`packages/xezar/src/agent-config/model-settings/types.ts`, `packages/web/src/main.tsx`,
`packages/web/src/components/diff/types.ts`, and four `components/ui/*` primitives —
`card.tsx`, `scroll-area.tsx`, `select.tsx` and `separator.tsx`. The `types.ts` and `app-type.ts`
entries are type-only modules and are **excluded** as not testable. The four primitives are absent
for a more interesting reason: `grep -rn "ui/card\|ui/scroll-area\|ui/select\|ui/separator"
packages/web/src` returns nothing, so no module imports them and none is ever loaded. They are dead
shadcn scaffolding, not a coverage gap. `update-check.ts`, `app.tsx` and `task-commits.tsx` have
since joined the report.

---

## 5. Ranked gap list

Ranked by regression risk – likelihood a change breaks it, how bad that is for a user, and how
invisible the breakage would be to the current gates. Each row maps to exactly one child issue of
epic #42, and every child issue maps back to exactly one row.

**All twenty child issues are closed, and this table has been re-audited against them.** Each row
below was checked by reading the closing commit and the test file it added, not by looking at a
percentage. Eighteen rows are struck through because a test now covers the behaviour the row
names; two (R9, R11) are struck only in part, and say which part survives.

Two warnings that outlived the audit, because they are what this table is *for*:

- **A percentage moving is not a closed row.** Some numbers below rose because a test was written
  for them; others rose because an unrelated suite happened to load more of the file. Only the
  cited test file closes a row.
- **These verdicts are code-reading, not measurement.** "A test exists and asserts the named
  behaviour" was established by opening each file. Whether it passes is a separate question that
  `npm test` answers.

| # | Gap | Why it ranks here | Evidence | Issue |
|---|---|---|---|---|
| ~~R1~~ | ~~Browser e2e suite never runs in CI, and its skip path exits 0~~ — **closed** | fixed by #128: a separate `ui-e2e` job runs the suite and passes only on a literal `TEST_E2E_STATUS=passed` line, so the skip path fails the job instead of reading green | `ci.yml` `ui-e2e` job | #60 |
| ~~R2~~ | ~~`packages/contract` has no vitest project and no tests~~ — **closed** | fixed by #120: the root config lists four projects and the package has two test files | `vitest.config.ts` | #61 |
| ~~R3~~ | ~~`xezar init` has no test at any level~~ — **closed** | `project-kit-cli.test.ts` spawns the real CLI and covers both the scaffold and the never-overwrite half | `project-kit-cli.test.ts:20,29` | #62 |
| ~~R4~~ | ~~`xezar serve` boot path has no CLI-level test~~ — **closed** | fixed by #43: the packaged CLI boots its default command and all three named behaviours are asserted | `test/e2e/package-cli.test.ts:442,484,490` (requested port, then auto-pick off a squatted one), `:454` (orphan prune), `:459` (`.local/.gitignore`) | #43 |
| ~~R5~~ | ~~`server/git.ts` at 27.6 % branches~~ — **closed** | fixed by #44: 16 repository-shape cases, so the rise to 86.2 % branches is deliberate, not incidental | `server/git.test.ts:66-250` — nested dir, detached HEAD, bare repo, submodule, linked worktree, deleted dir | #44 |
| ~~R6~~ | ~~`backend-detect.ts` probes only asserted for `pi`~~ — **closed** | fixed by #45: every agent CLI is probed by name, with a timeout, and with the missing/non-zero case parameterised over all five binaries | `core/backend-detect.test.ts:115-131,141-155,176-207` | #45 |
| ~~R7~~ | ~~`workflows/load.ts` at 40 % branches~~ — **closed** | fixed by #46: per-file degradation and built-in restoration both asserted | `workflows/load.test.ts:47,61,70,87,115` (degradation), `:180,199,216` (built-ins come back) | #46 |
| ~~R8~~ | ~~`handoff.ts` at 36.4 % branches~~ — **closed** | fixed by #47: the marker vocabulary and every parser branch (case, indentation, fenced code, truncated payload) are read directly, so the 100 % is backed by assertions. A co-located test file existed at `e437c24` as well — the original "none found" reading was simply wrong | `handoff.test.ts:61-168` (markers), `:170-304` (journal); BC §8 | #47 |
| ~~R9~~ | ~~Automations cockpit route, enabled path only in a gated e2e~~ — **closed in part** | fixed by #48 at the unit level: create-paused, preview, enable, pause and log now run on every `npm test`, deliberately ungated. What survives is the BROWSER-level flow — `automations.e2e.ts:55-58` self-skips without `XEZ_AUTOMATIONS=1`, and that variable appears in neither `scripts/e2e.sh` nor `ci.yml` | `automations.test.tsx:227-421`; `automations.test.tsx:20-24` states the choice | #48 |
| ~~R10~~ | ~~Commits tab route has no cockpit unit test~~ — **closed** | fixed by #49: eleven cases mount the route itself — list, deep link to `/commits/:sha`, the 409 no-worktree reason, empty state, loading — so the 100 % is measured against assertions | `task-commits.test.tsx:142-296`; `routes.test.tsx:206-207` | #49 |
| ~~R11~~ | ~~`app.tsx` and `main.tsx` never loaded by a unit test~~ — **closed in part** | fixed by #50 for the shell: provider stack, routed outlet, one workspace event stream, one health subscription, error boundary with retry. `main.tsx` itself is still absent from the report, so its own logic — the `meta[name="xez-api-base"]` over `VITE_XEZ_API_BASE` precedence and the missing-`#root` throw (`main.tsx:19-27`) — has no test found in the suites examined | `app.test.tsx:175,193,209,241,254,270` | #50 |
| ~~R12~~ | ~~`POST /skills/refresh` and the skills catalog GETs~~ — **closed** | fixed by #51, including the CSRF guard and the unreachable-repo degradation | `skills-api.test.ts:151,178` (GETs), `:195,220,277` (refresh) | #51 |
| ~~R13~~ | ~~`POST /plan` success path~~ — **closed** | fixed by #52: the 200 body is parsed by the contract schema at RUNTIME, not only type-checked | `plan-api.test.ts:80,93,114,123` | #52 |
| ~~R14~~ | ~~`GET /launch-key` has no behavioural assertion~~ — **closed** | fixed by #53: the served key equals the one persisted in that project's `.local/xezar/launch-key`, is repeated rather than regenerated, is generated when absent, differs per project, and stays behind the Host/Origin guard | `launch-key-api.test.ts:112-190` | #53 |
| ~~R15~~ | ~~`createRunner` dispatch only asserted for `pi`~~ — **closed** | fixed by #54: one case per `RUNNER_IDS` entry, with no id served by the default arm | `core/runner-factory.test.ts:52,60,85` (each id), `:98,104,123,154` (unknown id, legacy `claude-cli`) | #54 |
| ~~R16~~ | ~~OpenCode runner teardown bypasses its golden mock server~~ — **closed** | the suite now drives the real `mock-opencode-serve.mjs`, removing the asymmetry with codex | `opencode-server-runner.test.ts` | #55 |
| ~~R17~~ | ~~`server-install` steps/ui/platforms at 50-63 % branches, `server-deploy` untested~~ — **closed** | `server-deploy` now has help-text, real-invocation and unknown-platform coverage, and the install steps/ui gained tests with it | `test/e2e/package-cli.test.ts:271,284,291` | #56 |
| ~~R18~~ | ~~`skills-remote.ts` at 41.8 % branches~~ — **closed** | fixed by #57 for the scheduler (`shouldPassiveFetch`, including the exactly-TTL boundary) and by this branch for the git half, which now runs against a real local bare clone | `skills-remote.test.ts:6-27`; `test/unit/skills-remote.test.ts:447,473`; `skills-remote-git.test.ts` | #57 |
| ~~R19~~ | ~~`planner.ts` at 20 % branches, `update-check.ts` absent from coverage~~ — **closed** | fixed by #58: seven `planChain` degradation cases and a full `update-check` suite. The planner's 57.6 % branches is still the lowest number in the file table above, so the row is worth re-reading before anyone edits that module | `test/unit/planner.test.ts:165-215`; `update-check.test.ts:50-195` | #58 |
| ~~R20~~ | ~~Autonomous nudge delivery has no direct test~~ — **closed** | fixed by #59, and at BOTH `ActiveRun` construction sites — the asymmetry `AGENTS.md` warns about is exactly what the test covers | `run-autonomous-nudge.test.ts:180` (via `execute`), `:246` (via `runContinuation`), plus four guards at `:213,230,290,312` | #59 |

---

## 6. Gate structure, not just missing tests

**~~Covered by a suite CI never executes.~~ — closed by #128.** The browser e2e layer's 35 specs
now run in CI as their own `ui-e2e` job, so a cockpit journey in section 3.3 whose only evidence is
an `e2e/*.e2e.ts` file is gated after all. (The commits tab used to be the clearest example of one;
since #49 it has a cockpit unit test as well, so it is no longer an example of anything.) One
exception survives: the enabled automations flow (R9) sits behind `XEZ_AUTOMATIONS=1`, which
neither `scripts/e2e.sh` nor the CI job sets, so that spec self-skips and the BROWSER-level flow
stays ungated — the unit-level flow does run.

**Covered only by manual QA.** `SDLC.md:89` states plainly that user-facing changes need the
separate real-browser QA, and `CODE_REVIEW.md:3` repeats that `test:e2e` is "the QA layer", not part
of the review gate. `SDLC.md:71` allows a self-QA exception with attached evidence. So the last line
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
`runs/task-markers.test.ts` plus `handoff.test.ts` cover §8, and since #47 the latter's branches
are fully exercised (see R8). §1 was the thinnest, and that was gaps R3, R4 and R17 — all now
closed, leaving only the unknown-command exit path (section 3.1).

**A blind spot the drift guard itself declares.** `bc-route-inventory.test.ts:36-40` records that it
cannot see `/api/v1/ws`, because the WebSocket upgrade is not a Hono route. That entry is maintained
by hand in `BACKWARD_COMPATIBILITY.md` §2 and nothing can catch it drifting.

---

## 7. Findings outside the epic

These were uncovered by the audit and are deliberately **not** child issues.

1. ~~**CI job name is misleading.**~~ **Resolved by #128.** The job is now named "Typecheck, unit
   tests, build, and package" (`ci.yml:29`), and the browser suite runs in its own `ui-e2e` job
   (`ci.yml:87-88`). The lesson survives: a job name that promises coverage it does not deliver is
   why the gap went unnoticed.
2. ~~**`docs/testing/local-data.md:75` is now stale.**~~ **Resolved.** That line now reads "One
   report producer is configured: `npm run test:coverage` writes the v8 coverage report to
   `.local/coverage/`". The rule it sets still stands: reporters write beneath `.local`, never a root
   report directory.
3. **The task table's COLUMN ORDER is pinned only in the browser suite.**
   `packages/web/e2e/quick-list.e2e.ts` reads the ± cell positionally (`td:nth-child(7)`, deliberately
   positional so it pins order as well as content). Every other column assertion is by
   `data-column-id`. Since #128 that spec does run in CI (`ui-e2e`), so the order is gated — but by a
   single positional selector in one browser spec, not by any unit test. See Risk 1.
4. **`.gitignore` already carries a root `coverage/` rule** that predates this change and now
   points at nothing, because the script writes to `.local/coverage/`. Harmless; noted so nobody
   re-adds a root reporter on the strength of it.
5. **No repository document contained an instruction addressed to the agent reading it.** The audit
   looked. Every "must"/"never" found in `AGENTS.md`, `SDLC.md`, `CODE_REVIEW.md`,
   `BACKWARD_COMPATIBILITY.md` and `AGENT_PROTOCOL.md` is engineering policy about the codebase, not
   a directive aimed at an agent.
6. **No bug was found that warranted a separate bug issue.** Every gap above is a missing test, not
   broken behaviour.

## 8. Labels created for this work

Three labels were created because no existing label fitted: `epic` (a tracking issue with
sub-issues), `testing` (test-coverage work) and `priority-high`, which `SDLC.md:47-52` defines but
the repository did not have. Child issues also carry the existing `enhancement` label.

The epic is #42. Its twenty children are attached as native GitHub sub-issues through
`POST /repos/qodeca/xezar/issues/42/sub_issues`, so `gh issue view 42` shows them with a live
progress indicator. No fallback was needed.

## 9. Method and limits

- Coverage: originally one `npm run test:coverage` run, exit 0, on `feature/coverage-gap-audit` at
  `e437c24`. **Re-measured 2026-09-10** on `feature/coverage-16-files`, exit 0; every percentage in
  sections 4 and 5 is from that second run. Section 5 keeps the `e437c24` value beside each row so
  the movement is visible; section 4's tables carry today's numbers only.
- The 2026-09-10 pass added tests for sixteen named files. It was a coverage-floor exercise, not a
  gap-closing one: raising a file's percentage and covering the behaviour a section-5 row names are
  different jobs, and only R18 is a row this pass advanced.
- **Section 5 was separately re-audited on 2026-09-10, and it needed it.** Its rows were written on
  2026-09-09 against issues that have since been closed by merged test commits, and a first attempt
  at refreshing this document updated the percentages while leaving the evidence column asserting
  the opposite of the repository — including three newly written, absolute "no test found" claims
  (R8, R10, R14) against test files of 374, 294 and 200 lines, two of which were written expressly
  to close the row that denied them. The audit read the closing commit and the test file for all
  twenty rows. **Its verdicts are code-reading, not measurement**: "a test exists and asserts the
  named behaviour", established by opening the file. Whether every one of them passes is what
  `npm test` answers, and this document does not claim it.
- The lesson is the one this document already teaches, turned on its author: a percentage is cheap
  to refresh and a sentence about whether something is tested is not, and refreshing the first
  without re-reading the second produces a document that is confidently wrong in the direction that
  costs a reader the most — skipping a test that already exists, or believing a covered behaviour
  is unguarded.
- Test claims: every test cited was opened and read, or located by grep and then opened. Filenames
  alone were never treated as evidence of coverage.
- **Git history is not usable as regression evidence in this checkout.** As audited on
  2026-09-09, `git log` held 39 commits, all dated 2026-09-07 to 2026-09-09, beginning with `1f729a7 chore: import cezar upstream
  baseline`. `git log --grep=fix -i` returns 13 commits; `--grep=regress -i` returns none. The
  incident numbers cited throughout `AGENTS.md` (#810, #811, #661, #591, #751, #694, #426, #430,
  #472) do not resolve against `qodeca/xezar`; they resolve against the predecessor repository
  `open-mercato/cezar`. The incidents are real and closed there – they were used as prose evidence
  for the ranking, not as commits in this repository.
- The thirteen `fix` commits that do exist cluster into three themes: test-gate and worktree
  isolation (3), release and CI mechanics (3), and cockpit behaviour (3). Two of those three themes
  are about the test infrastructure itself, which is consistent with the gaps ranked above.

---

## 10. MCP floor (#333)

`SDLC.md` § The MCP test floor holds the MCP server to two requirements at once: every source file
under `packages/xezar/src/mcp/` at 80 % lines **and** 80 % branches from the MCP suites alone, and
every new test shown failing against a named break. This section is where that rule keeps its
records – the measurement, the quality finding beside it, the behaviours held by suites v8 cannot
see, and the written exemptions. It is dated like the rest of this document: re-measure before
quoting a number.

### 10.1 The command

`npm run test:coverage:mcp` – vitest's `server` project, restricted to the MCP test files
(`packages/xezar/src/mcp/`, `packages/xezar/src/server/mcp-*`,
`packages/xezar/src/server/stale-write-routes*`), v8 provider, coverage included over
`packages/xezar/src/mcp/**` minus `*.testkit.ts`, and a per-file threshold of 80 % lines and 80 %
branches. It writes to `.local/coverage/mcp/` and exits non-zero naming each file under the floor.
About 40 seconds on the machine that measured it; it does not run the other ~200 server test files,
which is the point – coverage a module picks up from an unrelated test was never aimed at it.

What it cannot see is listed in 10.4. It is not in CI and not in `.ai/agentic.config.json`: it
fails on `main` until the #311-owned files in 10.6 are re-measured.

### 10.2 Measured – before and after this change

Measured 2026-09-11. Before: revision `11a6df3`, 915 tests. After: this branch, 939 tests – twenty-four new, seven of them
added because the mutation sample (10.3) named a gap and six because checking #311's diff showed the
`service.ts` and `index.ts` gaps were not leaving (10.6) – plus five in the contract project, which
this command does not run (10.5). Same command both times.

| File | Lines before | Branches before | Lines after | Branches after |
|---|---|---|---|---|
| `adapters/codex.ts` | 75.5 | 73.7 | 75.5 | 73.7 **below** |
| `api-reference.ts` | 100.0 | 77.3 | 100.0 | 77.3 **below** |
| `service.ts` | 92.6 | 78.4 | **94.7** | **90.2** |
| `index.ts` | 86.6 | 79.8 | 86.6 | **80.7** |
| `bridge.ts` | 87.5 | 71.4 | **92.1** | **80.0** |
| `tools/results-evidence.ts` | 98.5 | 79.5 | **98.5** | **80.6** |
| `tools/handoff-git.ts` | 94.9 | 77.0 | **97.0** | **81.6** |
| `adapters/claude-code.ts` | 94.4 | 82.1 | 94.4 | 82.1 |
| `tools/project-config.ts` | 98.4 | 82.4 | 98.4 | 82.4 |
| `adapters/opencode.ts` | 95.4 | 83.2 | 95.4 | 83.2 |
| `operation-receipts.ts` | 94.8 | 84.5 | 94.8 | 84.5 |
| `tools/work-organisation.ts` | 97.2 | 84.9 | 97.2 | 84.9 |
| `tools/task-reads.ts` | 94.1 | 77.1 | **98.4** | **85.0** |
| `tools/leader-events.ts` | 92.3 | 86.1 | 92.3 | 86.1 |
| `tools/task-create.ts` | 97.3 | 87.0 | 97.3 | 87.0 |
| `tools/local-handoff.ts` | 100.0 | 87.3 | 100.0 | 87.3 |
| `event-journal.ts` | 98.9 | 87.6 | 98.9 | 87.6 |
| `event-controller.ts` | 93.7 | 87.7 | 93.7 | 87.7 |
| `tools/execution-control.ts` | 98.9 | 88.7 | 98.9 | 88.7 |
| `reconnect.ts` | 96.5 | 88.8 | 96.5 | 88.8 |
| `stale-write.ts` | 100.0 | 89.8 | 100.0 | 89.8 |
| `service-adapter.ts` | 97.8 | 92.3 | 97.8 | 92.3 |
| `resource-ownership.ts` | 98.0 | 92.5 | 98.0 | 92.5 |
| `event-catalog.ts` | 97.2 | 92.6 | 97.2 | 92.6 |
| `tools/discovery.ts` | 97.1 | 89.7 | **97.1** | **93.1** |
| `audit-trail.ts` | 99.0 | 92.7 | **99.0** | **94.8** |
| `echo-guard.ts` | 100.0 | 96.0 | 100.0 | 96.0 |
| `session-binding.ts` | 100.0 | 97.0 | 100.0 | 97.0 |
| `connection-file.ts` | 100.0 | 100.0 | 100.0 | 100.0 |
| `ipc.ts` | 100.0 | 100.0 | 100.0 | 100.0 |
| `project-catalogs.ts` | 100.0 | 100.0 | 100.0 | 100.0 |
| `protocol.ts` | 100.0 | 100.0 | 100.0 | 100.0 |
| `tool.ts` | 100.0 | 100.0 | 100.0 | 100.0 |
| `tools/index.ts` | 100.0 | 100.0 | 100.0 | 100.0 |

Bold marks a number that moved. Two files where a real gap was closed did not move at all –
`connection-file.ts` was already at 100 %, and `resource-ownership.ts` stayed at 92.5 % – which is
the point of 10.3: the percentage could not see either gap, before or after.

Aggregate after: 96.0 % lines, 85.3 % branches (before: 95.3 / 83.7). Every file that moved, moved because a test in
10.3's list reaches a behaviour it did not reach before – none moved because a test called
something and asserted nothing.

### 10.3 The quality finding: a sampled mutation run

**Method.** A regex-level stand-in for StrykerJS's default operators (equality, logical and
relational operators, `!` removal, boolean literals, `if` negation, deletion of a one-line call
statement; string literals excluded) found 3 136 candidate mutants across the 34 source files.
Up to five per file were drawn with a fixed seed, applied one at a time in a throwaway
`git archive` copy – never the task worktree – and run against the file's direct test importers;
a mutant those did not kill was run against the whole MCP scope before it was called a survivor.
Each run was capped (600 s, then 120 s for the last files); a mutant that hung the suite counts as
killed, as Stryker counts a timeout. The script and every row are in the task's private evidence;
the conclusions are here.

**Result.** 158 mutants sampled over 33 modules (`tools/index.ts` has none): **121 killed
(76.6 %), 37 survived**; 4 of the kills were runs that hung until their cap. Numbers are per module
on the tree BEFORE this change, so each row reads beside the coverage the module had then.

| Module | Lines before | Branches before | Mutants killed / sampled | Survivors |
|---|---|---|---|---|
| `tools/task-reads.ts` | 94.1 | 77.1 | 1 / 5 | 413 LogicalOperator, 561 RelationalOperator, 169 BooleanLiteral, 564 RelationalOperator |
| `adapters/opencode.ts` | 95.4 | 83.2 | 2 / 5 | 496 StatementDeletion, 491 StatementDeletion, 470 LogicalOperator |
| `index.ts` | 86.6 | 79.8 | 2 / 5 | 409 LogicalOperator, 187 StatementDeletion, 194 LogicalOperator |
| `operation-receipts.ts` | 94.8 | 84.5 | 2 / 5 | 681 EqualityOperator, 459 StatementDeletion, 502 LogicalOperator |
| `adapters/codex.ts` | 75.5 | 73.7 | 3 / 5 | 168 StatementDeletion, 473 StatementDeletion |
| `audit-trail.ts` | 99.0 | 92.7 | 3 / 5 | 242 LogicalOperator, 251 RelationalOperator |
| `tools/discovery.ts` | 97.1 | 89.7 | 3 / 5 | 247 BooleanLiteral, 180 EqualityOperator |
| `tools/leader-events.ts` | 92.3 | 86.1 | 3 / 5 | 95 EqualityOperator, 153 EqualityOperator |
| `tools/project-config.ts` | 98.4 | 82.4 | 3 / 5 | 1004 BooleanLiteral, 884 EqualityOperator |
| `tools/work-organisation.ts` | 97.2 | 84.9 | 3 / 5 | 375 RelationalOperator, 303 BooleanLiteral |
| `adapters/claude-code.ts` | 94.4 | 82.1 | 4 / 5 | 567 LogicalOperator |
| `bridge.ts` | 87.5 | 71.4 | 4 / 5 | 421 BooleanLiteral |
| `connection-file.ts` | 100.0 | 100.0 | 4 / 5 | 62 StatementDeletion |
| `event-controller.ts` | 93.7 | 87.7 | 4 / 5 | 452 RelationalOperator |
| `tools/handoff-git.ts` | 94.9 | 77.0 | 4 / 5 | 462 LogicalOperator |
| `tools/results-evidence.ts` | 98.5 | 79.5 | 4 / 5 | 1155 EqualityOperator |
| `tools/task-create.ts` | 97.3 | 87.0 | 4 / 5 | 384 BooleanLiteral |
| `resource-ownership.ts` | 98.0 | 92.5 | 4 / 5 | 209 EqualityOperator |
| `service-adapter.ts` | 97.8 | 92.3 | 4 / 5 | 67 StatementDeletion |
| `service.ts` | 92.6 | 78.4 | 4 / 5 | 99 StatementDeletion |
| `session-binding.ts` | 100.0 | 97.0 | 4 / 5 | 216 LogicalOperator |
| `reconnect.ts` | 96.5 | 88.8 | 4 / 5 | 247 LogicalOperator |
| `api-reference.ts` | 100.0 | 77.3 | 5 / 5 | – |
| `echo-guard.ts` | 100.0 | 96.0 | 5 / 5 | – |
| `event-catalog.ts` | 97.2 | 92.6 | 5 / 5 | – |
| `event-journal.ts` | 98.9 | 87.6 | 5 / 5 | – |
| `tools/execution-control.ts` | 98.9 | 88.7 | 5 / 5 | – |
| `tools/local-handoff.ts` | 100.0 | 87.3 | 5 / 5 | – |
| `stale-write.ts` | 100.0 | 89.8 | 5 / 5 | – |
| `tool.ts` | 100.0 | 100.0 | 1 / 1 | – |
| `project-catalogs.ts` | 100.0 | 100.0 | 4 / 4 | – |
| `protocol.ts` | 100.0 | 100.0 | 3 / 3 | – |
| `ipc.ts` | 100.0 | 100.0 | 5 / 5 | – |

`tools/task-reads.ts` is the clearest case of the two halves disagreeing: 94.1 % lines, and four of
its five sampled mutants survived. A 1-in-5 row is a sample of five, not a verdict – but a module
whose lines all run while most of its sampled decisions can flip unnoticed is exactly what the floor
alone would have passed.

**Good numbers, weak tests – the modules to name.** `connection-file.ts` measured **100 % lines and
100 % branches**, and deleting the `chmodSync` that keeps the descriptor at 0600 over a stale
world-readable temp file broke no test. `audit-trail.ts` (99.0 / 92.7) let a secret-bearing action
through with its `||` turned into `&&`, and let a 12-character caller secret go unredacted with `>=`
turned into `>`. `tools/discovery.ts` (97.1 / 89.7) let gh's and git's reported availability flip.
`resource-ownership.ts` (98.0 / 92.5) let an unreadable worktree path pass the ownership check
that #316 exists to enforce. Each now has a test that is red against exactly that break.

**Survivors, classified.** Closed here with a test shown red: `audit-trail.ts:242,251`,
`connection-file.ts:62`, `tools/discovery.ts:180`, `tools/handoff-git.ts:462`,
`resource-ownership.ts:209`. Equivalent or not reachable at runtime (no test can see them, by
design): `bridge.ts:421` (the timer is already cleared), `service-adapter.ts:67` (nothing sends an
`Origin` in process today), `tools/task-create.ts:384` (a type argument – a harness artefact),
`event-controller.ts:452` (one extra back-off sleep after the last attempt). `tools/task-reads.ts:564` is near-equivalent: it
decides only for a row whose JSON fits one part but not one page, a window a few bytes wide – a test
written for it passed with the break applied and was dropped. Open, in files #311 does not own – the
follow-up list: `tools/work-organisation.ts:303` (a success status with no body read as success),
`session-binding.ts:216` (`.`/`..` run ids), `tools/discovery.ts:247` (a throwing forge probe read
as available), `operation-receipts.ts:459,502,681` (the journal-unwritable warning, intent recovery,
a torn last line), `tools/results-evidence.ts:1155`,
`tools/task-reads.ts:169,413,561`, `tools/work-organisation.ts:375`,
`tools/project-config.ts:884,1004`, `tools/leader-events.ts:95,153`. The node:test suites
(`mcp-durability`, `mcp-isolation`) were run against the `operation-receipts.ts` and
`reconnect.ts` survivors too – v8 cannot see them, and neither can a vitest-only mutation run – and
they did not kill them either: those four are open, not covered elsewhere. Open, in #311's files:
`reconnect.ts:247` (#311 changes `reconnect.ts`; an earlier version of this list put it on the other
side), `adapters/claude-code.ts:567`, `adapters/codex.ts:168,473`, `adapters/opencode.ts:470,491,496`,
`index.ts:187,194,409`, `service.ts:99` – the last is the socket directory's `chmod 0700`, the
same shape as the connection-file gap. Every open survivor is tracked in #338; the three that could
have shipped a leak or an ownership pass in 0.14.0 are #337, closed here.

**What a full run costs – measured, not inferred.** The sample's own cost: a mutant killed by its
direct tests took a median 6.9 s end to end, a survivor needed a full MCP scope run of a median 38 s
to be sure, and the 158 mutants took 68 minutes over three parallel copies. The sample's *inferred*
"5 000–8 000 mutants" for a real StrykerJS run was **too low**: Stryker generates **12 530** on this
scope. The real run, its cost and its score are in 10.8 – it is a release gate now, adopted on the
sample's recommendation, and the per-PR form stays the named break SDLC.md requires.

### 10.4 Held by a suite v8 cannot see

These behaviours are tested, in suites `npm run test:coverage:mcp` does not measure. They are
recorded here so "covered elsewhere" is a fact with a file and a line, and so nobody writes a
duplicate vitest test to move a percentage.

| Behaviour | Suite | Evidence | Runs in CI? |
|---|---|---|---|
| A-13 stale leader write refused after a human change; concurrent calls, one applies | node:test | `test/unit/mcp-durability.test.ts:100,155` | yes (`npm run test:unit`) |
| A-14 a lost response replays once, a collision is refused, a SIGKILL between effect and receipt is unverified | node:test | `test/unit/mcp-durability.test.ts:204,246,271,342` | yes |
| A-16 absent or corrupt MCP state starts fresh, warns once, keeps the bad bytes; no two owners after a restart | node:test | `test/unit/mcp-durability.test.ts:416,466,558` | yes |
| A-21 reconnect: valid cursor, cursor past retention, duplicates and out-of-order rows | node:test | `test/unit/mcp-durability.test.ts:587-667` | yes |
| A-02, A-03, A-04, A-12 project isolation, partial success, foreign cursors, connection file kept out of Git | node:test | `test/unit/mcp-isolation.test.ts:73-299` (skipped on Windows) | yes |
| A-16 an UPGRADED packaged cockpit with MCP state corrupt, deleted, hard-restarted | packaged CLI | `test/e2e/mcp-upgrade.test.ts:214` | yes (`npm run test:package`) |
| `xez mcp` as a real subprocess: handshake, absent bridge, service down, a neighbour on the port, and a directory xezar never served answering `not-registered` (the branch at `index.ts:395`) | server unit, but the bridge runs in a CHILD process v8 does not follow | `src/mcp/cli.test.ts:120,153,165,199,203` | yes |
| A-20 the open cockpit follows MCP changes; A-01/A-17/A-23 the MCP connection screen | browser | `packages/web/e2e/mcp-live-sync.e2e.ts:194,232`, `mcp-collaboration.e2e.ts` | yes (`ui-e2e`) |
| A-01, A-17, A-18, A-19, A-20, A-23 with REAL Claude Code, Codex and OpenCode clients | node:test integration harness | `test/integration/mcp-real-clients.test.ts` | **no** – run by hand; results in `docs/features/mcp-server/mcp-client-acceptance-record.md` |

The last row is the one to read twice: the real-client harness is outside every gate by design (it
needs the real CLIs), so what it proves is only as current as its last recorded run.

### 10.5 Held by behaviour, not by a percentage

v8 marks every line of a zod declaration covered the moment the module is imported, so the
contract's `mcp-*.ts` files carry no floor. What they carry instead: each piece of logic that can
refuse has a test that makes it refuse.

| Logic | Refusing test |
|---|---|
| `mcpCatalogEventSchema` – not a catalog kind, wrong category, not a catalog subject, E-04 not by a human | `packages/contract/src/mcp-event-catalog.test.ts` (#333). Until then the schema was used only as a positive oracle in `event-catalog.test.ts`, never seen to say no. |
| `leaderNamesItsOperation` (`mcp-journal.ts`) – a `leader` row without its operation id | `event-journal.test.ts:169`, `echo-guard.test.ts:122`, `event-catalog.test.ts:513` |
| The other `mcp-*.ts` files | Declarations only – no refinement, transform or function. Their shapes are pinned where they are parsed (the tool suites) and by `contract-parity*.test.ts` at compile time. |

The MCP routes in `server.ts`, file-level coverage being meaningless for two routes in a 5 600-line
file:

| Route | Test |
|---|---|
| `GET /api/v1/mcp/reference` (and its scoped alias) | `server/mcp-reference-route.test.ts`, `server/mcp-reference-route.unavailable.test.ts` |
| The stale-write check (`expectedVersion`) on every run-mutating route | `server/stale-write-routes.test.ts` – refused with nothing applied, a current version goes through, an absent one is the cockpit's unchanged path |

### 10.6 Exemptions and sequencing

**Exemption – `packages/xezar/src/mcp/api-reference.ts`, 77.3 % branches.** The five uncovered
branches (`api-reference.ts:75,99,106,133,135`) handle registry shapes no current tool has: a
guarded tool with no `action`/`view`/`read` discriminator, a listing with no `properties`, and a
refused argument whose description is not a string. `buildMcpApiReference` reads the real registry
and takes no tool list, so the only way to reach them is to fake the registry – a test of a tool
that does not exist. What holds the behaviour today: `mcp-reference-route.test.ts:110-160` pins
every current refusal and every guard against the live registry. **Ends when** a tool without a
discriminator declares `expectedVersion` or `operationId`, or `REFUSED_ARGUMENTS` names an argument
with no description: that PR reaches the branch with a real tool and adds the case.

**Exemption – `packages/xezar/src/mcp/adapters/codex.ts`, 75.5 % lines, 73.7 % branches.** Measured
2026-09-11 against #311's own diff (`gh pr diff 311`, whose base is this branch's `11a6df3`, so the line
numbers agree). 27 lines are uncovered, in two groups:

- **15 are deleted by #311** – `openCodexLeaderThread` and `CodexAppServerProcessLink`
  (`codex.ts:392-480`, `511`). A test for code that is leaving is the behaviour this rule exists to stop.
- **12 stay** – `dispose` (`167-168`), the thread filter and turn bookkeeping in `#observe`
  (`250-251`, `260`, `271-272`, `284`), the version suffix in `renderCodexEventMessage` (`311`), an
  already-aborted signal and a non-`Error` rejection in `abortable` (`485`, `496`), and the `turnId`
  fallback in `turnIdOf` (`505`). Real tests reach them, and they are not written here only because
  their home is `adapters/codex.test.ts`, which #311 rewrites: a second test file written now would be
  written blind to #311's version of those tests and would likely duplicate them.

What holds the behaviour today: `adapters/codex.test.ts` drives `#observe` for the leader's own
thread and `deliver` end to end; the real-client harness (10.4, last row) drives Codex itself.
**Ends when** #311 merges – re-measure on `main` and test the 12 kept lines in `codex.test.ts` (#338) –
or when #311 is closed unmerged, which ends it at once: then the whole file is tested as it stands.

**Corrected 2026-09-11: `service.ts` and `index.ts` were never "leaving".** An earlier version of this
section sequenced both after #311 on the claim that #311 rewrites the code their uncovered branches
sit in. #311's diff touches **none** of those lines: it adds a session observer to `service.ts` and
push-delivery wiring to `index.ts`, beside them. So they were tested instead of exempted
(`service-answers.test.ts`, each case red against a named break in #335), and both are above the
floor now. What was left uncovered in `service.ts` and why: the `closed` answer to `session/open`
(`service.ts:255-257`) goes to a connection that is already gone, so nothing can observe it; the
`String(err)` arms at `247` and `284` only change a log line; `chmod` failing after `listen`
(`124-125`) and an `lstat` error other than ENOENT (`151`) need a filesystem that fails on cue. In
`index.ts`, the unregistered-directory answer (`395`) is held by `cli.test.ts:199` in a child process
(10.4), and was not duplicated.

After #311 merges: re-run `npm run test:coverage:mcp` on `main` – #311 adds `leader-delivery.ts` and
`project-leaders.ts`, which have never been measured – close what remains with tests shown red, and
only then make the command a CI step.

### 10.7 Branches no real input reaches (found, not fixed – the source is frozen by #311)

- `tools/results-evidence.ts:467` – the "never end a text page inside a surrogate pair" guard
  cannot fire. A page end inside a pair costs 6 escaped bytes; completing the pair costs 4, so the
  bisection always prefers the whole pair. A test that pinned the property passed with the guard
  deleted, and was dropped rather than kept as coverage. Candidate for removal after #311.
- `tools/task-reads.ts:281-285` – `escapedBytes` prices raw control characters and lone surrogates,
  but its only input is `JSON.stringify` output, where both are already escaped to ASCII.

### 10.8 The release gate: Stryker over the MCP code

`npm run test:mutation:mcp` – StrykerJS 9.6.1 over `packages/xezar/src/mcp/**`, killed by the MCP
suites alone (`packages/xezar/vitest.mutation.config.ts`, the same files 10.1 measures). It is a
**release** gate: the `release` and `release-prep` workflows run it as their first check step, before
anything is authored, and the manual dispatch path in [publishing.md](../publishing.md) says to run
it by hand. It is in no per-PR gate, in `npm test` or in CI – see the cost below. Config and its
reasons: `packages/xezar/stryker.config.mjs`.

**Measured, 2026-09-12, revision `ac726df` on an 18-core macOS laptop shared with other tasks, concurrency 4.**

| | |
|---|---|
| Mutants generated | 12 530 |
| Ignored as static (`ignoreStatic`) | 1 238 |
| Tested | 11 292 |
| Killed / timed out / survived / no coverage / errors | 7 928 / 1 261 / 1 426 / 675 / 2 |
| **Mutation score** | **81.39 %** (86.57 % over covered code) |
| Wall clock | 3 h 40 min (220 min), dry run 43 s |
| Tests per mutant | 19.2 on average |

`thresholds.break` is **80**, the same number as the coverage floor and for the same reason: it is a
floor, not a target. The measured 81.39 % clears it by 1.39 points, which is thin on purpose – the
survivors in #338 are what raises it.

**Four things this gate does not tell you, and the fifth it tells you wrong if you forget it:**

1. **The score is whole-scope, not per file.** Unlike the coverage floor, Stryker's `break` is one
   number for the run. Per file the spread is wide today: `adapters/` 64.3 % (claude-code 67.3,
   codex 63.5, opencode 62.1 – all #311's files), `operation-receipts.ts` 66.5, `event-controller.ts`
   69.6, `service.ts` 75.6, `index.ts` 76.6, against `project-catalogs.ts` and `tool.ts` at 100. A
   per-file mutation floor would fail today; adopting one is a decision, not a tightening (#338).
2. **A timeout counts as detected.** 1 261 of the 9 189 "detected" mutants are timeouts, and a busy
   machine produces more of them – the same run on an idle machine scores slightly lower, not
   higher. Read a score near the floor with the machine's load in mind before blaming a PR.
3. **675 mutants have no coverage at all.** They are counted in the score (as not detected), and
   they are where the coverage floor and this gate say the same thing twice.
4. **Static mutants are not measured.** 1 238 of them – module-level tables, regexes and schema
   declarations – would need all 932 MCP tests each, which is what made the first attempt a ~60-hour
   run. What they would have measured is pinned where the value is used (10.5).
5. **It measures the MCP suites only.** A mutant killed by a suite v8 cannot see (10.4) still counts
   as survived here, because this run does not execute those suites. Check 10.4 before writing a
   vitest test for a survivor.

The survivors are listed in **#338**, not here: this section records the method and its cost, and the
run's own HTML/JSON report (`.local/mutation/mcp/`) is the list. The three survivors that could have
shipped a secret leak, a world-readable connection file or an unreadable-worktree ownership pass were
#337, closed in #335.
