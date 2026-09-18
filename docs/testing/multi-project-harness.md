# Multi-project product harness

This POSIX-only harness checks one built cockpit with two registered scratch Git repositories, one isolated `XEZ_HOME`, isolated agent homes, dry-run agents, and independent MCP owner sessions. It covers product wiring rather than duplicating parser, locking, route-matrix, or scheduler unit tests.

## Run it

1. Use Node 20+ on macOS or Linux with Git available.
2. Run `npm run build:server`.
3. Run `npm run test:multi-project`.
4. Read the printed `result.json` path; logs and `state.json` are beside it.
5. `PASSED` means every observed assertion passed; `FAILED` retains artifacts for diagnosis.
6. `BLOCKED` means a prerequisite such as the built CLI was unavailable; it is not a pass.
7. `NOT-RUN` is reserved for optional legs and is not currently emitted by this mandatory harness.
8. Pass `-- --clean` to remove artifacts after a pass.

The harness records each child PID before proceeding and tears down only those saved PIDs, escalating from `SIGTERM` to `SIGKILL` after a bounded wait. It removes `XEZ_HANDOFF_FILE`, `XEZ_TODOS_FILE`, and `XEZ_TASK_ID` from child environments. A failure retains the scratch directory.

The Worktree-OFF leg covers Xezar's deterministic dry-run launch path only. It does not reproduce issue #342's external-client configuration loading, replace the real-client acceptance suite, or cover browser project switching; those require the separately sliced follow-up tests.

## B's MCP door (#557)

B is registered through the product API, not booted, and still gets its own MCP door once its
context is built. The harness waits for B's `health` to answer as a non-error result naming B and not
A — the error text for a missing door also names B, which is how an earlier draft passed against the
bug — then checks `discover_project` and B's own `leader_events` session. After B is removed its
bridge must stop answering while A's keeps answering; after B is re-added and rebuilt, a fresh bridge
from B's folder must answer again. B's side of the cap-sharing smoke still goes through the HTTP door
the cockpit's own composer uses.

Run it with a short `TMPDIR` (for example `TMPDIR=/tmp npm run test:multi-project`) when the default
temporary directory is deep: the scratch home's socket path must fit the 104-byte local-socket limit
on macOS, and a longer one makes A's MCP unavailable and the harness fail on A.
