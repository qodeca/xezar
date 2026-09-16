# Code review rules

How to review a diff in this repository. Applies to humans and to the `code-review` workflow (`xezar-code-review`) alike. The full validation gate in `.xezar/pipeline/config.json` must be green before a review verdict is meaningful: typecheck, the vitest unit/component suites (`npm test`), the node:test core-module suite (`npm run test:unit`), build (which includes the `check:pack` tarball gate), and the packaged CLI E2E (`npm run test:package`). The unit/component suites are the fast correctness gate; real-browser E2E (`npm run test:e2e`) remains the QA layer for user-facing changes.

## What a review consumes

A review is a verdict about one set of bytes. Read these before forming it, and name them in the verdict:

- **The exact head.** State the commit SHA you reviewed. The verdict is valid for that SHA only: new candidate bytes invalidate it, and a re-push means re-reviewing at least the changed surface. A verdict that names no SHA is not evidence.
- **The gate result for that head**, from the validation gate in `.xezar/pipeline/config.json`. A gate run taken at an earlier head, a skipped command, or a command whose log is missing is **unknown**, not green.
- **The security result**, before you give a quality verdict (`SDLC.md` § Security before the quality verdict). It is produced by `.xezar/checks/security-scan.sh` as gate 2 of the canonical run and carried in the seal, so read the sealed status rather than the author's summary: `gateEvidence.security` in the run's `manifest.json`, or `security.json` in the sealed attempt. An unavailable scanner, a parse error, an empty inventory where one was expected, an interrupted scan, or no result at all is **unknown**, and unknown is not a pass. Withhold the verdict and say what is missing instead of passing around it. `reviewerRequired: true` means a named trust boundary changed and needs a security reader — a clean scan does not answer it.
- **The AC verification record** — each accepted acceptance-criterion ID mapped to its evidence at this head. It is a separate question from yours (`SDLC.md` § AC verification is not the quality review): a sound change that misses an accepted criterion is still not done. The author's record is an **input**, not a verdict; performing the independent half is part of this review, and a reviewer who finds the record absent says so rather than inferring it from the diff.
- **The named breaks** for every new or changed behaviour test, with the quoted red output (`SDLC.md` § Naming the break). **Who re-applies one:** the author records the red run — that half is not optional, and a missing one is a finding. The reviewer re-applies a break and runs the test *when it holds an installed checkout*; the read-only `code-review` workflow uses `worktree-setup.sh --readonly-init`, which installs nothing, so a reviewer without one records **unknown** for that half and says so in the boundary rather than implying it was done. A test that stays green with its behaviour broken is a finding on any scope, not only the MCP one.

**Reviewers do not edit the author's checkout.** A review is read-only and gets its own task; findings go back to the original author's repair task on the original branch and PR. An implementation agent never marks its own work independently approved — the two written self-verification exceptions in `SDLC.md` are the only path, and they are labelled so the exception is auditable.

## Review priorities (in order)

1. **Correctness of the run lifecycle** — runs, steps, worktrees, sessions. A bug here loses user work.
2. **Graceful degradation** — the README's core promise: no `gh` → works without PRs, no network → local skills still load, no git repo → tasks run in place, `XEZ_DRY_RUN=1` → everything works offline. A diff that turns a degradation path into an error is a blocker.
3. **State-file compatibility** — `.local/xezar/` files outlive the process and the version that wrote them (see `BACKWARD_COMPATIBILITY.md`).
4. **Security of the local server** — it binds to `127.0.0.1` by default (a `--bind-host` server install may widen it into hosted mode), and it executes agents with file access; treat every request body as hostile.
5. **Simplicity** — "every module is meant to be read in one sitting." Push back on new dependencies or abstractions the change doesn't need; browser dependencies must justify their bundle and maintenance cost.

## Checklist

### TypeScript strictness

- Every workspace `tsconfig.json` (`packages/{xezar,contract,api-client,web}/tsconfig.json`) sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` — the diff must compile without weakening them.
- No `any`, no non-null assertions to silence the checker; prefer narrowing, `unknown` + zod, or explicit optional handling. Indexed access is checked — `arr[0]` is `T | undefined`, handle it.
- ESM with NodeNext resolution plus `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` (`packages/xezar/tsconfig.json`): relative imports name the real `.ts` file, and tsc rewrites the extension in `dist` and in the emitted `.d.ts`, so the published package is still plain resolvable ESM. `node:`-prefixed builtins.

### Zod at every boundary

- Every request shape SHOULD be a zod schema in `packages/contract` with its type inferred (`z.infer`) — never a hand-written interface. Roughly forty request schemas are still declared in `server.ts`; that is known migration debt, not a per-diff blocker, but a diff that TOUCHES one should move it to the contract rather than edit it in place. Every API route validates its body, path params and query string as route **middleware** — `jsonZodValidator` / `paramZodValidator` / `queryZodValidator` from `packages/xezar/src/server/validators.ts` — and reads the result with `c.req.valid('json' | 'param' | 'query')`. The rejection shape is unchanged: `{ error }` with 400. A `safeParse` inside the handler is the *historical* pattern and is now a finding, not a model: Hono records a validated shape in the route type only when validation is middleware, so a handler-side parse leaves the typed client accepting any body. A route that trusts `c.req.json()` raw, or parses inside the handler, is a blocker.
- Routes are registered by **chaining** them into their family builder in `packages/xezar/src/server/server.ts`, and every route answers under `/api/v1` (project-scoped: `/api/v1/p/:projectId/…`). A loose `app.get(…)` statement compiles but vanishes from `AppType`, so the typed client cannot see it — `contract-parity*.test.ts`, `typed-bodies.test.ts` and `versioned-surface.test.ts` are the checks a reviewer should expect to see green.
- External process output crossing into the app (`gh … --json` in `packages/xezar/src/server/github.ts`, agent CLI streams) is zod-validated at the boundary, extras stripped.
- Persisted files read back in (`runs.json`, `config.json`, workflow YAML) go through their schema; parse failure degrades to a sane default, never a crash.
- Schemas carry the limits (`.max()` on strings/arrays, image size caps, `variants` 1–3, steps ≤ 8). New inputs need explicit bounds — unbounded user input into a file write or a spawned process is a blocker.

### Graceful degradation

- Missing `gh` / no remote / offline: GitHub reads return `{ available: false, reason }`, PR creation returns `{ ok: false, error }` — never a throw, never a 500 for an expected absence.
- Missing or malformed `.xezar/config.json` behaves exactly like the defaults and never blocks startup (`packages/xezar/src/config.ts`).
- git helpers in `packages/xezar/src/git-worktree.ts` never throw (except `createWorktree`); check the diff keeps that contract.
- `XEZ_DRY_RUN=1` paths must still work after the change — that is the offline demo and the de-facto integration test.

### Security

- No secrets in state files: nothing under `.local/xezar/` (runs.json, NDJSON events, handoff.md, ui-state.json, config.json) may contain tokens or credentials. `GITHUB_TOKEN` stays in the environment; the launch key stays in the gitignored `launch-key` file and is only served same-origin.
- The server's DEFAULT bind stays `127.0.0.1`; only an explicit `--bind-host` may widen it, and doing so must keep flipping the process into hosted mode (`capabilities.localHandoff:false`). CORS is for `/api/v1/health` only (bookmarklet discovery, spec 011). Widening the default bind, or widening CORS, is a blocker.
- Path handling on user-supplied names: file-serving routes must sanitize (`basename()` as in `/api/v1/runs/:id/images/:file`); workflow names are slugified before becoming filenames. Any user string that reaches a path or a shell needs the same treatment.
- Spawned processes use `execFile`/`spawn` with argument arrays — never string-interpolated shell commands. Tool access for agents goes through a per-step allowlist (`allowedTools`), but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`), and unapproved tools are denied without prompting (`--permission-mode dontAsk`; `XEZ_APPROVAL_GATE=1` opts into `acceptEdits` and Claude's approval UI) — treat a run as having full shell access in its worktree, not a sandboxed allowlist. Codex and OpenCode don't honor `allowedTools` at all (Codex: its own sandbox, approvals off, network on; OpenCode: everything auto-approved), while pi maps `allowedTools` onto its own `--tools` allowlist and disables `Bash` when a `bashAllowlist` is set (pre-rename issue 430).
- Writes that must not clobber use `wx` or tmp+rename; check new file writes follow one of those.

### State-file and API compatibility

- New fields on `RunRecord`/`StepState` are optional (or defaulted) so old `runs.json` files still parse — the existing comments ("old runs.json files … have neither") show the convention.
- NDJSON event logs are append-only; readers skip unparseable lines. Never rewrite or reorder an existing event file.
- Renaming/removing an API route, an event `type`, or a persisted field is a breaking change — route it through `BACKWARD_COMPATIBILITY.md`.
- **Changing what an ABSENT key resolves to in a persisted schema is a behavior change for every file already on disk**, and it is the quietest one in this repo: no parse error, no failing test, no diff in the file. `resources.memoryLimitMb` going from "absent means no guard" to "absent derives a host-sized ceiling" is the worked example. Ask the two questions that make it safe: does an explicit on-disk `null` still survive (zod's `.default()` fills `undefined` only, so absent and explicit-null must stay distinguishable), and is the NEW default the safer of the two? Changing a default toward the safer behavior is allowed; changing it toward a knob the user must now set is what AGENTS.md § Zero config forbids.

### Code quality

- Comments cite the spec or issue that motivated the code (`spec 006`, `pre-rename issue 348`); non-obvious behavior in the diff should too.
- Lowering or removing `maxWorkers` from the root `vitest.config.ts` is a **regression, not a tuning change** — see AGENTS.md § Validation for what it protects. The cap is a deliberate no-op on CI, so a green CI run is no evidence either way.
- No new **server runtime** dependencies without strong justification — that dependency budget is hono, @hono/node-server, yaml, zod, smol-toml, ws and @clack/prompts, and nothing else. The list is exhaustive on purpose: adding to it is a review decision, so the commit that widens it updates this line and says why. (`ws` earned its place because Node ships a WebSocket *client* but no server and `@hono/node-server` provides none, so the `/api/v1/ws` subscription bus had no in-tree option. `@clack/prompts` is the `server-install` wizard's terminal UI, and the whole module — dependency included — is lazy-imported from `packages/xezar/src/index.ts`, so an ordinary `serve` never loads it.) Browser packages are build-time dependencies and must remain locked, bundle-measured, and absent from the installed CLI's runtime dependency graph.
- User-facing errors are one human-readable line (the `createDraftPr` pattern), not stack traces.

### Design and UI

- Web UI changes belong under `packages/web/` and follow the accepted React 19 + Vite + Tailwind v4 + shadcn/ui architecture. Keep `packages/xezar/web/dist` reproducible from source, preserve light/dark/system themes and mobile/accessibility behavior, and add unit/component tests for changed behavior. A backend id → product name map, or a task-table column added outside `lib/task-columns.ts`, is a **finding**: `packages/web/src/lib/runner-label.ts` and `lib/task-columns.ts` are the single definitions, and the file exists because the same four pairs had already been copied into five components. This is the one place § Review priorities' "push back on new abstractions" does not apply — the abstraction is already there and the finding is not using it. (The legacy vanilla UI was retired in R7; the React cockpit is the only UI, and `/new` is the React composer.)
- **UI in scope** means the diff touches (a) a non-test `.tsx` file under `packages/web/src/routes/` or `packages/web/src/components/`, (b) `packages/web/src/styles/index.css` or `docs/design-system/cockpit.css`, or (c) any file under `designs/`. A diff that is UI in scope carries `needs-design`, or `skip-design` with a stated reason; a `needs-design` PR has a `## Design review` comment for its head SHA (`SDLC.md` § The design gate).
- Reuse before build: components come from `docs/design-system/components.md` and patterns from `docs/design-system/patterns.md`; a departure names its reason in the PR or in the design's open decisions.
- Every state is there: default, empty, loading, error, refusal, and 375 px (`docs/design-system/new-designs.md` §4), in both themes.
- The diff does not repeat a `docs/design-system/known-gaps.md` entry; a `G-nn` the diff touches is fixed or filed as `design-debt`.
- `docs/design-system/coverage.md` and `docs/design-system/cockpit.css` change in the same commit as the UI (`packages/web/src/design-system-drift.test.ts` enforces it).

### MCP test floor

- A diff touching `packages/xezar/src/mcp/**`, `packages/xezar/scripts/pi-leader-extension.ts`, `packages/contract/src/mcp-*.ts` or an MCP route in `server.ts` leaves every file it changes at or above the floor of `npm run test:coverage:mcp` and lowers none; any other file below the floor must already carry its exemption or sequencing record in `docs/testing/coverage-gaps.md` § 10 (`SDLC.md` § The MCP test floor).
- Every new or changed test on that scope arrives with a named break and its quoted red output. Re-apply at least one break per test file and run the test: a test that stays green with its behaviour broken is a finding, whatever the percentage says.

## Severity guidance

- **Blocker** (request changes): data loss or corruption in `.local/xezar/`; a degradation path turned into a hard failure; unvalidated request body on a mutating route, or one validated inside the handler instead of through the validator middleware; secret written to disk; server exposed beyond localhost or CORS widened; path traversal; breaking a surface in `BACKWARD_COMPATIBILITY.md` without the required path; typecheck/build red; a `needs-design` PR without `design-approved` (the merge policy enforces it); a guardian or drift test edited to pass.
- **Major** (request changes unless trivially fixed in-review): incorrect run/step state transitions; SSE replay duplication or event loss; unbounded input reaching files or processes; a schema field added as required when old files carry it as absent; an MCP test with no named break, or an MCP file the diff changes left below the floor with no written exemption; a new pattern, variant or token that no design-system page names and no decision records; a missing state (empty, loading, error, refusal, 375 px); sideways scroll at 375 px; an unlabelled control, or an action that does not work from the keyboard; a `G-nn` from `known-gaps.md` repeated in new code.
- **Minor** (approve with comments): missing spec citation on non-obvious code; inconsistent error shape; naming/style drift; missed `wx`/tmp+rename on a low-stakes write; copy off `docs/design-system/writing.md`; a mockup-vs-cockpit delta not recorded in `known-gaps.md` § Mockup fidelity; a missing `coverage.md` row.
- **Nit**: wording, formatting, comment polish. Never blocks.

Verdict: approve when there are no blockers or majors; otherwise request changes with each finding tagged by severity and file/line.

## Disposing of findings

- **Blockers and majors are fixed and verified**, at a named head, before the verdict flips. A promise to fix it later is not a disposition; neither is a downgraded severity. Re-check the fix at the new SHA — that is the only way the earlier evidence still means anything.
- **Every minor and nit gets exactly one disposition**, written down: *fixed in `<sha>`*, *disputed* — with the evidence, saying what was read and why the finding does not hold — or *proposed for deferral*, naming the issue that will carry it. Silence is not a disposition, and an unanswered finding leaves the review open.
- **The author disposes, the reviewer confirms.** Routing an undisputed finding back to the author is mechanical. Deciding a disputed one is adjudication, and adjudication is reserved to a person (`SDLC.md` § Ownership).
- **A changed acceptance criterion, a waived mandatory requirement, or a reserved review/QA adjudication goes to the owner.** Neither a reviewer nor a leader can accept debt that changes what "done" means for this change. No label, exemption or request for permission waives a mandatory check.
- **Repairs are counted.** The three durable counters in `SDLC.md` § "Self-review inside the author phase, and the repair counters" apply to review repairs as well: when the applicable counter is exhausted, the finding stays open and the PR stops, rather than being re-graded until it fits. `bash .xezar/checks/phase-record.sh counters` prints what a run has spent.
