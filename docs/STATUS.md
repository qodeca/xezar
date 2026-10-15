# Status

Maintainer-facing notes on known gaps and unfinished migrations. The standing rules stay in the
`AGENTS.md` files; this page only records how far each piece of work has got. As of 2026-10-14.

## Stopping children's programs when `serve` exits on Linux and macOS

A documented limit, not planned work: the owner kept it as is on 2026-10-15, because the next start already stops the leftovers. [#881](https://github.com/qodeca/xezar/issues/881) is closed.

On Windows, `xezar serve` stops the programs its tracked children started before it exits (see
`packages/xezar/src/AGENTS.md` § Platform layer, Processes). On Linux and macOS the exit is still
immediate: what the children started is not stopped at shutdown. For runs still marked `running`,
the next start stops those leftovers before the task resumes (#982).

## Write sites still using a plain rename

Tracked in [#978](https://github.com/qodeca/xezar/issues/978).

New write-then-rename sites use `writeFileAtomic` / `writeFileAtomicSync`. One known exception
has not been migrated yet and still uses a plain rename:
`packages/xezar/scripts/pi-leader-extension.ts`, which migrates when the pi leader comes to Windows (#978; the extension does not run there yet).

The test scripts `packages/xezar/scripts/mock-claude.mjs` and
`packages/xezar/scripts/multi-project-harness.mjs` cannot import the platform layer, so each
carries its own short Windows retry around the rename.

`agent-config/files.ts` is not on this list: its plain `rename` is a deliberate, permanent
exception.

## Request schemas moving to `packages/contract`

[#677](https://github.com/qodeca/xezar/issues/677) closed after wave 1; the remaining schemas have
no issue yet.

Most request schemas have not moved yet: roughly forty are still declared in
`packages/xezar/src/server/server.ts`. The two settings routes moved first (wave 1):
`PUT /config` and `PUT /workspace/config` validate with the contract's `setConfigInputSchema` /
`setWorkspaceConfigInputSchema`, their `server.ts` copies are gone, and
`contract-parity.requests.test.ts` pins each route against its schema in both directions.
