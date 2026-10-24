# Status

Maintainer-facing notes on known gaps and unfinished migrations. The standing rules stay in the
`AGENTS.md` files; this page only records how far each piece of work has got. As of 2026-10-23.

## The nightly mutation run is not reliably green yet

[#443](https://github.com/qodeca/xezar/issues/443), the tracking issue for the nightly mutation
gate (`.github/workflows/mutation.yml`), is still open. #1123 re-planned the jobs and added the read-only lock
scope on 2026-10-20; since then the runs on 2026-10-21 and 2026-10-22 passed, and the runs on
2026-10-20 and 2026-10-23 failed.
Read the latest run or #443 for the current state before relying on a score.

## Stopping children's programs when `serve` exits on Linux and macOS

A documented limit, not planned work: the owner kept it as is on 2026-10-15, because the next start already stops the leftovers. [#881](https://github.com/qodeca/xezar/issues/881) is closed.

On Windows, `xezar serve` stops the programs its tracked children started before it exits (see
`packages/xezar/src/AGENTS.md` § Platform layer, Processes). On Linux and macOS the exit is still
immediate: what the children started is not stopped at shutdown. For runs still marked `running`,
the next start stops those leftovers before the task resumes (#982).

## A Qwen Code leader on Windows gets no pushed events

A documented limit of Qwen Code, not xezar work: the owner decided on 2026-10-17 that a Windows Qwen
Code leader is pull-only since 0.30.0 ([#1086](https://github.com/qodeca/xezar/issues/1086)).

Qwen Code 0.25.2 opens no cross-session inbox on Windows, so its xezar bridge has nothing to push to.
The leader reads with `leader_events` `read` and acknowledges with `ack`, and the
`qwen-inbox-unavailable` blocker says so (`qwenInboxUnavailable` in
`packages/xezar/src/mcp/leader-delivery.ts`). Linux and macOS keep the push. Recheck when a newer Qwen
Code opens a named-pipe inbox on Windows.

## Write sites still using a plain rename

New write-then-rename sites use `writeFileAtomic` / `writeFileAtomicSync`. The last product
exception, a leader extension script, was deleted with its backend (#1046).

The test scripts `packages/xezar/scripts/mock-claude.mjs` and
`packages/xezar/scripts/multi-project-harness.mjs` cannot import the platform layer, so each
carries its own short Windows retry around the rename.

`packages/xezar/scripts/mock-qwen.mjs` writes its mock verdict packet with a plain
`renameSync` and no Windows retry. It ships in the npm package (it is the `XEZ_DRY_RUN` stand-in
for Qwen Code), so unlike the two above it reaches users. The write is best effort: a failure is
swallowed, not reported.

`agent-config/files.ts` is not on this list: its plain `rename` is a deliberate, permanent
exception.

## Request schemas moving to `packages/contract`

[#677](https://github.com/qodeca/xezar/issues/677) closed after wave 1; the remaining waves are
tracked in [#1177](https://github.com/qodeca/xezar/issues/1177).

About half have moved: roughly twenty routes in `packages/xezar/src/server/server.ts` validate
with a contract schema, while about thirty schemas (some named, some written inline in the
validator) are still declared there. The two settings routes moved first (wave 1):
`PUT /config` and `PUT /workspace/config` validate with the contract's `setConfigInputSchema` /
`setWorkspaceConfigInputSchema`, their `server.ts` copies are gone, and
`contract-parity.requests.test.ts` pins each route against its schema in both directions.

Wave 2 (#1177) removed the identical twins – schemas declared both in `server.ts` and in the
contract. `POST /projects/checkout`, `PUT /agent-config/:id` and `POST /automations/:id/check` now
validate with the contract's `checkoutProjectInputSchema`, `setAgentConfigInputSchema` and
`automationCheckInputSchema` (now `.strict()`, like the route). Four twins remain, each needing a
schema the contract does not have yet: the automation create and update bodies (the route uses the
bounded storage schemas in `automations/types.ts`; the contract's `expectedRevision` and `.strict()`
on update now match the route), and `POST /workflows` and `POST /runs`, whose step schema carries
Node-side rules (timeout grammar, `claudeSettings` paths) the contract types as plain strings.
