# Test-coverage gap analysis

> **History – removed in 0.30.0.** The pi and OpenCode backends named on this page were removed in 0.30.0 ([#1041](https://github.com/qodeca/xezar/issues/1041)). Those mentions record the product as it was, not current behaviour.

Date: 2026-09-09, measurements refreshed 2026-09-10. Branch: `feature/coverage-gap-audit`, then
`feature/coverage-16-files`. Commit originally audited: `e437c24`.

**Re-measured 2026-10-19** at `79b7361` (branch `fix/mutation-nightly`, off `develop` at
`5a31cf0`): the suite sizes in section 2, the directory sweep in 3.6 and every number in section 4,
including the Qwen Code backend rows. The ranking in section 5 was not re-audited.

The pi and OpenCode backends were removed later (#1046). The live inventory rows below were
updated for that, and the closed gap entry about the removed OpenCode runner (R16) was cut. Dated
measurement tables that still name pi or OpenCode files record the code as it was measured: their
totals include those files, so the rows stay, and those files no longer exist.

This document ranks xezar's regression risk by **behaviour**, not by file. Measured coverage
appears in section 4 as supporting evidence only – it never drives the ranking. A behaviour that
no gate protects outranks a behaviour that a suite covers but CI never runs, and both outrank a
file with a low percentage that nothing depends on.

**Section numbers are labels, not a sequence.** There is no section 8 and no 10.7, 10.8 or 10.13:
they were removed, and the rest were not renumbered because code and other documents cite sections
by number (§ 10.12 in `ci.yml`). 10.8 and 10.13 described the nightly mutation gate, which the
owner removed from the project on 2026-10-27; their text is in the git history of this file.
For how to run each suite, see the [testing index](README.md).

**How to read the evidence.** Claims marked *measured* come from a command that was run or a test
file that was opened and read. Claims marked *inferred* are judgements about likelihood and blast
radius – second-guess those freely. Absence is scoped: "no test found for X in the suites
examined" means the seven suites listed in section 2 were searched, not that X is untested in some
absolute sense.

---

## 1. Lessons from the closed risks

The three risks this audit opened with are closed (#60/#128, #120, #43/#62). Their lessons stay:

- **A suite whose skip path exits 0 must be gated on its own success marker, never on its exit code.**
- **A new workspace package needs a line in the root `projects` list, or its tests are decoration.**
- **A file at 0 % that CI exercises through a subprocess looks identical to a file nothing tests** – `index.ts` is the example.

---

## 2. What "the suites" means

File counts re-counted on `79b7361`, 2026-10-19 (the 2026-09-15 count at `bb271fc` read 272, 173,
2, 4, 14 and 5). A spot check at `00b37e6d` (2026-10-23) found 470 server and 210 cockpit test
files; every other row was unchanged. The table keeps the 2026-10-19 numbers so it stays one dated
measurement.

| Suite | Command | Runner | Runs in CI? | Size (measured) |
|---|---|---|---|---|
| Server unit | `npm test` (project `server`) | vitest, node env | yes | 454 `*.test.ts` under `packages/xezar/src` |
| Cockpit unit | `npm test` (project `web`) | vitest, jsdom | yes | 204 `*.test.ts(x)` under `packages/web/src` |
| Api-client unit | `npm test` (project `api-client`) | vitest, node env | yes | 2 files |
| Contract unit | `npm test` (project `contract`) | vitest, node env | yes | 9 files |
| node:test core | `npm run test:unit` | node:test | yes | 20 files, `packages/xezar/test/unit/` |
| Packaged CLI e2e | `npm run test:package` | node:test | yes | 8 files, `packages/xezar/test/e2e/` |
| Browser e2e | `npm run test:e2e` | vitest + agent-browser + real Chrome | yes – its own `ui-e2e` job (#128) | 67 files, `packages/web/e2e/` (re-counted 2026-10-19) |
| Manual QA | `needs-qa` label | human | n/a | the QA gate |
| Design review | `needs-design` label + `## Design review` comment | design reviewer | n/a | the design gate |

One structural note that changes how the tables below read: the six `contract-parity*.test.ts`
files and `typed-bodies.test.ts` are **compile-time checks**, not runtime tests. Each contains a
single `it()` whose only job is to keep the file visible; the real assertion is a conditional type
resolved by `npm run typecheck`. They prove a declared response *shape* matches the contract
package. They never call a handler, so they are not evidence that a route behaves correctly.

---

## 3. Behaviour inventory

Derived from the `AGENTS.md` task-routing table, the 29 chained route families in
`packages/xezar/src/server/server.ts`, the cockpit routes in `packages/web/src/routes.tsx`, the CLI
dispatch in the `switch (command)` in `packages/xezar/src/index.ts`, and the run lifecycle in
`packages/xezar/src/workflows/run.ts`.

Status key: **C** covered, **P** partially covered, **N** no test found in the suites examined,
**X** not testable here (with reason).

### 3.1 CLI journeys (`packages/xezar/src/index.ts`)

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| `--version` / `-v` prints bare version, works outside a git repo | node:test | `test/unit/cli-version.test.ts:36,45,62` | C |
| `--help` lists commands and flags | node:test | `test/unit/cli-version.test.ts:68` | C |
| `run "<task>"` executes a workflow headless, exits 0 on `done` and `review` | packaged e2e | `test/e2e/package-cli.test.ts` | C |
| `run` refuses a disabled or unauthenticated provider | packaged e2e | `test/e2e/package-cli.test.ts` | C |
| `projects list/add/remove/tag` | packaged e2e + server unit | `test/e2e/package-cli.test.ts`; `src/workspace/projects-cli.test.ts:16,234` | C |
| `server-install` (platforms, flags, unknown platform) | packaged e2e | `test/e2e/package-cli.test.ts` | C |
| `server-uninstall` | packaged e2e | `test/e2e/package-cli.test.ts` | C |
| `init` scaffolds `.xezar/` and never overwrites | server unit | `project-kit-cli.test.ts:20,29` — spawns the real CLI and asserts both halves | C |
| `serve` boots: port auto-pick, orphan-worktree prune, `.local/.gitignore` upkeep | packaged CLI e2e | `test/e2e/package-cli.test.ts` boots the default command against the installed tarball (#43). `test:server-mode` additionally exercises the built CLI with `--repo`, `--bind-host`, `--no-open` and OS-assigned ports | C |
| `server-deploy` | packaged e2e | `test/e2e/package-cli.test.ts` — help text, a real `--platform ubuntu --yes` invocation, and the unknown-platform exit 1 (#56) | C |
| **unknown command → exit 1 + help** | packaged e2e | `test/e2e/package-audit.test.ts:122` spawns `no-such-command` from the packed tarball and asserts it writes no audit record; neither the exit code nor the help text is asserted | **P** |
| `mcp` bridge subcommand | server unit (child process) | `src/mcp/cli.test.ts` | C |
| npm package surface: bins, `exports`, tarball contents | packaged e2e + build | `test/e2e/package-exports.test.ts`; `scripts/check-pack.mjs` via `npm run build` | C |

### 3.2 HTTP API – 29 route families, plus four cross-cutting concerns (`packages/xezar/src/server/server.ts`)

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
| WebSocket bus `/api/v1/ws` | server unit | `ws.test.ts` (hub, local upgrade controls, hosted real-socket refusal); authenticated proxy composition in `test:server-mode` — see mode × transport matrix | C |
| Agent quota read side (`GET /workspace/agent-quota`, MCP `read_quota`, WS topic, SSE hint) | server unit + contract/type checks | `server/agent-quota-api.test.ts`, `workspace/agent-quota.test.ts`, `mcp/tools/project-config.test.ts`, `contract-parity.workspace.test.ts`, `typed-bodies.test.ts` | C for deterministic fixtures; **P** for a live dry-run-stream failure mark and an installed-host MCP bridge read |
| Route registration and alias parity | server unit | `route-parity.test.ts:158,206,215`; `versioned-surface.test.ts:93,108` (the `BACKWARD_COMPATIBILITY.md` §2 inventory guard `bc-route-inventory.test.ts` was removed with the route inventory in #949) | C |
| Contract ↔ route shape agreement | typecheck | `contract-parity*.test.ts`, `typed-bodies.test.ts` – compile-time only | C (types), N (behaviour) |
| MCP reference (`mcpReferenceRoutes`) | server unit | `server/mcp-reference-route.test.ts`, `server/mcp-reference-route.unavailable.test.ts` (see 10.5) | C |
| MCP leader (`mcpLeaderRoutes`) | server unit | `server/mcp-leader-topic.test.ts`, `mcp/push-delivery.test.ts` | C |
| Two-project product composition (registry, lazy contexts, route aliases, workspace cap, runs index, SSE stamping, disposal/re-add) wired together in one built cockpit | saved deterministic harness, not a unit suite | `scripts/multi-project-harness.mjs` (`npm run test:multi-project`), unit-level PID-ownership coverage at `test/unit/multi-project-harness.test.ts`; see `docs/testing/multi-project-harness.md` | C, including cross-project MCP – since #557 (closed 2026-09-18) a project registered after boot gets its own MCP socket, and the harness asserts that B's door answers as B, stops answering once B is removed, and answers again after B is re-added (`multi-project-harness.md` § B's MCP door) |
| The `serve` wiring that gives `followProjectDoors` its real lifecycle (`index.ts`'s `onContexts` hook opens each late-built project's own MCP socket through `open`, and shutdown closes every door) (#557) | saved deterministic harness, not a unit suite | `scripts/multi-project-harness.mjs` (`npm run test:multi-project`) is the only suite that exercises this wiring; the lifecycle itself (build/dispose ordering, retiring, `onOpened`) is unit-tested in `mcp/project-doors.test.ts` | C — run in CI by the `multi-project` job in `.github/workflows/ci.yml` (12-minute bound; runtime ceiling stated in `docs/testing/multi-project-harness.md`) |
| A late-built project B's runs join the cross-project runs index AND the one open workspace SSE stream (each stamped with B's own project id) without disturbing project A; removing B tears its context down (index drops B's row, its route 404s, A's own rows and stream keep flowing); re-adding B on the same slug rebuilds a fresh store whose events resume on the SAME already-open stream rather than being silently swallowed by a stale attach entry | server unit, in-process (not the saved harness above, which only smoke-tests wiring) | `server/multi-project-composition.test.ts` — one route-level A/B lifecycle test; red-proved by removing the stream's `project-removed` detach/unsubscribe step, which makes the re-added B's events vanish instead of arriving | C |
| A project id re-registered against a DIFFERENT root outside the removal route (a second process, a hand-edited `~/.xezar/config.json`, a test seeding the registry directly) resolves the NEXT scoped request to the current root, not the cached one — found live by the QA of PR #589 (case E) as an `ENOENT` under the old, deleted `dataDir` | server unit, in-process | `server/project-context-registry-drift.test.ts` — reuses the same slug across two different roots (no removal route call in between); red-proved by reverting `project-context.ts`'s on-access registry re-check, which serves the old, deleted root instead of the new one (#591) | C |
| A registry read with no information — an empty result for this id, or a rejected/throwing `listProjects()` (a transient permissions failure, a dropped network mount, fd exhaustion) — is never treated as "the root moved": the cached context keeps serving instead of being disposed on a project that never actually changed root — PR #592 review round 1, Blocker 1 | server unit, in-process | `server/project-context.test.ts` — "a registry read with no information … never disposes the cached context"; red-proved by reverting `project-context.ts`'s drift check, which disposes on an empty/rejected read the same as a positive move | C |
| A registry root drift with runs this process is actively responsible for keeps serving the cached context (never strands the run past `cancel()`), logs exactly one warning naming the id and both roots, and rebuilds only once nothing is active — the removal route's own running-tasks 409 guard's precedent — PR #592 review round 1, Major 2 | server unit, in-process | `server/project-context.test.ts` — "does not dispose a cached context with active runs … warns once, rebuilds once idle"; red-proved by reverting the same drift check | C |
| A drift rebuild (no removal route involved) is announced through the same `onContextDisposed` hook the removal route already fires, so an already-open `/api/v1/workspace/events` stream re-attaches to the new store instead of going deaf for that project — PR #592 review round 1, Major 1 | server unit, in-process | `server/workspace-events.test.ts` — "an out-of-band drift rebuild (no removal route involved) resumes flowing on an already-open stream"; red-proved by reverting the SSE stream's and automation coordinator's `onContextDisposed` subscriptions in `server.ts` (times out waiting for the new root's event) | C |
| Several concurrent drift detections against the same stale cache hit share ONE dispose+rebuild instead of each independently disposing and bumping the generation counter under the others, which used to 404 a project that exists — PR #592 review round 1, Minor 1 | server unit, in-process | `server/project-context.test.ts` — "several concurrent drift detections share ONE dispose+rebuild, never a spurious 404"; red-proved by reverting the single-flight check in `context()` | C |

### 3.3 Cockpit journeys (`packages/web/src/routes.tsx`)

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| Tasks overview row order; navigation-only sidebar (#546) | cockpit unit + browser e2e | `routes/tasks-overview.test.tsx:130`; `components/app-shell.test.tsx:646`, `components/project-groups.test.tsx:110`; `e2e/tasks-table.e2e.ts:218,285`; sidebar width in `e2e/sidebar-resize.e2e.ts:60` | C |
| New task: compose, pick skill/workflow, submit | cockpit unit + browser e2e | `routes/new-task.test.tsx:402`; `e2e/new-task.e2e.ts:236` | C |
| Task thread rendering, markdown, scroll | cockpit unit + browser e2e | `routes/task-thread/task-thread.test.tsx:138`; `e2e/task-thread.e2e.ts:128` | C |
| Changes tab (tree, per-file ±) | cockpit unit + browser e2e | `routes/task-git/task-changes.test.tsx:154` | C |
| Files tab | cockpit unit + browser e2e | `routes/task-git/task-files.test.tsx:119` | C |
| Commits tab (`/tasks/:id/commits[/:sha]`) | cockpit unit + browser e2e | `routes/task-git/task-commits.test.tsx:142-295` mounts the route (list, deep link, 409 reason, empty, loading) since #49; `e2e/commit-list.e2e.ts:166,174` exercises `CommitList` virtualization | C |
| Variant compare and pick | cockpit unit + browser e2e | `routes/compare-variants.test.tsx:121`; `e2e/variants-compare.e2e.ts:193` | C |
| Repo git tabs (diff, commits, branches) | cockpit unit + browser e2e | `routes/repo-git/repo-git.test.tsx:150`; `e2e/repo-git.e2e.ts:54` | C |
| GitHub issues and PRs | cockpit unit + browser e2e | `routes/github/github.test.tsx:302`; `e2e/github.e2e.ts:78` | C |
| **Automations (create, preview, enable, log)** | cockpit unit, both states; browser e2e, both states | `routes/automations/automations.test.tsx:227-421` runs the enabled flow ungated (#48); `routes.test.tsx:355-374` the disabled one; `e2e/automations.e2e.ts` asserts the disabled state on the shared server; `e2e/guide-07-github-automations.e2e.ts` boots its own `XEZ_AUTOMATIONS=1` fixture and runs the create → enable → log journey unconditionally, through role/label locators. Its always-skipped enabled case was **deleted** in the 2026-10-24 cleanup (WP13b), not moved: guide-07 proves the same journey, and its one extra step, the preview check, cannot run in a browser spec – the check searches GitHub through `gh`, which the dry-run forge does not mock, so a fixture answers `error` without a signed-in `gh`. Preview stays unit-pinned (`automations.test.tsx:386-421`) | C |
| Skills catalog page | cockpit unit + browser e2e | `routes/skills.test.tsx:151`; `e2e/settings-skills.e2e.ts:66`; `e2e/guide-06-skills.e2e.ts` (browse/open a project skill and Refresh, plus the global auto-update switch, through role/label locators) | C |
| Inbox | cockpit unit + browser e2e, both states | `routes/inbox.test.tsx:224`; `e2e/inbox.e2e.ts` asserts the disabled state on the shared server and, since the 2026-10-24 cleanup (WP13b), **moved** its always-skipped enabled cases (empty state, live cards with their meta row and actions, Dismiss agreed by the server) onto its own `XEZ_FOLLOWUPS=1` fixture (`bootFixtureServer({ env })`), so they run on every `test:e2e`; the live nav-badge case moved there too from `e2e/smoke.e2e.ts` (the SSE file-watch → badge proof, which guide-08 does not cover). `e2e/guide-08-inbox-notifications.e2e.ts` boots its own fixture and runs the disabled message plus Run/Dismiss/Acknowledge through role locators | C |
| Workflows builder | cockpit unit + browser e2e | `routes/workflows/workflows.test.tsx:118`; `e2e/workflows.e2e.ts:89`; `e2e/guide-05-workflows.e2e.ts` (a saved workflow's own `/workflows/:name` deep link, and a real end-to-end run proving the step rail advances through both agent steps) | C |
| Settings, project and global scopes | cockpit unit + browser e2e | `routes/settings/settings.test.tsx:164,271`; every project and global section's own heading, in `e2e/guide-10-settings.e2e.ts`; the Project setup / Worktrees / Branches sections, in `e2e/guide-01-getting-started.e2e.ts` and `e2e/guide-03-worktrees-and-git.e2e.ts` | C |
| Guide 02 flow contract (compose, mode toggles, queueing, thread output, Finish/review, Changes/Files/Commits, Draft PR/Accept hand-off, actions/notes — Archive/Unarchive, Open in…, Notes, Continue) | browser e2e, one file, semantic role/label/text locators only | `e2e/guide-browser.ts` (the shared helper); `e2e/guide-02-running-a-task.e2e.ts` — its own header names the one guide-02 flow (opening a real draft PR) this file does not honestly dry-run test and the lower tests that cover it instead | C |
| User-guide flow contracts (guides 01, 03, 05–08 — getting started incl. guided setup, worktrees/Git incl. the non-Git fallback, workflows, skills, GitHub/automations, inbox) | browser e2e, one file per guide, semantic role/label/text locators only | `e2e/guide-browser.ts` (the shared helper); `e2e/guide-01-getting-started.e2e.ts`, `guide-03-worktrees-and-git.e2e.ts`, `guide-05-workflows.e2e.ts`, `guide-06-skills.e2e.ts`, `guide-07-github-automations.e2e.ts`, `guide-08-inbox-notifications.e2e.ts`; each file's own header names the guide flows it is not honestly dry-run testable and the lower-level test that covers them instead. Guide 09 has no new file: `e2e/project-switching.e2e.ts` already proves its one browser-only journey, and its remaining flows (tags, Max parallel, Add project) are settings-only mutations already covered at jsdom level | C |
| User-guide flow contracts (guides 04, 10–16 — providers/models/tools, settings, zero-config defaults, CLI/mcp cross-check, MCP leader connection, local vs. hosted, project kit, troubleshooting) | browser e2e, one file per guide, semantic role/label/text locators only | `e2e/guide-browser.ts` (the shared helper); `e2e/guide-04-providers-models-tools.e2e.ts`, `guide-10-settings.e2e.ts`, `guide-11-configuration.e2e.ts`, `guide-12-cli-reference.e2e.ts`, `guide-13-mcp-leader-control.e2e.ts`, `guide-14-local-hosted.e2e.ts`, `guide-15-project-kit.e2e.ts`, `guide-16-troubleshooting.e2e.ts`; each file's own header names the guide flows it is not honestly dry-run testable and the lower-level test that covers them instead | C |
| Guide 17 audit trail | lower-level tests; no browser e2e because the guide has no cockpit page | `docs/testing/browser-dry-run-exceptions.md` records the audit-trail classification and its named audit tests | C |
| Screenshot-state visible facts (browser-test-spec.md "PR 4 — screenshot-state contract, after Batch 8", Refs #549): 20 manifest states (`settings-projects` joined in 0.16.0, #453 B8) — each asserted by role/label/text, no pixel comparison | browser e2e, sharing the capture harness's own preparation | `e2e/capture/scenario-state.ts` (`SCENARIOS`, the per-state preparation AND its visible-fact assertions, shared verbatim with `e2e/capture/docs-screenshots.capture.ts`); `e2e/screenshot-states.e2e.ts` is the thin consumer — one scenario call per state per distinct width its manifest entry lists, never a screenshot | C |
| **Whole `npm run test:e2e` suite passing in shuffled order** | browser e2e | Measured 2026-09-20 (PR-549-D) at head `fee89d0c`, `vitest --sequence.shuffle --sequence.seed=482917365`: **23 of 66 files order-dependent** (46 of 459 tests), up from the ~19–20 estimated before #730/#731/#745/#746 landed — those PRs rebuilt waits in nine files but did not close the shuffle gap suite-wide. Failing files, each with its first failing assertion in the table at `docs/testing/agent-browser.md` § Recorded runs (not duplicated here) and the full log at `.local/xezar/tasks/700f23bf-97bd-4913-88b8-b4a18f1f6e39/runs/shuffled-1.log`: `settings-bookmarklets.e2e.ts`, `queued-stack.e2e.ts`, `plan-mode.e2e.ts`, `task-files.e2e.ts`, `settings-appearance.e2e.ts`, `thread-scroll.e2e.ts`, `task-thread.e2e.ts`, `variants-compare.e2e.ts`, `mcp-collaboration.e2e.ts`, `tools-menu.e2e.ts`, `settings-agents.e2e.ts`, `guide-02-running-a-task.e2e.ts`, `composer.e2e.ts`, `progressive-history.e2e.ts`, `commit-list.e2e.ts`, `review-gate.e2e.ts`, `new-task.e2e.ts`, `single-project.e2e.ts`, `workflows.e2e.ts`, `guide-01-getting-started.e2e.ts`, `diff-scroll.e2e.ts`, `skills-update.e2e.ts`, `task-changes.e2e.ts`. All 23 are pre-existing files outside this guide-flow package's authority (two of them, `guide-01` and `guide-02`, are guide files that already ship, not new PR-549 work); per the owner's 2026-09-20 21:02 rule a named red file is evidence for #671, never retried, widened or fixed here. Default-order proof for this package remains as recorded: each new file alone, the new files together in shuffled order, and the whole suite in default order — recorded in `.local/xezar-tasks/7d26c8f0-31e4-4831-9236-d709fe8f68dc/evidence/BLOCKED` and `evidence/existing-suite-shuffled-same-seed.log` (primary checkout); see also `docs/testing/agent-browser.md` § Recorded runs, where two of three default-order runs at this same head also came back red (`skills-update.e2e.ts`, `guide-03-worktrees-and-git.e2e.ts`), so the three-green half of AC-5 is not met either | **P** |
| Project scope, `/p/default` alias, legacy redirects, 404 | cockpit unit | `routes.test.tsx:271,636-731` | C |
| Clicking from one registered project into another (outlet remount resets mount-time page state, e.g. the Tasks search filter, and fetches the destination's own `/api/v1/p/<id>` routes, with no reload); a cross-project task opened from the workspace-wide All tasks page lands at its OWNER project even when a different one is active; a registered project whose folder is gone stays listed, inert, and never expands | cockpit unit + browser e2e | `routes.test.tsx:292` ("remounts the same page and loads its new scope when the project param changes"); `e2e/project-groups.e2e.ts:216-368` (grouping, per-group nav scoping, collapse); `e2e/project-switching.e2e.ts` (the actual A→B click, the cross-project All-tasks jump, and the missing-folder row, in one real browser session) | C |
| Bookmarklet grammar, launch key never in the DOM | cockpit unit | `routes.test.tsx:763-767` | C |
| SSE cache patching, multi-project scoping, reconnect | cockpit unit | `api/global-events.test.tsx:252,373,652,724,746` | C |
| WebSocket topic bus, ref-counting, watchdog | cockpit unit | `api/ws.test.ts:92,106,188,236` | C |
| Design-system rules (no raw hex, no `dark:`, no `100vh`, no hand-typed spacing px) | cockpit unit | `design-guardian.test.ts` | C |
| Bundle chunking config | cockpit unit | `vite-config.test.ts` | C |
| The e2e suite's one-worker pin, and its deletion of `VITEST_MAX_WORKERS` | cockpit unit | `e2e-file-parallelism.test.ts` — one case per half: the env var is neutralized, and `fileParallelism: false` still states the intent declaratively | C |
| Task-table Tool Name / Model columns (recorded vs inherited, verbatim model, mixed-chain `+N`, the phone card) | cockpit unit | `lib/runner-label.test.ts`; `routes/tasks-overview.test.tsx` (the "Tool Name and Model columns" describe); `routes/global-tasks.test.tsx` (same describe) | C |
| Per-project table reads the PROJECT config, not health's boot-project answer | cockpit unit | `routes/tasks-overview.test.tsx` — "takes the Tool column's default runner from the PROJECT config, not from health" | C |
| Test worker cap (`maxWorkers`, node:test concurrency) | server unit | `test-concurrency-cap.test.ts` (#1187) pins the wiring, not timing: `scripts/test-concurrency.mjs` resolves `min(4, availableParallelism() - 1)`, the root and every package `vitest.config.ts` declare it (stepping aside for a command-line `--maxWorkers`), and `test:unit` / `test:package` start through `scripts/node-test.mjs`. The cap is a deliberate no-op on CI, which is why a wiring guard is the only useful one | C |
| App shell boot (`main.tsx`) | cockpit unit | `app.test.tsx:175-270` pins the provider stack, the routed outlet, one SSE stream, one health subscription and the error boundary (#50). `main.tsx` is now wiring only: its API-base precedence lives in `api/api-base.ts` (`api/api-base.test.ts`) and its missing-`#root` throw in `root-container.ts` (`root-container.test.ts`) | C |

### 3.4 Run and workflow lifecycle

| Behaviour | Suite | Strongest evidence | Status |
|---|---|---|---|
| queued → running under the workspace cap | server unit | `workflows/run-lease.test.ts:180`, `workspace-semaphore.test.ts:134` | C |
| running → review (gate on, non-autonomous, changes) | server unit | `workflows/run.test.ts` | C |
| running → done (gate off, or no changes) | server unit | `workflows/run.test.ts` | C |
| worktree creation fails → run marked `failed` before any step | server unit | `workflows/run-isolation.test.ts:55-69` | C |
| `XEZ:MONITORING` parks the run; wake timer and operator wake | server unit | `workflows/run.test.ts`; `runs/store.test.ts:179,195` | C |
| `runContinuation` keeps step tools (the second `ActiveRun` site) | server unit | `workflows/continuation-tools.test.ts:50` | C |
| `maxParallel` across projects, and `refresh()` raising it | server unit | `workspace-semaphore.test.ts:134,264,475` | C |
| Message delivery into a live run | server unit (indirect) | `workflows/run.test.ts`; no direct unit test of `deliverMessage` by name | C |
| Autonomous nudge actually delivered at turn end | server unit | `run-autonomous-nudge.test.ts` asserts delivery from BOTH `ActiveRun` sites (`execute` and `runContinuation`) since #59, closing the asymmetry with its twin `MONITORING_WAKE_NUDGE` at `run.test.ts:1005-1021`; `recover-autonomous.test.ts:27-83` covers the recovered flag; `run-continue-nudge-cap.test.ts` pins the #613 bounds (the 3-re-prompt cap of a Continue-gated turn and the idle-turn stop at both sites) | C |
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
| Every backend emits every parity capability | server unit | `core/ui-parity.test.ts`, `BACKENDS = ['claude','codex','qwen']` | C |
| Golden-fixture mapping per backend | server unit | `core/__fixtures__/{claude,codex,qwen}/*.expected.json` replayed by the three `*-ui-mapper.test.ts` | C |
| api-client protocol mirror stays type-exact | server unit | `server/api-types.test.ts` | C |
| Claude runner teardown | server unit | `claude-cli-runner.test.ts:92` (stub script that ignores EOF) | C |
| Codex runner against a mock app-server | server unit | `codex-app-server-runner.test.ts:31` + `mock-codex-app-server.mjs` | C |
| `createRunner` dispatch for claude / codex / qwen | server unit | `core/runner-factory.test.ts:52,60,85` — one case per `RUNNER_IDS` entry, none served by the default arm — plus the unknown id and legacy `claude-cli` at `:98,104,123,154` (#54) | C |
| `detectEnvironment` probes for claude / codex / qwen / gh / git | server unit | `core/backend-detect.test.ts:115-131` (each CLI by name and version), `:141-155` (each with a timeout), `:176-207` (missing / non-zero, parameterised over every probed binary) (#45) | C |
| `probeCodex` honours `XEZ_DRY_RUN=1` and never spawns the real binary | server unit | `core/backend-detect.test.ts` "the XEZ_DRY_RUN short-circuit" — codex case (#549), same seam as the existing claude case | C |
| A `128 + signal` exit the runner did NOT cause names its signal | server unit | `claude-cli-runner.test.ts` (#156) — the other half of `terminatedByXezar`, contract in AGENT_PROTOCOL.md | C |
| **Shared read-only command refusals through real runner processes (#863)** | shared module + adapter fixtures only | `core/read-only-lock.test.ts` drives every refusal class and argument-table row; `qwen-tool-policy.test.ts` and `codex-read-only-hook.test.ts` cover the Qwen Code and Codex adapters; `claude-cli-runner.test.ts` pins `--setting-sources user` only on read-only argv. **Not covered:** a real model tool call for each refusal class, or a real `claude -p` run proving a project `permissions.allow: ["Bash"]` is excluded by `--setting-sources user`; independent live QA is required | P |
| A task-spawned claude client never receives the project's `xezar` MCP bridge entry, and a broken or absent MCP config never stops the run | server unit | `core/worktree-off-mcp-isolation.test.ts` (#342, MP-11) — the seam case asserts the actual launch input the CLI is given (claude argv `--strict-mcp-config` + overlay); the control cases pin `run-mcp-isolation.ts` (other project servers survive, absent ≠ unreadable, the note never names a bridge nobody declared). Qwen Code's own MCP isolation is pinned in `qwen-runner.test.ts`. **Not covered: any live multi-client reproduction** | P |
| Qwen Code runner: time limit, result errors, tool results and images (measured 2026-10-19) | server unit | `core/qwen-runner.test.ts` drives `startSession` against `__fixtures__/qwen/stub-qwen.mjs`; the hook-refusal and permission-denied fixtures are replayed through `qwen-ui-mapper.test.ts` only. **Not covered in the runner:** the step time limit (`runAll`'s deadline: SIGTERM, SIGKILL after the grace, the "timed out after Nm" result), the message chosen for an `is_error` result, the runner's own handling of `tool_result` messages (the tool-result event, the #941 refusal note, images inside a tool result), image input (`writeImage`), `@path` escaping for a path with a space, and the one-shot `run()`/`interrupt()` entry points – line ranges in section 4 | P |

### 3.6 Directory sweep – nothing silently absent

Every top-level source directory in both large workspaces, with its measured coverage and where it
appears above. Measured 2026-10-19 at `79b7361` (section 4); source files only – the `*.testkit.ts`
helpers and JSON data the report now also carries are left out of every row.

| Directory | Lines | Branches | Covered in inventory |
|---|---|---|---|
| `packages/xezar/src/` (loose files) | 93.8 % | 85.0 % | 3.1, 3.4, and gaps R8, R19 |
| `packages/xezar/src/agent-config/` | 94.6 % | 80.8 % | 3.2 (agent-config family) |
| `packages/xezar/src/automations/` | 93.4 % | 76.7 % | 3.2 (automations family) |
| `packages/xezar/src/mcp/` | 97.7 % | 88.1 % | MCP-only floor measured separately (10.11, 10.12) |
| `packages/xezar/src/core/` | 94.0 % | 82.7 % | 3.5 |
| `packages/xezar/src/onboarding/` | 99.5 % | 94.0 % | **Not in the inventory** – added after the audit (#464: the onboarding record, leader setup, issue filing); its own co-located tests only |
| `packages/xezar/src/platform/` | 92.2 % | 87.6 % | **Not in the inventory** – added after the audit (#963); guarded by `posix-literal-scan.test.ts` and `process-spawn-scan.test.ts`. Measured on macOS: a Windows-only branch counts only where a test passes the helpers' `platform` parameter |
| `packages/xezar/src/release/` | 95.5 % | 90.9 % | 3.1 (npm package surface) + `test/e2e/release.test.ts` |
| `packages/xezar/src/runs/` | 95.8 % | 88.6 % | 3.4 |
| `packages/xezar/src/server/` | 93.8 % | 83.8 % | 3.2 |
| `packages/xezar/src/server-install/` | 89.6 % | 79.4 % | 3.1, gap R17 |
| `packages/xezar/src/terminal/` | 94.0 % | 81.5 % | **Not in the inventory** – added after the audit (#467: the `serve` activity output on stderr); its own co-located tests only |
| `packages/xezar/src/workflows/` | 95.7 % | 88.0 % | 3.4, gap R7 |
| `packages/xezar/src/workspace/` | 96.0 % | 89.7 % | 3.2 (projects, workspace config) |
| `packages/xezar/src/__fixtures__/` | – | – | **Excluded**: golden JSON data, no executable code |
| `packages/web/src/api/` | 96.2 % | 84.5 % | 3.3 (live updates) |
| `packages/web/src/components/` | 95.7 % | 88.3 % | 3.3 |
| `packages/web/src/lib/` | 98.9 % | 94.7 % | 3.3 |
| `packages/web/src/routes/` | 94.0 % | 86.6 % | 3.3 |
| `packages/web/src/` (loose files) | 100 % | 98.2 % | 3.3 (`app.tsx`, `routes.tsx`; `main.tsx` is absent from the report, but its logic moved to tested modules — see R11) |
| `packages/web/src/assets/` | – | – | **Excluded**: static image assets, no executable code |
| `packages/web/src/styles/` | – | – | **Excluded**: one CSS file, no executable code |
| `packages/contract/src/` | 99.0 % | 92.7 % | Risk 2, gap R2 |
| `packages/api-client/src/` | 100 % | 95.8 % | 3.2, 3.5 (protocol mirror) |

---

## 4. Measured coverage – evidence, not ranking

Command: `npm run test:coverage -- --coverage.reportOnFailure`. Provider `v8`, reporters `text` and
`json-summary`, output under `.local/coverage/` per `docs/testing/local-data.md:75`. **Re-measured
2026-10-19** at `79b7361` (branch `fix/mutation-nightly` off `develop` at `5a31cf0`) on an 18-core
macOS laptop, run alone in the foreground: exit code 0, 664 test files passed and 6 skipped, 13 356
tests passed, 7 min 31 s. One caveat on the tree: run from a worktree, the Qwen Code tests fail on
macOS's 104-byte socket path limit, so the fix for that (`ce4551c4`, on `fix/test-hardening`,
`platform/socket-dir.ts`) was applied for the run and taken out again. The numbers below are
therefore the tree with that fix in – from a checkout with a short path the Qwen Code tests pass
without it (*inferred*: the limit is about the path's length) – and the fix's own file,
`socket-dir.ts` (4 lines), is one of the 27 `platform/` files. `--coverage.reportOnFailure` only
makes sure a red test would still leave a report; none was red. The workspace table and the file
table carry these numbers ONLY — two snapshots in one table get quoted interchangeably — while
section 5's closed rows (now in git history) kept the `e437c24` value beside each row, because there the movement was the point. The
previous snapshot was 2026-09-10, on `feature/coverage-16-files`, after the sixteen-file pass
described below: 93.7 % lines and 84.7 % branches over 363 files.

**Scope limit, and it matters.** The run measures only what `npm test` executes – the four vitest
projects. It does **not** measure `npm run test:unit` (node:test), `npm run test:package`
(packaged CLI) or `npm run test:e2e` (browser). A file the packaged-CLI suite exercises still reads
as 0 % here, and a file no suite touches also reads as 0 %. The report cannot tell those two apart,
which is exactly why the ranking in section 5 is behaviour-led.

| Workspace | Files in report | Line coverage | Branch coverage | Files never loaded |
|---|---|---|---|---|
| `packages/contract` | 29 | **99.0 %** | 92.7 % | 1 of 29 |
| `packages/api-client` | 5 | **100 %** | 95.8 % | 2 of 5 |
| `packages/xezar` | 313 | **94.5 %** | 85.2 % | 21 of 313 |
| `packages/web` | 239 | **93.6 %** | 86.7 % | 2 of 239 |
| **All** | 588 | **94.35 %** (35 606 / 37 738) | **85.65 %** (30 435 / 35 532) | 27 |
| *Source only* (`packages/*/src`, no testkits, no JSON) | 529 | **95.2 %** | **86.4 %** | 7 |

**The report is wider than it was.** On 2026-09-10 its 363 entries were the four workspaces' `src/`
files (golden JSON fixtures included) and `scripts/test-local-state.mjs`. It now also carries
testkits and what the suites import from outside `src/`, so the workspace rows are no longer
source-only, and the *source only* row is the closer comparison with 2026-09-10:

- 17 `*.testkit.ts` helpers inside `src/` (all but three at 100 %);
- 17 JSON files – golden fixtures, the design-guardian allowlist and the generated
  `docs/features/mcp-server/mcp-api.json` – data, not code;
- 12 tooling files – the Stryker and vitest mutation configs, `packages/xezar/mutation/*.mjs`,
  `packages/xezar/scripts/sync-readme.mjs`, and `scripts/test-local-state.mjs` (66.7 % lines,
  outside every workspace);
- 8 node:test helpers and fixtures under `packages/xezar/test/` and 5 browser-suite helpers under
  `packages/web/e2e/` (8–100 %: only the parts a unit test calls are covered).

Per workspace, source only: `packages/contract` 28 files, 99.0 % / 92.7 %; `packages/api-client`
5, 100 % / 95.8 %; `packages/xezar` 263, 95.0 % / 85.7 %; `packages/web` 233, 95.3 % / 87.9 %.

"Never loaded" counts files with **zero covered lines**, which is not the same as "no test reaches
it". Of the 27, 26 have no executable line at all: 14 golden or quota JSON fixtures, the two other
JSON files, four mutation configs, and six barrels, delegates or type-only modules (`contract` and
`api-client` `index.ts`, the type-only `api-client/src/protocol/ui-events.ts`,
`web/src/components/diff/index.ts`, and `server/github.ts` and `server/pr.ts`, which re-export
`server/forge/github.ts`). Exactly one source file has executable lines and none of them covered:
`packages/xezar/src/core/qwen-model-catalog.ts` (Qwen Code model discovery, below).

> **These percentages are a snapshot, not current status.** Re-run `npm run test:coverage` before
> quoting a number: the tree grows, and this report is a measurement, not a gate — CI never runs it,
> so nothing stops it drifting.

### Where high line coverage coexists with an untested behaviour

- ~~`packages/contract` measures 97.6 % lines and has zero tests of its own and no vitest project at
  all.~~ **Closed (#120)** — it is now a vitest project with four co-located test files. The line
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
- `packages/xezar/src/agent-config/model-settings/{claude,codex,qwen}.ts` each measure
  **100 % lines and 100 % branches** (`qwen.ts` has no branch at all) with **zero co-located test
  files**. Their coverage is a side effect of the agent-config API tests.
- `packages/xezar/src/ui-state.ts` measures 100 % / 100 % with no co-located test.
- `packages/xezar/src/core/agent-runner.ts` measures 100 % – it is the type seam, so this number
  says nothing about runner correctness.
- ~~`packages/xezar/src/server/launch-key.ts` measures 100 % lines while the `GET /launch-key`
  route it backs has no behavioural assertion found.~~ **No longer true (#53)** —
  `launch-key-api.test.ts:112-190` asserts the served value, its idempotence and its per-project
  scoping. Kept as the shape of the warning: a 100 % on a module whose ROUTE is untested says
  nothing, and this one was the example until someone wrote the test.

- `packages/xezar/src/runs/store.ts` is one of the most heavily exercised files in the repository —
  312 `RunStore.open(…)` call sites across 145 test files — and until #671 **nothing asserted what
  it does when the directory it writes into is removed underneath it**. The debounced `runs.json`
  save fired into the gap, `console.error`'d an `ENOENT` on `runs.json.tmp`, and that late
  `console.*` is what vitest reports as `EnvironmentTeardownError: Closing rpc while
  "onUserConsoleLog" was pending` (#631, three red `MCP per-file coverage` jobs on 2026-09-18 with
  all 2 267 tests passing) or a gate reads as a timeout in whichever case was running when it
  landed (`acceptance-parity.test.ts` P-14/P-15, #671 row F-26). The coverage was real and the
  behaviour was untested: every one of those 312 sites executed the happy `saveNow()`, none of them
  asked what the failing branch said. `runs/store-teardown.test.ts` now pins every direction on
  REAL timers — a vanished data directory is a silent SKIPPED write that a recreated directory
  recovers from, `close()` is the only thing that ends the write lifecycle (`isClosed`), a write
  failure with the directory still present is still logged, `EACCES` on one of its PARENTS is
  still logged although `existsSync` answers false for it, and an open store still debounces and
  still writes through tmp+rename. `store.test.ts` cannot be that proof: its own `beforeEach` uses
  fake timers precisely to dodge this race. Its structural sibling `runs/store-fixture-scan.test.ts`
  covers what no runtime assertion can: it reads the suite's own source and fails for a NEW fixture
  that opens a store over a directory it then removes without closing it, with the 69 pre-existing
  files listed as a grandfather set that only shrinks.

### Where the opposite is true – low coverage, well-guarded behaviour

- `packages/xezar/src/index.ts` is **absent from the report entirely**, yet `run`, `projects`,
  `server-install`, `server-uninstall`, `server-deploy`, `--help` and `--version` are all exercised
  by the node:test suites that CI does run, and `init` by `project-kit-cli.test.ts`. Its 0 % is a
  measurement artefact for every one of those paths, `serve` included since #43:
  `test/e2e/package-cli.test.ts` boots the packaged CLI's default command and asserts port
  fallback, orphan prune and `.local/.gitignore` upkeep, in a suite CI runs.
- `packages/xezar/src/planner.ts` measures 87.5 % lines here (37.5 % at `e437c24`, 85.4 % on
  2026-09-10) while
  `test/unit/planner.test.ts` covers two of its functions in a suite this run does not see. The
  number moved without anyone testing the planner: this is a measurement, and measurements drift.
- `packages/xezar/src/server-install/*` still measures unevenly (`ubuntu-vps.ts` 82.3 %,
  `engine.ts` 85.8 %); parts of the install path are exercised by `test/e2e/package-cli.test.ts`
  instead, and the branches those two platforms reach — `apt`, `launchctl`, `certbot`, a real
  `nginx` — cannot be reached from a unit suite at all. What the vitest side can hold is the argv
  each of them WOULD pass, which is what the platform tests assert.

### Lowest-covered files (measured, for orientation only)

**The 80 % line floor of 2026-09-10 no longer holds.** Then, no measured source file with an
executable line was under 80 % lines. On 2026-10-19 eight are, and all eight were added after that
snapshot (2026-09-14 to 2026-10-16). Of the files the 2026-09-10 table listed, two moved down:
`scripts/test-local-state.mjs` (84.2 % to 66.7 %) and `server/open-in-app.ts` (85.7 % to 84.9 %);
the rest moved up or stayed put. That is a fact about this report, not a promise about the code:
read the branch column beside it, and remember the scope limit at the top of this section.

Every source file below 86 % lines, in order, plus `scripts/test-local-state.mjs`, which the
2026-09-10 table also carried. The branch column is bolded below 75 %.

| File | Lines | Branches |
|---|---|---|
| `packages/xezar/src/core/qwen-model-catalog.ts` | **0.0 %** | **0.0 %** |
| `packages/web/src/components/onboarding-offer-container.tsx` | 30.8 % | **21.4 %** |
| `packages/xezar/src/platform/canonical-path.ts` | 37.0 % | **35.3 %** |
| `packages/xezar/src/state-names-cli.ts` | 51.6 % | **44.4 %** |
| `packages/xezar/src/core/codex-read-only-hook.ts` | 61.1 % | **26.8 %** |
| `scripts/test-local-state.mjs` | 66.7 % | **28.0 %** |
| `packages/contract/src/resume-command.ts` | 72.7 % | 100.0 % |
| `packages/xezar/src/platform/system-programs.ts` | 76.9 % | 86.4 % |
| `packages/xezar/src/platform/private-dir.ts` | 79.1 % | **70.6 %** |
| `packages/web/src/routes/task-thread/use-finish-run.ts` | 80.0 % | 100.0 % |
| `packages/xezar/src/platform/process-launch.ts` | 80.0 % | 83.5 % |
| `packages/xezar/src/runs/author-evidence.ts` | 80.8 % | **62.5 %** |
| `packages/xezar/src/core/qwen-runner.ts` | 82.0 % | **68.0 %** |
| `packages/xezar/src/server-install/platforms/ubuntu-vps.ts` | 82.3 % | **69.8 %** |
| `packages/web/src/components/skill-detail.tsx` | 83.3 % | 80.0 % |
| `packages/web/src/routes/settings/add-account-dialog.tsx` | 83.3 % | **71.4 %** |
| `packages/xezar/src/agent-config/account-identity.ts` | 83.3 % | **69.2 %** |
| `packages/xezar/src/own-package.ts` | 83.3 % | **50.0 %** |
| `packages/xezar/src/server/wsl.ts` | 84.0 % | 89.7 % |
| `packages/web/src/routes/task-git/task-changes.tsx` | 84.1 % | **72.7 %** |
| `packages/web/src/components/clone-project-dialog.tsx` | 84.2 % | **72.5 %** |
| `packages/xezar/src/platform/claim-start.ts` | 84.3 % | 82.5 % |
| `packages/xezar/src/machine-identity.ts` | 84.4 % | 77.4 % |
| `packages/xezar/src/runs/project-writer.ts` | 84.6 % | 76.3 % |
| `packages/xezar/src/server/open-in-app.ts` | 84.9 % | **72.7 %** |
| `packages/web/src/components/diff/diff.tsx` | 85.2 % | 76.9 % |
| `packages/web/src/routes/tasks-overview.tsx` | 85.3 % | 87.2 % |
| `packages/web/src/components/zoomable-image.tsx` | 85.7 % | 88.9 % |
| `packages/xezar/src/server-install/engine.ts` | 85.8 % | 76.3 % |

Five `platform/` files sit in this table. The run was on macOS, so a branch only Windows or Linux
takes counts as covered only where a test passes the helper's trailing `platform` parameter
(*inferred* as the main reason; not counted line by line). The rows from the 2026-09-10 table that
left it: `commit-dialog.tsx` (now 92.3 % / 70.6 %), `git-worktree.ts` (90.6 % / 75.0 %),
`server/forge/github.ts` (90.2 % / 78.2 %), `workflows.tsx` (86.6 % / 69.5 %), `planner.ts`
(87.5 % / 60.2 %) and `core/usage-limit.ts` (87.5 % / 68.6 %), among others; all six are still
under 80 % branches.

The bolded branch numbers are where to look next. One was counted rather than guessed, on the
2026-09-10 snapshot: `workflows.tsx` sat at 83.6 % lines against 67.6 % branches, and of its 70
uncovered branches **18 (26 %) were the three dnd-kit drag handlers**, rising to about 44 % if the
drag-state rendering they drive is counted with them. The majority — error toasts, `??` defaults,
the Cmd+Enter shortcut, the palette filter, the debounce timers — was not drag-related at all. That
count was not repeated on 2026-10-19.

For the drag handlers specifically: `moveStep` has exactly one call site in that file
(`workflows.tsx:304`, inside `handleDragEnd`), so there is no keyboard or click path into it and
the unit suite cannot reach it — the component does wire a `KeyboardSensor` (`workflows.tsx:248`),
so "jsdom cannot drive it" is an *inferred* claim about dnd-kit's pointer geometry, not a measured
one. What the unit suite holds instead is `moveStep` as a pure function
(`lib/workflow-builder.test.ts:91-102`). The other bolded rows have not been diagnosed, except the
Qwen Code ones below.

### The Qwen Code backend (measured 2026-10-19)

Qwen Code replaced pi and OpenCode in 0.30.0 (#1041–#1046), so none of its files was in the
2026-09-10 snapshot. Every Qwen-specific source file, with what its tests do not reach. Line
numbers are at `79b7361`.

| File | Lines | Branches | Not reached by any unit test |
|---|---|---|---|
| `core/qwen-runner.ts` | 82.0 % | **68.0 %** (functions 72.3 %) | the step time limit in `runAll` – SIGTERM, SIGKILL after the grace, the "timed out after Nm" result (424–434, 470–473); the runner's own handling of `user` `tool_result` messages – the tool-result event, the #941 refusal note, images inside a tool result (614–626); the message chosen for an `is_error` result (631–639); image input, `writeImage` (709–713); `@path` escaping for a path with a space (727); the one-shot `run()`, `interrupt()` and `defaultTimeoutMs` (146–159); the dry-run mock's path (854–855). The hook-refusal and permission-denied fixtures are replayed through `qwen-ui-mapper.test.ts`, never through the runner |
| `core/qwen-model-catalog.ts` | **0.0 %** | **0.0 %** | both functions: `discoverQwenModels` and `qwenModelOptions` (the person's default first, duplicates dropped, local endpoints marked). `server.ts` imports the module, but `models-api.test.ts` injects its own discovery, so nothing ever calls either |
| `core/qwen-run-config.ts` | 93.0 % | 76.2 % | `qwenDefaultSystemSettingsPath` (38–40) and `realDir`'s fallback for a path that does not resolve (236); the unused `qwenRunEnv` was deleted |
| `core/qwen-settings.ts` | 97.5 % | 76.1 % | an endpoint URL that does not parse (`isLocalEndpoint`, 165) and settings text that is not JSONC (`parseJsonc`, 181) |
| `core/qwen-tool-policy.ts` | 94.6 % | 87.4 % | the exec tool allowed on a step with an unrestricted shell (188), a policy whose `bash.mode` is unknown (228), and an `mcp__<server>__<tool>` name's other spellings (`mcpSpellings`, 242–243). The file is also in the nightly mutation scope with a 68 % floor (10.13) |
| `core/qwen-ui-mapper.ts` | 91.0 % | 80.8 % | a permission denial for a tool still open or never seen (291–303), and the stop reason for `error_max_turns`, `error_during_execution` and an unknown result subtype (347–351) |
| `mcp/qwen-messaging.ts` | 97.3 % | 84.4 % | a receipt line that is not a control record (225), and the success path of `writeAndClose` – connect, write, close (251–252) |
| `mcp/adapters/qwen-code.ts` | 96.7 % | 87.8 % | a wait that is already cancelled when it starts (`abortableSleep`, 78–79) |
| `core/qwen-pre-tool-hook-entry.ts` | absent | absent | runs only as the bundled `scripts/qwen-pre-tool-hook.mjs` process; its policy is `qwen-tool-policy.ts` |

The shared lock the Qwen Code policy sits on, `core/read-only-lock.ts`, measures 99.1 % / 90.7 %.
The Codex adapter beside it, `core/codex-read-only-hook.ts`, is in the table above at 61.1 % /
26.8 %, and that number is a measurement artefact of the kind "Where the opposite is true" above
describes: its uncovered lines (38–61) are the lock-record check, which
`codex-read-only-hook.test.ts` drives through the bundled `scripts/codex-read-only-hook.mjs` with
`spawnSync` – an expired record, a mismatched one, a run that lost its environment – in a child
process v8 in the vitest process cannot see.

**What this means.** The Qwen Code runner's ordinary turn – start, stream text, tool calls, end –
runs in its tests. What does not is the edge of a turn: a step that runs out of time, a result that
reports an error, a tool result that carries a refusal or an image. Those are the paths a person
sees when something goes wrong, so they are the ones to add next (*inferred* priority).

Files absent from the report entirely: `packages/xezar/src/index.ts`,
`packages/xezar/src/core/ui-events.ts` (in `packages/contract/src/ui-events.ts` since #1184), `packages/xezar/src/server/app-type.ts`,
`packages/xezar/src/server/forge/types.ts`,
`packages/xezar/src/agent-config/model-settings/types.ts`, `packages/web/src/main.tsx` and
`packages/web/src/components/diff/types.ts`, as on 2026-09-10. The `types.ts` and `app-type.ts`
entries are type-only modules and are **excluded** as not testable. New since then:

- the two hook programs, `core/qwen-pre-tool-hook-entry.ts` and `core/codex-read-only-hook-entry.ts`,
  which run only as bundled child processes (`scripts/*-hook.mjs`) – out of reach of v8 in the
  vitest process, like the `core/__fixtures__/**/*.mjs` stubs;
- three `*.worker.testkit.ts` helpers, which the cross-process tests start as child processes, for
  the same reason;
- `packages/web/src/components/ui/tabs.tsx`, which nothing imports – the same dead shadcn
  scaffolding as the four `components/ui/*` primitives #453 batch B1 deleted (`card.tsx`,
  `scroll-area.tsx`, `select.tsx`, `separator.tsx`). It was not deleted in this pass; #1157 deleted it later.

`update-check.ts`, `app.tsx` and `task-commits.tsx` joined the report before 2026-09-10 and are
still in it.

---

## 5. Ranked gap list

Every gap in this list (rows R1–R20, epic #42) is closed, each by a test that covers the behaviour its row named; the rows, their evidence and the closing issues are in the git history of this file, which is where the R-numbers cited elsewhere on this page and in test comments point.

---

## 6. Gate structure, not just missing tests

**~~Covered by a suite CI never executes.~~ — closed by #128.** The browser e2e layer's specs
now run in CI as their own `ui-e2e` job, so a cockpit journey in section 3.3 whose only evidence is
an `e2e/*.e2e.ts` file is gated after all. (The commits tab used to be the clearest example of one;
since #49 it has a cockpit unit test as well, so it is no longer an example of anything.) The one
exception this paragraph used to name, the enabled automations flow (R9), is gated too:
`guide-07-github-automations.e2e.ts` boots its own `XEZ_AUTOMATIONS=1` fixture. The browser-level
preview step that used to self-skip in `automations.e2e.ts` was deleted in the 2026-10-24 cleanup
(#1189, § 3.3): it needs a signed-in `gh`, and the unit level covers preview.

**Covered only by manual QA.** `SDLC.md` § The QA gate states plainly that user-facing changes need the
separate real-browser QA, and `CODE_REVIEW.md:3` repeats that `test:e2e` is "the QA layer", not part
of the review gate. `SDLC.md` § The QA gate allows a self-QA exception with attached evidence. So the last line
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
by hand in `BACKWARD_COMPATIBILITY.md` §2 and nothing can catch it drifting. (Since #949 the guard
itself is gone: it was removed together with the §2 route inventory it checked.)

---

## 7. Findings outside the epic

These were uncovered by the audit and are deliberately **not** child issues.

1. ~~**CI job name is misleading.**~~ **Resolved by #128.** The job is now named "Typecheck, unit
   tests, build, and package" (job id `verify` in `ci.yml`), and the browser suite runs in its own
   job (job id `ui-e2e`, "Cockpit browser e2e"). The lesson survives: a job name that promises coverage it does not deliver is
   why the gap went unnoticed.
2. ~~**`docs/testing/local-data.md:75` is now stale.**~~ **Resolved.** That line now reads "One
   report producer is configured: `npm run test:coverage` writes the v8 coverage report to
   `.local/coverage/`". The rule it sets still stands: reporters write beneath `.local`, never a root
   report directory.
3. **The task table's COLUMN ORDER is pinned only in the browser suite.**
   `packages/web/e2e/tasks-table.e2e.ts` reads the ± cell positionally (`td:nth-child(7)`, deliberately
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

## 9. Method and limits

- Coverage: originally one `npm run test:coverage` run, exit 0, on `feature/coverage-gap-audit` at
  `e437c24`. **Re-measured 2026-09-10** on `feature/coverage-16-files`, exit 0; every percentage in
  section 5 is from that second run. Section 5 keeps the `e437c24` value beside each row so the
  movement is visible. **Re-measured again 2026-10-19** at `79b7361`, exit 0: sections 3.6 and 4
  carry that run's numbers only, and section 5 was not re-audited against it.
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
- **Dated 2026-09-09 – kept as history, no longer true.** The repository now has its own long
  history, so `git log -S` and `git merge-base --is-ancestor` are usable regression evidence. The
  observation as recorded then: **Git history is not usable as regression evidence in this
  checkout.** As audited on 2026-09-09, `git log` held 39 commits, all dated 2026-09-07 to 2026-09-09, beginning with `1f729a7 chore: import cezar upstream
  baseline`. `git log --grep=fix -i` returns 13 commits; `--grep=regress -i` returns none. The
  incident numbers cited throughout `AGENTS.md` (#810, #811, #661, #591, #751, #694, #426, #430,
  #472) do not resolve against `qodeca/xezar`; they are pre-rename issue numbers from the predecessor
  repository. The incidents are real and closed there – they were used as prose evidence
  for the ranking, not as commits in this repository.
- (Dated 2026-09-09, as above.) The thirteen `fix` commits that existed then cluster into three themes: test-gate and worktree
  isolation (3), release and CI mechanics (3), and cockpit behaviour (3). Two of those three themes
  are about the test infrastructure itself, which is consistent with the gaps ranked above.

---

## 10. MCP floor (#333)

The MCP test floor holds the MCP server to two requirements at once: every source file
under `packages/xezar/src/mcp/` at 80 % lines **and** 80 % branches from the MCP suites alone, and
every new test shown failing against a named break. This section is where that rule keeps its
records – the measurement, the quality finding beside it, the behaviours held by suites v8 cannot
see, and the written exemptions. It is dated like the rest of this document: re-measure before
quoting a number.

### 10.1 The command

`npm run test:coverage:mcp` – vitest's `server` project, restricted to the MCP test files
(`packages/xezar/src/mcp/`, `packages/xezar/src/server/mcp-*`,
`packages/xezar/src/server/stale-write-routes*`), v8 provider, coverage included over
`packages/xezar/src/mcp/**`, excluding `*.testkit.ts`, and a per-file threshold of 80 % lines and 80 %
branches. It writes to `.local/coverage/mcp/` and exits non-zero naming each file under the floor.
The 2026-09-15 run took 65.99 seconds (55 test files, 1,273 tests); 10.12 has the freshest local
measurement (85.00 seconds, 2026-09-17). It excludes unrelated server tests, which is the point –
coverage a module picks up from an unrelated test was never aimed at it.

What it cannot see is listed in 10.4. CI runs it in the separate, unconditional `MCP per-file
coverage` job on every pull request, with a 10-minute timeout; it remains outside
the local canonical gate. It was red on `main` from the day it
shipped until #352; 10.9 is the re-measurement that turned it green.

### 10.2 Measured – before and after this change

Measured 2026-09-11 and since superseded; the dated before/after table is in the git history of this file.

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
scope. It was adopted as a release gate on the sample's recommendation; that step was removed on
2026-09-12, nightly GitHub Actions runs were scheduled by #433 on 2026-09-15, and the owner removed
mutation testing from the project on 2026-10-27. The per-PR form stays the named break the MCP test
floor requires.

### 10.4 Held by a suite v8 cannot see

Manual instructions: [real-model runbooks](../features/mcp-server/mcp-client-acceptance-record.md#manual-real-model-runbooks).

These behaviours are tested, in suites `npm run test:coverage:mcp` does not measure. They are
recorded here so "covered elsewhere" is a fact with a file and a line, and so nobody writes a
duplicate vitest test to move a percentage.

| Behaviour | Suite | Evidence | Runs in CI? |
|---|---|---|---|
| A-13 stale leader write refused after a human change; concurrent calls, one applies | node:test | `test/unit/mcp-durability.test.ts:100,155` | yes (`npm run test:unit`) |
| A-14 a lost response replays once, a collision is refused, a SIGKILL between effect and receipt is unverified | node:test | `test/unit/mcp-durability.test.ts:204,246,271,342` | yes |
| A-16 absent or corrupt MCP state starts fresh, warns once, keeps the bad bytes; no two owners after a restart | node:test | `test/unit/mcp-durability.test.ts:416,466,558` | yes |
| A-21 reconnect: valid cursor, cursor past retention, duplicates and out-of-order rows | node:test | `test/unit/mcp-durability.test.ts:587-667` | yes |
| A-02, A-03, A-04, A-12 project isolation, partial success, foreign cursors, connection file kept out of Git | node:test | `test/unit/mcp-isolation.test.ts:78-304` (two A-03 cases skip on Windows without file-symlink rights, #973) | yes |
| A-16 an UPGRADED packaged cockpit with MCP state corrupt, deleted, hard-restarted | packaged CLI | `test/e2e/mcp-upgrade.test.ts` (packaged upgrade case) | yes (`npm run test:package`) |
| `xez mcp` as a real subprocess: handshake, absent bridge, service down, a neighbour on the port, and a directory xezar never served answering `not-registered` (the branch at `mcp/index.ts` (`not-registered`)) | server unit, but the bridge runs in a CHILD process v8 does not follow | `src/mcp/cli.test.ts:120,153,165,199,203` | yes |
| A-20 the open cockpit follows MCP changes; A-01/A-17/A-23 the MCP connection screen | browser | `packages/web/e2e/mcp-live-sync.e2e.ts:194,232`, `mcp-collaboration.e2e.ts` | yes (`ui-e2e`) |
| A-01, A-17, A-18, A-19, A-20, A-23 with REAL leader clients | node:test integration harness | `test/integration/mcp-real-clients.test.ts` | **no** – run by hand; results in `docs/features/mcp-server/mcp-client-acceptance-record.md` |
| A-19 / A-23 Qwen Code real-model reaction (#373, moved from pi in #1046) | node:test integration harness | `test/integration/mcp-real-model.test.ts` | **no** – opt-in OpenAI-compatible endpoint (`XEZ_REAL_MODEL_*`), run through Qwen Code with a temporary Qwen home whose settings list that model; exact nonce + cursor MCP ack, scripted request-only control; missing target is NOT-RUN |
| A-19 / A-23 Claude Code and Codex real-model reaction (#67) | node:test integration harness | `test/integration/mcp-real-model.test.ts` (`[claude-code]`, `[codex]`) | **no** – opt-in with `XEZ_REAL_MODEL_CLIENTS`, paid, the client's own login; exact run-id nonce + cursor ack observed on the wire and in `leader-cursors.json`; no scripted control in these two legs (the judge's own controls are unit cases in the same file) |

The last two rows are outside every gate by design: they need installed CLIs and the real-model
leg needs an explicitly supplied local endpoint. Their evidence is only as current as the last
recorded run.

### 10.5 Held by behaviour, not by a percentage

v8 marks every line of a zod declaration covered the moment the module is imported, so the
contract's `mcp-*.ts` files carry no floor. What they carry instead: each piece of logic that can
refuse has a test that makes it refuse.

| Logic | Refusing test |
|---|---|
| `mcpCatalogEventSchema` – not a catalog kind, wrong category, not a catalog subject, E-04 not by a human | `packages/contract/src/mcp-event-catalog.test.ts` (#333). Until then the schema was used only as a positive oracle in `event-catalog.test.ts`, never seen to say no. |
| `leaderNamesItsOperation` (`mcp-journal.ts`) – a `leader` row without its operation id | `event-journal.test.ts:169`, `echo-guard.test.ts:122`, `event-catalog.test.ts:513` |
| The other `mcp-*.ts` files | Declarations only – no refinement, transform or function. Their shapes are pinned where they are parsed (the tool suites) and by `contract-parity*.test.ts` at compile time. |

The MCP routes in `server.ts`, file-level coverage being meaningless for two routes in a 6 000-line
file:

| Route | Test |
|---|---|
| `GET /api/v1/mcp/reference` (and its scoped alias) | `server/mcp-reference-route.test.ts`, `server/mcp-reference-route.unavailable.test.ts` |
| The stale-write check (`expectedVersion`) on every run-mutating route | `server/stale-write-routes.test.ts` – refused with nothing applied, a current version goes through, an absent one is the cockpit's unchanged path |

### 10.6 Exemptions and sequencing

**Exemption ENDED 2026-09-12 (#352) – `packages/xezar/src/mcp/api-reference.ts`, now 100 % branches.**
The exemption claimed the five branches (`api-reference.ts:75,99,106,133,135`) could only be reached
by faking the registry, "a test of a tool that does not exist". That reasoning was wrong on its own
terms, in a way worth keeping: the contract declares `inputSchema` an **opaque** JSON object
(`packages/contract/src/mcp-api-reference.ts` – "describing JSON Schema in zod would be a second
definition that can drift"), so a listing with no `properties` is input the contract already allows,
not an invented one. And AGENTS.md § Changing a mechanism that already works says a fail-open helper
needs a populated-input guarantee or it lies – against an empty listing, "we found nothing" and
"there is nothing" are the same branch and must not read the same. `api-reference.test.ts` swaps the
registry at the module seam (`./tools/index.ts`, and `toolListing` for the one hand-written listing),
and every case carries its populated-input control in the same test, or – for `refusedActions` – in
the live-registry pin it deliberately does not duplicate. Seven named breaks, each shown
red in #352: `everyCall` hardcoded to `false` and to `true` (`:106`), each `?? {}` dropped (`:75`,
`:99`, throws), `byName.get(tool)!` (`:133`, throws), and the description test emitting always and
never (`:135`). The live-registry pin is unchanged: `mcp-reference-route.test.ts:110-160` still owns
"the page agrees with the wire", and `api-reference.test.ts` deliberately does not duplicate it.

**Corrected 2026-09-12 (#357): that clause said "in the same test" of every case, and for
`refusedActions` it is not true.** The independent QA of #355 found it, and it re-measures here:
hardcoding `refusedActions` to `[]` in `api-reference.ts` leaves all three tests in
`api-reference.test.ts` green (exit 0), because the only `refusedActions` assertion in that file is
the empty one at `:94`. **There is no hole in the suite** – the same break reddens exactly
`mcp-reference-route.test.ts` → *carries every refusal-only action and every declared refused
argument, from the live tools*, which is the populated-input control and is the pin this file was
written not to duplicate. So the defect was the sentence, not the tests. The `@file` docblock of
`api-reference.test.ts` (`:20-21`) still carries the same overstatement and is left for the next
change to that file, which is source this documentation task may not touch.

**100 % branches is not "no break gets through" – mutation X-D (#357).** The same QA wrote four
mutations beyond #352's seven, and one survives this file at its new 100 % branch coverage: drop
`performing.length > 0 &&` from `api-reference.ts:109`. `performing` is empty for a tool whose every
discriminator action is refusal-only, `requiredBy` is then empty too, and `0 === 0` makes `everyCall`
read `true` – the page printing "required on every call" for a guard no call can reach – where the
truth is `false`. No live tool is shaped that way today, so nothing goes red: re-measured 2026-09-12,
the MCP mutation test set of the time (45 files, 930 tests) passes
with the break applied, and so do the three suites that read `everyCall` at all
(`api-reference.test.ts`, `mcp-reference-route.test.ts`, `mcp-api-doc.test.ts`, three runs each).
The survivor itself is recorded with the rest in **#338**, not here; what belongs here is why it is
worth recording. A file can sit at 100 % branches and still ship a real behavioural break, which is
the whole reason the floor is a floor rather than a target.

**The lesson, not the number.** "The only way to reach it is to fake the registry" is a claim about
the seam, and a seam a shipped module already imports through is not a fake. Before writing an
exemption for a branch no current input reaches, check whether the *contract* for that input is
wider than today's producers – if it is, the branch has real callers that have not been written yet,
and the empty-input case is exactly the one to pin.

**Exemption ENDED 2026-09-12 (#352) – `packages/xezar/src/mcp/adapters/codex.ts`, now 96.4 % lines,
82.7 % branches.** It ended by its own terms: #311 merged as `7bcb258`, and re-measuring on `main`
puts the file above the floor without a line of new test – the 15 uncovered lines below were the
ones #311 deleted, and #311's rewritten `adapters/codex.test.ts` reaches most of the rest. The file
needs no exemption now, so it has none. What is NOT closed: the kept lines listed below are still
partly untested, and **#338 still owns testing them** – that is sequenced work, not an exemption.
The record of what the exemption said, measured 2026-09-11 against #311's own diff (`gh pr diff 311`, whose base is this branch's `11a6df3`, so the line
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
**Ended when** #311 merged. Re-measured on `main` in 10.9; testing the kept lines in `codex.test.ts`
stays with #338.

**Corrected 2026-09-11: `service.ts` and `index.ts` were never "leaving".** An earlier version of this
section sequenced both after #311 on the claim that #311 rewrites the code their uncovered branches
sit in. #311's diff touches **none** of those lines: it adds a session observer to `service.ts` and
push-delivery wiring to `index.ts`, beside them. So they were tested instead of exempted
(`service-answers.test.ts`, each case red against a named break in #335), and both are above the
floor now. What was left uncovered in `service.ts` and why: the `closed` answer to `session/open`
(`service.ts`, closed connection handling) goes to a connection that is already gone, so nothing can observe it; the
`String(err)` logging arms only change a log line; `chmod` failing after `listen`
(`service.ts`, post-listen chmod) and an `lstat` error other than ENOENT (`service.ts`, lstat handling) need a filesystem that fails on cue. In
`index.ts`, the unregistered-directory answer (`status: 'not-registered'`) is held by `cli.test.ts:199` in a child process
(10.4), and was not duplicated.

Done in #352, recorded in 10.9; the later measurements are in 10.10 and 10.11.

### 10.9 Re-measured on `main` after #311 – the floor is green (#352)

Measured 2026-09-12: the floor turned green on `main` after #311 and #352, and `npm run test:coverage:mcp` has run in its own unconditional CI job on every pull request since #550; the dated table is in the git history of this file.

### 10.10 Re-measured for the MCP leader door (#450)

Measured 2026-09-15 and since superseded; the dated before/after table is in the git history of this file.

### 10.11 Full per-file inventory — 2026-09-15, source baseline `bb271fc`

Superseded by later measurements; the dated record is in the git history of this file.

### 10.12 Re-measured for CI enrollment (#550)

Measured 2026-09-17 at 0.15.0: 61 test files and 2,070 tests in 85.00 s locally, every MCP file at or above the 80/80 floor, so #550 enrolled the command in CI without lowering a threshold. The dated per-file table, which still lists the since-deleted pi and OpenCode files, is in the git history of this file.

## Hosted mode: mode × transport verification (#547, SM1)

Read this matrix with [server-mode-test-levels.md](./server-mode-test-levels.md): this table
answers *what* guards each mode and transport, and that table answers *which level is cheapest*
to falsify each risk (#547 AC-1).

| Mode | HTTP / request boundary | WebSocket | Live event streams | Browser / platform evidence |
| --- | --- | --- | --- | --- |
| Local loopback | `origin-guard`, `host-guard`, `capabilities`: Host rebinding, Origin, forwarded-header controls, health-only non-credentialed CORS | `ws.test`: native/same-authority trusted; Vite trusted with browser vouch, health-only without; foreign origins refused | `sse-headers`, `workspace-events`, `route-parity` | Existing local browser suite; does not establish hosted behavior |
| Hosted (`XEZ_REMOTE=1` or non-loopback bind) | `local-handoff-routes`: non-empty registration-derived inventory, every guarded route and alias returns 409 before local effects; source parity rejects an untagged inline refusal. `origin-guard`, `health-forge`, `agent-config-api`, `agent-profiles-api`: Origin, CORS and conditional disclosure | `ws.test`: real-socket pre-handshake 403 for absent, foreign, forged loopback and same-authority Origins under both mode selectors; local controls unchanged | Existing in-process suites plus the built-CLI harness below | `client`, `global-events`, `run-events`, `queries` unit suites pin included HTTP/SSE credentials and zero remote browser WebSockets; no hosted real-browser claim |
| Hosted through authenticated fixture proxy | `test:server-mode`: built CLI, Basic Auth on, missing/wrong credentials denied before forwarding; canonical Host and overwritten forwarding metadata; direct-backend controls; forbidden writes leave runs unchanged, authenticated same-/no-Origin controls create dry-run runs; documented port precedence (`--port` beats `XEZ_PORT`, `XEZ_PORT` decides with no flag) | Proxy forwards authenticated upgrades; backend refuses all tested Origins. Anonymous/wrong credentials receive 401 | Workspace, project and run streams authenticate, expose no-buffer/no-transform headers, yield a complete frame within 3s, reconnect and abort cleanly | POSIX and Windows: Windows support came with #963 (`d68a982f`), through the product's process-table layer; CI runs it on Linux only. Saved local reverse proxy; no real nginx/ngrok, TLS, public-network or browser proof |
| Real Ubuntu/ngrok install | Unknown in this package; operator's authentication and private backend reachability require live installation verification | Unknown platform proxy behavior | Unknown public TLS/proxy buffering | SM1 does not certify an installation; SM2 reconciled the user-facing doc claims (below) but did not run a real install — live platform status stays unknown |

Registration metadata identifies the existing handler guards; valid fixtures reach hosted 409 while validation and missing-run 404 precedence stay unchanged. Conditional provider-connect and home-config reads retain their existing route policy. The direct-backend control deliberately shows that hosted mode has no built-in authentication: the backend port must remain private. Runtime state and agent homes belong to a fresh ignored `.local/server-mode-*` fixture; teardown closes streams and the proxy, terminates the saved child PID and awaits its `exit` event, then ends what that child started and removes the fixture only once nothing it started is left (#876). On POSIX that is the exact process group the child leads (every CLI is spawned `detached`, so its descendants — the background team-skills clone, a run's dry-run agent — share that group), and the check is `kill(-pgid, 0)` answering ESRCH. Windows has no process groups, so the harness loads the product's own process-table layer from the build (`dist/platform/process-table.js` and `table-then-kill.js`, #963): it finds the child's descendants by parent and creation time in one process-table read, kills them by identity, and requires a fresh read to show none. It never searches by process name. Missing builds, early exits, incomplete streams, unavailable sockets/platform support or incomplete cleanup fail the command; no skip is a pass.

**SM2 doc-claim reconciliation (#547).** `packages/xezar/src/server-install/hosted-docs.test.ts` pins two claims that had drifted from behavior: `docs/guide/14-remote-access.md` no longer states an unconditional "starting at port 4321" (a normal launch actually prefers the project's saved port, then `XEZ_PORT`, then the port it last listened on, before 4321), and `docs/server-install/macosx-ngrok.md` / `README.md` explicitly disclose that the installer's "identity" step never probes the public basic-auth gate — it only polls ngrok's local `:4040` API for a public URL. The matching source overclaim is fixed too: `macosx-ngrok.ts`'s install success message used to say "basic-auth enforced at the ngrok edge" as if that had been checked; it now says basic-auth was configured but not probed through the tunnel, pinned by `macosx-ngrok.test.ts`. No real nginx/ngrok/TLS install was run to produce this reconciliation — it aligns documentation with already-verified automated behavior, nothing more.

**SM2 follow-up (#547 AC-5).** The harness now also asserts the guide's documented port precedence through the built CLI — `--port` beats `XEZ_PORT`, and `XEZ_PORT` decides when no `--port` is given (case `A-PORT-01`) — and `hosted-docs.test.ts` ties each documented claim to the harness case that observes it: the guide's port-precedence sentence to `A-PORT-01`, and the anonymous-challenged / authenticated-reaches claim in `docs/guide/14-remote-access.md`, `docs/server-install/README.md` and `docs/server-install/ubuntu-vps.md` to `A-AUTH`. `BREAK-DOC-MODE` stays. The claim text and the case id are checked together, so editing a claim to something the harness observes false — or deleting the case — turns the check red.

**#572 — ngrok Traffic Policy strips `X-Xezar-User`.** Unit-level only, at the same fidelity as the existing `ubuntu-vps.test.ts` nginx-config assertion: `macosx-ngrok.test.ts` asserts `launchdPlist()` wires `--traffic-policy-file` to a written policy file whose `remove-headers` action names `X-Xezar-User`, and that `undo()` removes that file. This proves xezar tells ngrok to strip the header; it does not run real ngrok, so whether the installed ngrok binary honors `--traffic-policy-file` on a live tunnel stays in the same "Real Ubuntu/ngrok install" unknown as the row above — no CI job here spawns actual ngrok. The generic `test:server-mode` harness (`Hosted server boundary and proxy`) was considered and is not the right place: it models a generic authenticated reverse proxy and never invokes ngrok or `macosx-ngrok.ts` at all, so it cannot exercise this platform-specific fix.

### Reuse for #306 QA (no browser required)

1. Use a checkout on Linux, macOS or Windows with Node 22.13+ and run `npm ci`.
2. Run `npm run test:server-mode` (builds `packages/xezar/dist/index.js` first).
3. Require all named `PASS` lines, including exact-PID teardown, and exit status zero.
4. Run it again to check fresh homes, OS-assigned ports and cleanup.
5. Record the revision and complete output; this proves the local authenticated HTTP/event-stream path only.

The separate CI job **Hosted server boundary and proxy** has a five-minute hard timeout: the harness itself is bounded to 45 seconds, with room for cold dependency installation and server compilation. Unit/route policy remains in `npm test`; this harness tests composition, not a second exhaustive policy table. Named-break evidence belongs in the PR body, including an actual failed assertion for each behavior group.

## The #532 fragile MCP–leader case audit

Issue #532 keeps a checklist of twelve gap groups (G1–G12) over fragile MCP-leader communication
cases, each with a proposed covering test, fixture and named breaks. The checklist itself lives only
in the issue — no file mirrors its full text — but every group's current status is executable:
`packages/xezar/src/mcp/gap-group-inventory.test.ts` (#532 G12) scans the mcp test corpus for a
`G<n>` token in a title or comment and fails when a declared group has none, with a negative control
proving the check itself goes red when a covering test's mention disappears. Read that file's
`GAP_GROUPS` map for the current one-line description of each group; do not duplicate it here, since
a duplicate is exactly the kind of copy that goes stale.

| Slice | Groups | Landed |
| --- | --- | --- |
| 1 (#533) | G1, G2, G3, G10 | `leader-event-delivery-matrix.test.ts`, `leader-delivery-regressions.test.ts`, `stale-write.test.ts` / `tools/stale-write-tools.test.ts`, `echo-guard.test.ts` / `operation-receipts.test.ts` |
| 2 (#542) | G7, G8, G9 | `engine-leader-incidents.test.ts`, `event-catalog.test.ts` |
| 3 (#570) | G4, G5, G6, G11, G12 | `leader-delivery.test.ts` (G4, owner-switch fencing and Claude Code's live-transport follow), `tools/leader-events.test.ts` (G5 ack epoch boundary, G6 restart/epoch-reuse recovery), `test/integration/mcp-real-model.test.ts` (G11, the shared acceptance judge hardened against a decoy tool call), `gap-group-inventory.test.ts` (G12) |

Every group's status is therefore re-derivable by running `gap-group-inventory.test.ts` rather than
trusting this table after the next slice lands.

## Repository validation guidance

`npm run test:coverage` measures the four vitest projects with the v8 provider and writes to
`.local/coverage/`. It is a **measurement, not a gate** – the gate (`bash .xezar/checks/repo-gates.sh`) does not run it, CI does
not run it, and it sees neither the node:test suites nor the browser suite, so a module the
packaged-CLI tests exercise still reads as uncovered there. Before concluding that a behaviour is
tested, identify the suite that actually covers it and check whether high line coverage sits on
top of an untested behaviour.

One scoped exception is a requirement rather than a measurement: `npm run test:coverage:mcp` holds
every MCP source file to 80 % lines and 80 % branches, and CI runs it in its own required job on
every pull request. A PR on the MCP scope must also show each new test failing against a named break.
Neither half passes alone.
