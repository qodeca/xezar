# Server mode: risk to cheapest test level (#547)

Issue #547 asks for a saved, repeatable verification package for a Xezar server reached
through an authenticated reverse proxy (`XEZ_REMOTE=1` or a non-loopback `--bind-host`
turns `capabilities.localHandoff` off). The point of this table is the **cheapest level
that can falsify each risk**, so a real trust boundary is guarded at the level that can
actually see it and pure policy never pays for a process, a proxy or a browser.

This is the risk axis. The mode × transport matrix in
[coverage-gaps.md](./coverage-gaps.md#hosted-mode-mode--transport-verification-547-sm1)
answers the orthogonal question — *what* guards each mode and transport — and the two are
meant to be read together.

The table was recovered from the frozen evidence file
`.local/xezar-tasks/245daf3a-82da-4b6c-b981-ebcdb73cd923/server-mode-test-spec.md`
§ "Risk to cheapest test level" (14 rows), then re-verified against `main` at `681bf457`
(2026-09-20). Every row is kept; none was dropped or re-derived. The frozen copy cited bare
file names and line numbers; this committed copy names **repo-relative paths**, because the
doc-check test below resolves them, and it names the committed suite for the rows the frozen
copy still marked *inferred*. `packages/xezar/src/server-install/server-mode-test-levels.test.ts`
fails when a row's cited suite or file disappears.

## Levels

| Level | Use it when |
| --- | --- |
| `unit` | The behaviour is a pure predicate or a resolved setting — no socket, route or process adds information. |
| `in-process route` | The behaviour needs a registered route, a real request and its side effects, but no public proxy. A real-socket upgrade test lives here too, because the raw HTTP upgrade never reaches Hono. |
| `packaged CLI` | The behaviour only exists when the built command, an authenticated hop and a spawned process compose. |
| `browser` | Only a real browser can establish that the UI works end to end; API correctness alone cannot. |
| `one-off live proof` | The behaviour belongs to platform software (nginx, ngrok, TLS, the public network) outside the hermetic suite. |

## Risk → cheapest level

| Risk | Cheapest level | Why this is the cheapest level that can falsify it | Guarding suite (committed) |
| --- | --- | --- | --- |
| Loopback Host parsing admits a registrable lookalike or a malformed authority | `unit` | A pure canonicalization predicate: no socket, route or process adds information. | `packages/xezar/src/server/capabilities.test.ts` |
| Hosted mode is not selected by `XEZ_REMOTE=1` or a non-loopback bind | `unit` | Pure capability resolution from the environment and the bind host. | `packages/xezar/src/server/capabilities.test.ts` |
| A hosted WebSocket accepts any upgrade | `in-process route` | The raw HTTP upgrade never reaches Hono; the real-socket seam in this suite is the cheapest place that can observe a pre-handshake 403. | `packages/xezar/src/server/ws.test.ts` |
| A new local-only route is omitted from the 409 gate | `in-process route` | Needs the registered route table and its handlers, not a public proxy; the manifest is derived from the registration, so the inventory stays exhaustive. | `packages/xezar/src/server/local-handoff-routes.test.ts` |
| A cross-origin mutation reaches a handler | `in-process route` | Must assert the status and the absence of a side effect, which a real route answers directly. | `packages/xezar/src/server/origin-guard.test.ts` |
| Health reflects credentialed CORS | `in-process route` | Header-only behaviour; a proxy hop adds no information. | `packages/xezar/src/server/origin-guard.test.ts` |
| The proxy fails to require credentials | `packaged CLI` | The proxy itself is the behaviour under test, so it needs the built command behind a real authenticated hop. | `packages/xezar/test/e2e/server-mode-harness.mjs` |
| The proxy trusts inbound `Host` or `X-Forwarded-Host` | `packaged CLI` | Requires an actual forwarding hop plus a direct-backend control. | `packages/xezar/test/e2e/server-mode-harness.mjs` |
| The built CLI reports local mode behind the intended hosted launch | `packaged CLI` | Catches launch, environment and bind wiring, not just helper logic. | `packages/xezar/test/e2e/server-mode-harness.mjs` |
| Authenticated SSE is buffered, challenged on reconnect, or cannot reach a frame | `packaged CLI` | Needs a long-lived transport through a proxy that streams. | `packages/xezar/test/e2e/server-mode-harness.mjs` |
| The browser opens a WebSocket remotely or omits credentials on HTTP/SSE | `unit` | The cockpit's fakes observe the exact constructor and fetch options, so a real Chrome adds nothing. | `packages/web/src/api/queries.test.tsx`, `packages/web/src/api/global-events.test.tsx`, `packages/web/src/api/run-events.test.ts` |
| The cockpit cannot render and create a dry-run task through an authenticated proxy | `browser` | Only Chrome can establish that the UI works end to end. Needed only if #306 requires UI proof; the dry-run-task-through-proxy case itself is not built. | `packages/web/e2e/guide-14-local-hosted.e2e.ts` |
| Real nginx/ngrok/TLS differs from the throwaway proxy | `one-off live proof` | Platform software sits outside the hermetic suite; name the automated controls that guard the same server behaviour. Live platform status stays unknown. | `packages/xezar/test/e2e/server-mode-harness.mjs` |
| A child or proxy leaks after failure | `packaged CLI` | Only the spawning layer owns PID and socket cleanup. | `packages/xezar/test/e2e/server-mode-harness.mjs` |

## What this table is not

It is not a second exhaustiveness list. The local-only route set is guarded by
`local-handoff-routes.test.ts`, which derives it from the registered route table and
rejects an untagged inline refusal — the harness spot-checks one representative route and
deliberately says so. The table names where each risk is cheapest to falsify; it does not
re-implement any guard.
