# Status

Maintainer-facing notes on known gaps and unfinished migrations. The standing rules stay in the
`AGENTS.md` files; this page only records how far each piece of work has got. As of 2026-10-04.

## Stopping children's programs when `serve` exits on Linux and macOS

Tracked in [#881](https://github.com/qodeca/xezar/issues/881).

On Windows, `xezar serve` stops the programs its tracked children started before it exits (see
`packages/xezar/src/AGENTS.md` § Platform layer, Processes). On Linux and macOS the exit is still
immediate: what the children started at shutdown is not stopped.

## Write sites still using a plain rename

Tracked in [#963](https://github.com/qodeca/xezar/issues/963).

New write-then-rename sites use `writeFileAtomic` / `writeFileAtomicSync`. These known exceptions
have not been migrated yet and still use a plain rename:

- `mcp/connection-file.ts`, which moves with the Windows MCP transport;
- `packages/xezar/scripts/pi-leader-extension.ts`, which moves with the pi leader on Windows.

The test scripts `packages/xezar/scripts/mock-claude.mjs` and
`packages/xezar/scripts/multi-project-harness.mjs` cannot import the platform layer, so each
carries its own short Windows retry around the rename.

`agent-config/files.ts` is not on this list: its plain `rename` is a deliberate, permanent
exception.

## Request schemas moving to `packages/contract`

Tracked in [#677](https://github.com/qodeca/xezar/issues/677).

Most request schemas have not moved yet: roughly forty are still declared in
`packages/xezar/src/server/server.ts`. The two settings routes moved first (wave 1):
`PUT /config` and `PUT /workspace/config` validate with the contract's `setConfigInputSchema` /
`setWorkspaceConfigInputSchema`, their `server.ts` copies are gone, and
`contract-parity.requests.test.ts` pins each route against its schema in both directions.
