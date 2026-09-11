# Code review rules

How to review a diff in this repository. Applies to humans and to the `om-code-review` skill alike. The full validation gate in `.ai/agentic.config.json` must be green before a review verdict is meaningful: typecheck, the vitest unit/component suites (`npm test`), the node:test core-module suite (`npm run test:unit`), build (which includes the `check:pack` tarball gate), and the packaged CLI E2E (`npm run test:package`). The unit/component suites are the fast correctness gate; real-browser E2E (`npm run test:e2e`) remains the QA layer for user-facing changes.

## Review priorities (in order)

1. **Correctness of the run lifecycle** — runs, steps, worktrees, sessions. A bug here loses user work.
2. **Graceful degradation** — the README's core promise: no `gh` → works without PRs, no network → local skills still load, no git repo → tasks run in place, `XEZ_DRY_RUN=1` → everything works offline. A diff that turns a degradation path into an error is a blocker.
3. **State-file compatibility** — `.local/xezar/` files outlive the process and the version that wrote them (see `BACKWARD_COMPATIBILITY.md`).
4. **Security of the local server** — it binds to `127.0.0.1` by default (a `--bind-host` server install may widen it into hosted mode), and it executes agents with file access; treat every request body as hostile.
5. **Simplicity** — "every module is meant to be read in one sitting." Push back on new dependencies or abstractions the change doesn't need; browser dependencies must justify their bundle and maintenance cost.

## Checklist

### TypeScript strictness

- `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` — the diff must compile without weakening them.
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
- Spawned processes use `execFile`/`spawn` with argument arrays — never string-interpolated shell commands. Tool access for agents goes through a per-step allowlist (`allowedTools`), but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`), and unapproved tools are denied without prompting (`--permission-mode dontAsk`; `XEZ_APPROVAL_GATE=1` opts into `acceptEdits` and Claude's approval UI) — treat a run as having full shell access in its worktree, not a sandboxed allowlist. Codex and OpenCode don't honor `allowedTools` at all (Codex: its own sandbox, approvals off, network on; OpenCode: everything auto-approved), while pi maps `allowedTools` onto its own `--tools` allowlist and disables `Bash` when a `bashAllowlist` is set (open-mercato/cezar#430).
- Writes that must not clobber use `wx` or tmp+rename; check new file writes follow one of those.

### State-file and API compatibility

- New fields on `RunRecord`/`StepState` are optional (or defaulted) so old `runs.json` files still parse — the existing comments ("old runs.json files … have neither") show the convention.
- NDJSON event logs are append-only; readers skip unparseable lines. Never rewrite or reorder an existing event file.
- Renaming/removing an API route, an event `type`, or a persisted field is a breaking change — route it through `BACKWARD_COMPATIBILITY.md`.
- **Changing what an ABSENT key resolves to in a persisted schema is a behavior change for every file already on disk**, and it is the quietest one in this repo: no parse error, no failing test, no diff in the file. `resources.memoryLimitMb` going from "absent means no guard" to "absent derives a host-sized ceiling" is the worked example. Ask the two questions that make it safe: does an explicit on-disk `null` still survive (zod's `.default()` fills `undefined` only, so absent and explicit-null must stay distinguishable), and is the NEW default the safer of the two? Changing a default toward the safer behavior is allowed; changing it toward a knob the user must now set is what AGENTS.md § Zero config forbids.

### Code quality

- Comments cite the spec or issue that motivated the code (`spec 006`, `open-mercato/cezar#348`); non-obvious behavior in the diff should too.
- Lowering or removing `maxWorkers` from the root `vitest.config.ts` is a **regression, not a tuning change** — see AGENTS.md § Validation for what it protects. The cap is a deliberate no-op on CI, so a green CI run is no evidence either way.
- No new **server runtime** dependencies without strong justification — that dependency budget is hono, @hono/node-server, yaml, zod, smol-toml, ws and @clack/prompts, and nothing else. The list is exhaustive on purpose: adding to it is a review decision, so the commit that widens it updates this line and says why. (`ws` earned its place because Node ships a WebSocket *client* but no server and `@hono/node-server` provides none, so the `/api/v1/ws` subscription bus had no in-tree option. `@clack/prompts` is the `server-install` wizard's terminal UI, and the whole module — dependency included — is lazy-imported from `packages/xezar/src/index.ts`, so an ordinary `serve` never loads it.) Browser packages are build-time dependencies and must remain locked, bundle-measured, and absent from the installed CLI's runtime dependency graph.
- Web UI changes belong under `packages/web/` and follow the accepted React 19 + Vite + Tailwind v4 + shadcn/ui architecture. Keep `packages/xezar/web/dist` reproducible from source, preserve light/dark/system themes and mobile/accessibility behavior, and add unit/component tests for changed behavior. A backend id → product name map, or a task-table column added outside `lib/task-columns.ts`, is a **finding**: `packages/web/src/lib/runner-label.ts` and `lib/task-columns.ts` are the single definitions, and the file exists because the same four pairs had already been copied into five components. This is the one place § Review priorities' "push back on new abstractions" does not apply — the abstraction is already there and the finding is not using it. (The legacy vanilla UI was retired in R7; the React cockpit is the only UI, and `/new` is the React composer.)
- User-facing errors are one human-readable line (the `createDraftPr` pattern), not stack traces.

### MCP test floor

- A diff touching `packages/xezar/src/mcp/**`, `packages/contract/src/mcp-*.ts` or an MCP route in `server.ts` leaves every file it changes at or above the floor of `npm run test:coverage:mcp` and lowers none; any other file below the floor must already carry its exemption or sequencing record in `docs/testing/coverage-gaps.md` § 10 (`SDLC.md` § The MCP test floor).
- Every new or changed test on that scope arrives with a named break and its quoted red output. Re-apply at least one break per test file and run the test: a test that stays green with its behaviour broken is a finding, whatever the percentage says.

## Severity guidance

- **Blocker** (request changes): data loss or corruption in `.local/xezar/`; a degradation path turned into a hard failure; unvalidated request body on a mutating route, or one validated inside the handler instead of through the validator middleware; secret written to disk; server exposed beyond localhost or CORS widened; path traversal; breaking a surface in `BACKWARD_COMPATIBILITY.md` without the required path; typecheck/build red.
- **Major** (request changes unless trivially fixed in-review): incorrect run/step state transitions; SSE replay duplication or event loss; unbounded input reaching files or processes; a schema field added as required when old files carry it as absent; an MCP test with no named break, or an MCP file the diff changes left below the floor with no written exemption.
- **Minor** (approve with comments): missing spec citation on non-obvious code; inconsistent error shape; naming/style drift; missed `wx`/tmp+rename on a low-stakes write.
- **Nit**: wording, formatting, comment polish. Never blocks.

Verdict: approve when there are no blockers or majors; otherwise request changes with each finding tagged by severity and file/line.
