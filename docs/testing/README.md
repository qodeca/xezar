# Testing index

Every test suite in this repository, how to run it, what it needs, where CI runs it, and how to
read a failure. The detailed documents are linked from each row; this page is the map.

Two rules hold for every suite:

- **Run vitest through npm, never `npx vitest`** – `npx` can fetch a different vitest from the
  registry. To narrow a run, pass vitest's own arguments after `--`, for example
  `npm test -- path/to/one.test.ts`.
- **The gate is `bash .xezar/checks/repo-gates.sh`**, run in the foreground. It runs `npm ci`, a
  security scan, `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
  `npm run test:package` and `.xezar/checks/repository-checks.sh` (which includes
  `check:links`). The browser suite, the two harnesses, the MCP coverage floor and mutation testing
  are not part of it.

## Suites

| Suite | Command | Needs first | Operating systems | CI job | Time limits |
| --- | --- | --- | --- | --- | --- |
| Unit (server, cockpit, api-client, contract) | `npm test` | `npm ci` | Linux, macOS, Windows | `verify` and `cross-platform` in `ci.yml` | job: 20 min (`verify`); `cross-platform` 20 min Linux, 30 min macOS, 45 min Windows |
| node:test core | `npm run test:unit` | `npm ci` | Linux, macOS, Windows (see [Windows known gaps](#windows-known-gaps)) | `verify`, `cross-platform` | `--test-timeout=600000` (10 min) per test; job limits as above |
| Packaged CLI | `npm run test:package` | `npm run build` (it packs the tarball) | Linux, macOS, Windows | `verify`, `cross-platform` | job limits as above |
| Cockpit browser e2e | `npm run test:e2e` | `npm ci`; `sh` on `PATH` (Git Bash on Windows); network on the first run to fetch agent-browser and Chrome for Testing | CI: Linux only. Local: Linux, macOS, Windows (7 files fail on Windows, [#1137](https://github.com/qodeca/xezar/issues/1137)) | `ui-e2e` in `ci.yml` | 1 200 s whole suite, 60 s per file and per test, 30 min job |
| Hosted server boundary and proxy | `npm run test:server-mode` | nothing – its `pretest` runs `npm run build:server` | CI: Linux only. Windows supported since #963 | `server-mode` in `ci.yml` | 45 s harness deadline, 5 min job |
| Two-project harness | `npm run test:multi-project` | `npm run build:server` (no `pretest` hook) | CI: Linux only. Fails on Windows ([#1137](https://github.com/qodeca/xezar/issues/1137)) | `multi-project` in `ci.yml` | 300 s ceiling, 60 s per wait, 12 min job |
| MCP coverage floor | `npm run test:coverage:mcp` | `npm ci` | any | `mcp-coverage` in `ci.yml`, every pull request | 10 min job |
| Coverage measurement | `npm run test:coverage` | `npm ci` | any | none – a measurement, not a gate | none |
| MCP mutation gate | `npm run test:mutation:mcp` (whole scope); CI uses `test:mutation:mcp:plan`, `:shard`, `:report`, `:survivors`, `:issue`; `:weights` refreshes the shard weights | `npm ci`; hours of machine time | any | `mutation.yml`: nightly at 02:17 UTC on the default branch, and manual dispatch; never on a pull request | `plan` 10 min, each `mutants` shard 300 min, `report` 15 min |
| Read-only lock mutation | `npm run test:mutation:lock` | `npm ci` | any | `lock` job in `mutation.yml`, same night | 30 min job |
| Documentation links | `npm run check:links` | nothing | any | none in CI; runs inside the gate (`repository-checks.sh`) | none |

"Any" means the command has no operating-system-specific step; it is run regularly only where the
CI job column says.

## Reading a failure

| Suite | Where to look | What the result means |
| --- | --- | --- |
| `npm test`, `npm run test:unit`, `npm run test:package` | vitest or node:test output in the terminal | A named failing test. On Windows, first check [Windows known gaps](#windows-known-gaps). |
| `npm run test:e2e` | The last `TEST_E2E_STATUS=` line, then `.local/qa/test-env-app.log` (the app), `.local/qa/test-env-build.log` (the build) and `.local/qa/test-env.json` (the running instance). In CI, the same three files are the `ui-e2e-logs` artifact, uploaded only when the job fails and kept 7 days. | `passed` (exit 0): every spec passed. `skipped` (exit 0): agent-browser could not be provisioned and nothing ran – **not** a pass, and CI fails on it. `failed` (non-zero): a spec failed or the environment did not boot. |
| `npm run test:server-mode` | One `PASS <case>` line per behaviour group, then `PASS server-mode including exact-PID teardown`; a failure prints `FAIL …` | Exit 0 only when every case passed and cleanup left nothing running. |
| `npm run test:multi-project` | The printed `result.json` path; `state.json` and the logs are beside it, and a failure keeps the scratch folder | Exit 0 = `PASSED`, exit 1 = `FAILED`, exit 2 = `BLOCKED` (a prerequisite such as the built CLI is missing – not a pass). |
| `npm run test:coverage:mcp` | The per-file table in the output; the report is in `.local/coverage/mcp/` | Any MCP file under 80 % lines or 80 % branches fails the run. |
| Mutation gates | The run summary in GitHub Actions; locally `.local/mutation/mcp/index.html` and `.local/mutation/lock/index.html` | The MCP scope fails under 80 % (`stryker.config.mjs`), the lock scope under 68 % (`stryker.lock.config.mjs`). A red night files or updates one issue labelled `mutation-nightly`. |
| `npm run check:links` | One `file:line → target` line per broken link | Any broken relative link or heading anchor under `docs/`, `README.md` or `designs/`. |

## Windows known gaps

Windows runs the full unit gate in CI (`cross-platform`, Node 22 and 24). Machine setup – Git Bash,
`jq`, long paths, LF line endings, Developer Mode – is in
[CONTRIBUTING.md § Contributing from Windows](../../CONTRIBUTING.md#contributing-from-windows).
Until the two issues below close, **a red local Windows run of the tests they name is expected**
and is not evidence about your change. A failure anywhere else is.

| Issue | What fails | Why |
| --- | --- | --- |
| [#1136](https://github.com/qodeca/xezar/issues/1136) | `packages/xezar/test/unit/serve-streams.test.ts` and `serve-port-memory.test.ts` in `npm run test:unit`: `EBUSY` in clean-up, or a hang | They stop `serve` with a root-only `child.kill`, so a process `serve` started (such as tsx's `esbuild.exe --service`) survives, holds the fixture folder and the output pipe, and the tests wait for the output to finish with no time limit. Seen mostly on a loaded machine. |
| [#1137](https://github.com/qodeca/xezar/issues/1137) | 7 browser-suite files: `mcp-live-sync`, `screenshot-states`, `design-debt-b1` (2 tests), `design-debt-b4` (2 tests), `review-gate`, `skill-search-ranking`, `workflows` | Not yet investigated. Likely causes for two are in [agent-browser.md § Running on Windows](agent-browser.md#running-on-windows). |
| [#1137](https://github.com/qodeca/xezar/issues/1137) | `npm run test:multi-project` | The harness builds its scratch folder from `realpathSync(tmpdir())` (`multi-project-harness.mjs:307`), which keeps the 8.3 short name of `TEMP`; with a long-name `TEMP` the next step fails with `EPERM` renaming `repo-b.missing`. Details and the workaround: [multi-project-harness.md § On Windows](multi-project-harness.md#on-windows). |

Three Windows settings the suites rely on:

- **`core.longpaths`.** CI sets `git config --global core.longpaths true` before checkout on
  Windows (`ci.yml`, step "Allow long paths in Git (Windows)"); set it on your machine too.
- **The `rmSync` retry shim.** `scripts/test-local-state.mjs`, which every vitest config and both
  node:test commands load first, gives `fs.rmSync` the retry its options promise on Windows, for
  every Node version: no Node version does it there itself. It retries `EBUSY`, `EMFILE`, `ENFILE`,
  `ENOTEMPTY` and `EPERM`; the last error still surfaces.
- **`--test-timeout=600000` on `test:unit`** (`packages/xezar/package.json`). It stops one hung test
  after 10 minutes. On Node 24 it bounds single tests only, not a test file whose process outlives
  its tests – that is the #1136 hang, which this option does not fix.

## Red-proof driver (worktree only)

`packages/xezar/test/red-proofs.mjs` proves a set of #467-era regression tests go red without
their fix (AGENTS.md § Changing a mechanism that already works). Run it as
`node packages/xezar/test/red-proofs.mjs [case-name...]`; no names runs every case.

**Run it only inside your own task worktree, never in a primary checkout.** Each case writes a
deliberate defect into a tracked source file, runs the owning test, then writes the original bytes
back. While a case runs the file is broken for anyone else reading that checkout, and if the
process is interrupted the defect stays. Run `git status` afterwards. It is not part of the gate or
of CI, and nothing calls it.

## Detailed documents

| Document | What it covers |
| --- | --- |
| [agent-browser.md](agent-browser.md) | The browser provider, the browser suite's boot, isolation, ceilings, recorded runs, the user-guide flow package, iterating on one spec, Windows notes and the docs capture harness |
| [browser-dry-run-exceptions.md](browser-dry-run-exceptions.md) | Guide flows a dry-run browser fixture cannot honestly cross, and the evidence that covers each instead |
| [browser-manual-checks.md](browser-manual-checks.md) | The dated record of browser checks done by hand in one QA run |
| [coverage-gaps.md](coverage-gaps.md) | Regression risk ranked by behaviour, measured coverage, the MCP floor and the mutation gates |
| [local-data.md](local-data.md) | Which files belong in Git and which local data belongs in `.local/` |
| [multi-project-harness.md](multi-project-harness.md) | The two-project harness: running it, its ceiling, named breaks, Windows |
| [multi-project-test-levels.md](multi-project-test-levels.md) | Multi-project risks mapped to the cheapest test level |
| [server-mode-test-levels.md](server-mode-test-levels.md) | Hosted-mode risks mapped to the cheapest test level |
