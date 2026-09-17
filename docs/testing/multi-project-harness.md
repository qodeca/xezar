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
