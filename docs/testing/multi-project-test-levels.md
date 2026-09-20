# Multi-project: risk to cheapest test level (#548)

Issue #548 asks for a saved, repeatable verification package for one cockpit that serves
several registered projects. The point of this table is the **cheapest level that can falsify
each risk**: registry durability, context lifecycle and limit arithmetic are pure or
in-process facts, so they never pay for a process or a browser, while the one composition that
only exists after a build, a registry write and a spawn belongs at the packaged-CLI level.

This is the risk axis. The multi-project rows of [coverage-gaps.md](./coverage-gaps.md) answer the orthogonal question — *what* guards each behaviour — and
[multi-project-harness.md](./multi-project-harness.md) documents the one saved harness both
tables point at. The five levels are the same ones the sibling
[server-mode-test-levels.md](./server-mode-test-levels.md) uses, so a risk in either package is
placed against one shared scale.

The table was recovered from the frozen evidence file
`.local/xezar-tasks/6ae02ffd-48a0-4822-bba3-154346c1f540/multi-project-test-spec.md`
§ "Risk → cheapest test level" (14 rows), then re-verified against `main` at `eaa0ca31`
(2026-09-20). Every row is kept; none was dropped or re-derived. The frozen copy cited bare
file names and line numbers; this committed copy names **repo-relative paths**, because the
doc-check test below resolves them, and it names the committed suite for the row the frozen
copy still marked *inferred*.

**One citation had drifted and was fixed.** The frozen copy placed the registration-suppression
cases at `packages/xezar/src/workspace/projects.test.ts:246-273`. On current `main` that range
is the root-status probe-cache test (`serves a repeat render from the TTL cache instead of
re-probing`); the suppression cases now live under `shouldRegisterProject (boot registration
guards)` further down the same file. The committed copy therefore cites the file, not a line
range, which is what makes it resistant to the next drift.
`packages/xezar/src/server/multi-project-test-levels.test.ts` fails when a row's cited suite or
file disappears.

## Levels

| Level | Use it when |
| --- | --- |
| `unit` | The behaviour is a pure predicate, a schema rule or a resolved launch input — no socket, route or process adds information. |
| `in-process route` | The behaviour needs a registered route, a real request and its side effects (or the real composed MCP service), but no built command or public hop. |
| `packaged CLI` | The behaviour only exists when the built command, an isolated home, a registry write and spawned child processes compose. |
| `browser` | Only a real browser can establish that the UI works end to end; API correctness alone cannot. |
| `one-off live proof` | The behaviour belongs to an external client or platform software outside the hermetic suite. |

## Risk → cheapest level

| Risk | Cheapest level | Why this is the cheapest level that can falsify it | Guarding suite (committed) |
| --- | --- | --- | --- |
| Merge-write loses a registry row under contention | `unit` | Needs two real processes for the lock, but no route or browser; a live harness adds spawn cost without adding information. | `packages/xezar/src/workspace/config-lock.test.ts` |
| A bad project row evicts valid rows | `unit` | Pure schema salvage over a persisted file. | `packages/xezar/src/workspace/config.test.ts` |
| A missing or corrupt config fails to restore `.bak` | `unit` | Pure persisted-state recovery. | `packages/xezar/src/workspace/config.test.ts` |
| A context builds eagerly, twice, or survives disposal | `unit` | Controlled lifecycle and race test over the lazy map. | `packages/xezar/src/server/project-context.test.ts` |
| `default`/boot/unprefixed aliases diverge; unknown/missing status drifts | `in-process route` | Needs the registered route table, a real request and its status, but no process or browser. | `packages/xezar/src/server/route-parity.test.ts` |
| A scoped route reads B's state | `in-process route` | Needs a real request at A's door and the absence of a side effect; the cross-project ownership suite is the cheapest adversarial place to observe both. | `packages/xezar/src/server/cockpit-ownership.test.ts` |
| Workspace/per-project limits miscount or starve another project | `unit` | Timing and control are needed, but no UI; the semaphore test drives real `RunManager`s. | `packages/xezar/src/workflows/workspace-semaphore.test.ts` |
| The runs index silently drops or misattributes rows | `in-process route` | Cold and live stores are deterministic behind a real route. | `packages/xezar/src/server/runs-index-api.test.ts` |
| The workspace SSE stream bleeds or drops project events | `in-process route` | A deterministic stream reader over the real route observes each event's own stamp directly. | `packages/xezar/src/server/workspace-events.test.ts` |
| Production wiring of two repos, one home, routes and sessions fails | `packaged CLI` | Crosses build, CLI, registry, server, bridge and cleanup boundaries — only the built command composes them. | `packages/xezar/scripts/multi-project-harness.mjs` |
| MCP A owner blocks B, stale A retains writes, or A's owner switch mutates B | `in-process route` | Ownership sits below the browser; the suite drives the real composed MCP service and bridge, which a built CLI cannot make more truthful. | `packages/xezar/src/mcp/session-ownership.test.ts` |
| A Worktree-OFF task loads the project's MCP config and steals or refuses the leader (#342) | `unit` | The regression guards the runner's launch seam — the arguments and MCP config each backend receives; a dry-run harness cannot reach the external client, so the real-client observation is a separate one-off proof. | `packages/xezar/src/core/worktree-off-mcp-isolation.test.ts` |
| A task worktree or the home directory gets registered | `unit` | Pure path classification. | `packages/xezar/src/workspace/projects.test.ts` |
| The user switches A→B but the URL, query or cache stays on A | `browser` | The failure is cross-layer navigation and cache behaviour; only a real browser establishes that the click, the URL, the active group and the fetched scope move together. | `packages/web/e2e/project-switching.e2e.ts` |

## What this table is not

It is not a second exhaustiveness list. The registration-suppression rule is guarded by the
unit suite above, the route-alias contract by `route-parity.test.ts`, and the one composition
across process boundaries by the saved harness — the table names where each risk is cheapest to
falsify, it does not re-implement any guard. A row's cited suite is the *guarding* suite, not
the only suite that touches the behaviour: the harness and the focused suites deliberately
overlap at the edges, and the coverage-gaps rows say which one owns each behaviour.
